/**
 * Phase 9 / Plan 05 — MCP integration: a REAL SDK Client driving the REAL
 * startMcpServer over InMemoryTransport.createLinkedPair().
 *
 * Plans 02–04 proved the pieces in isolation; this file proves the assembled
 * protocol path — SDK wiring, Zod→JSON-schema conversion, tool dispatch,
 * result framing — so "green unit tests, dead live surface" (the Phase 8 TUI
 * lesson) cannot recur for MCP:
 *   - tools/list over the wire returns EXACTLY the two memory tools (MCP-01)
 *   - relay_memory_save → relay_memory_recall round-trips through the same
 *     SQLite store the CLI uses (MCP-02)
 *   - RELAY_MEMORY_ALLOWED_WORKDIRS holds across the protocol boundary:
 *     forbidden workdir → isError MEMORY_WORKDIR_FORBIDDEN, no leak (MCP-02)
 *
 * Tests share a single :memory: DB connection (control/tools.test.ts idiom).
 * Client + InMemoryTransport import paths were verified against the installed
 * @modelcontextprotocol/sdk@1.29.0 exports map (09-02-SUMMARY surface table).
 */

process.env['RELAY_DB_PATH'] = ':memory:';
delete process.env['RELAY_MEMORY_ALLOWED_WORKDIRS'];
delete process.env['RELAY_EMBEDDING_MODEL'];

import { describe, test, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startMcpServer } from './server.js';
import type { McpServerHandle } from './server.js';
import { MemoryStore } from '../memory/memory-store.js';
import { getDb } from '../runtime/store/db.js';

const TEST_VERSION = '0.0.0-integration-test';
const WORKDIR = '/tmp/relay-mcp-integration/project-a';
const ALLOWED_ONLY = '/tmp/relay-mcp-integration/the-only-allowed';

interface Connected {
  readonly client: Client;
  readonly handle: McpServerHandle;
}

let active: Connected | undefined;

/** Real server on one linked end, real SDK client on the other. */
async function connect(): Promise<Connected> {
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  const handle = await startMcpServer({ version: TEST_VERSION, transport: serverEnd });
  const client = new Client({ name: 'relay-integration-test', version: '1.0.0' });
  await client.connect(clientEnd);
  active = { client, handle };
  return active;
}

/** Fail loud instead of hanging the runner if a promise never settles. */
async function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${ms}ms waiting for ${label}`)),
          ms
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Extract the first text block of a tool result, asserting the MCP shape.
 * Takes `unknown` because callTool's return is a union with the legacy
 * compatibility shape ({toolResult}) that shares no keys with CallToolResult.
 */
function textOf(result: unknown): string {
  const content = (result as { content?: unknown }).content as
    | ReadonlyArray<{ type: string; text?: string }>
    | undefined;
  assert.ok(content && content.length > 0, 'tool result must carry content');
  const first = content[0];
  assert.strictEqual(first.type, 'text');
  assert.strictEqual(typeof first.text, 'string');
  return first.text as string;
}

afterEach(async () => {
  // Forbidden-workdir test sets the allow-list; never let it leak forward.
  delete process.env['RELAY_MEMORY_ALLOWED_WORKDIRS'];
  if (active) {
    const { client, handle } = active;
    active = undefined;
    try {
      await client.close();
    } catch {
      // The test already disconnected — teardown stays idempotent.
    }
    await handle.shutdown();
  }
});

describe('MCP integration — real SDK client ↔ real server', () => {
  test('tools/list over the wire returns exactly the two memory tools (Test 1)', async () => {
    const { client, handle } = await connect();

    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    assert.deepStrictEqual(names, ['relay_memory_recall', 'relay_memory_save']);

    // The registrations are client-usable: a description plus a JSON-schema
    // object — proof the Zod inputSchema converted at the protocol boundary.
    for (const tool of listed.tools) {
      assert.ok((tool.description ?? '').length > 0, `${tool.name} ships a description`);
      assert.strictEqual(tool.inputSchema.type, 'object');
    }

    // Clean teardown: a client disconnect must resolve the server handle's
    // `closed` (09-04 contract) so the process can exit on a dead connection.
    await client.close();
    await within(handle.closed, 2000, 'handle.closed after client disconnect');
  });

  test('save → recall round-trips over the wire through the shared store (Test 2)', async () => {
    const { client } = await connect();

    const saved = await client.callTool({
      name: 'relay_memory_save',
      arguments: {
        content: 'zephyr lattice integration proof saved over the MCP wire nonce-41ad',
        memory_type: 'decision',
        workdir: WORKDIR,
      },
    });
    assert.notStrictEqual(saved.isError, true, `save failed: ${textOf(saved)}`);
    const savedPayload = JSON.parse(textOf(saved)) as { memory_id: string };
    assert.ok(savedPayload.memory_id.length > 0, 'save must return the new memory_id');

    // Same SQLite store the CLI uses, carrying the MCP provenance tag.
    const row = getDb()
      .prepare('SELECT memory_source, workdir FROM memories WHERE memory_id = ?')
      .get(savedPayload.memory_id) as { memory_source: string; workdir: string } | undefined;
    assert.ok(row, 'the wire save must land in the shared store');
    assert.strictEqual(row.memory_source, 'worker-mcp');
    assert.strictEqual(row.workdir, WORKDIR);

    const recalled = await client.callTool({
      name: 'relay_memory_recall',
      arguments: { token_budget: 2000, query: 'zephyr lattice', workdir: WORKDIR },
    });
    assert.notStrictEqual(recalled.isError, true, `recall failed: ${textOf(recalled)}`);
    const recallPayload = JSON.parse(textOf(recalled)) as {
      memories: Array<{ content: string }>;
    };
    assert.ok(
      recallPayload.memories.some((m) => m.content.includes('zephyr lattice integration proof')),
      `the wire-saved memory must come back over the wire: ${textOf(recalled)}`
    );
  });

  test('forbidden workdir → isError MEMORY_WORKDIR_FORBIDDEN over the wire (Test 3)', async () => {
    // Seed a canary while the allow-list is unset, then close the gate: the
    // recall for WORKDIR must surface the coded error — never the canary.
    const store = new MemoryStore();
    store.remember({
      content: 'canary memory that must never cross the MCP wire from a forbidden workdir',
      memory_type: 'fact',
      workdir: WORKDIR,
    });
    process.env['RELAY_MEMORY_ALLOWED_WORKDIRS'] = ALLOWED_ONLY;

    const { client } = await connect();
    const result = await client.callTool({
      name: 'relay_memory_recall',
      arguments: { token_budget: 2000, workdir: WORKDIR },
    });

    assert.strictEqual(result.isError, true, 'the workdir gate must hold over the wire');
    const text = textOf(result);
    const parsed = JSON.parse(text) as { ok: boolean; code: string };
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.code, 'MEMORY_WORKDIR_FORBIDDEN');
    assert.ok(
      !text.includes('canary memory'),
      'a forbidden workdir must not leak memory content over the wire'
    );
  });
});
