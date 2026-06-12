/**
 * Phase 9 (REQ-MCP-01/02/03/05) — in-process MCP server tests.
 *
 * Client and server run over InMemoryTransport in this process, so the
 * in-memory SQLite store is shared and assertable. Protocol-level e2e
 * against the real binary lives in src/cli/cmd-mcp-e2e.test.ts.
 */
process.env['RELAY_DB_PATH'] = ':memory:';
delete process.env['RELAY_MCP_DEFAULT_WORKDIR'];
delete process.env['RELAY_MEMORY_ALLOWED_WORKDIRS'];

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer, MCP_TOOL_NAMES } from './server.js';
import { MemoryStore } from '../memory/memory-store.js';

type TextResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function connectedClient(): Promise<Client> {
  const server = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'relay-mcp-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

function parseText(result: unknown): Record<string, unknown> {
  const r = result as TextResult;
  assert.ok(Array.isArray(r.content) && r.content[0]?.type === 'text', 'expected text content');
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

describe('mcp server surface (REQ-MCP-01/02)', () => {
  test('tools/list exposes exactly the relay_ tool set', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name).sort();
    assert.deepEqual(names, [...MCP_TOOL_NAMES].sort());
    assert.ok(names.every(n => n.startsWith('relay_')), 'D-04: relay_ prefix on every tool');
    await client.close();
  });

  test('prompts/list exposes relay-context', async () => {
    const client = await connectedClient();
    const { prompts } = await client.listPrompts();
    assert.ok(prompts.some(p => p.name === 'relay-context'));
    await client.close();
  });
});

describe('mcp write path (REQ-MCP-03)', () => {
  test('relay_remember writes worker-mcp source at unverified trust, never pinned', async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: 'relay_remember',
      arguments: {
        content: 'phase9 quarantine probe — written via MCP',
        memory_type: 'lesson',
        workdir: '/tmp/phase9-proj',
        // Hostile extras: schema must drop these, not honor them.
        pinned: true,
        source_run_id: 'forged-run-id',
      },
    });
    const payload = parseText(result);
    const memoryId = payload['memory_id'] as string;
    assert.ok(memoryId, 'remember returns memory_id');

    const store = new MemoryStore();
    const row = store.getMemory(memoryId);
    assert.ok(row, 'row persisted');
    assert.equal(row!.memory_source, 'worker-mcp');
    assert.equal(row!.trust_level, 'unverified');
    assert.equal(row!.pinned, false, 'pinned must be stripped — pinning jumps quarantine');
    assert.equal(row!.source_run_id, null, 'source_run_id must be stripped');
    await client.close();
  });

  test("relay_remember rejects '*' workdir", async () => {
    const client = await connectedClient();
    const result = (await client.callTool({
      name: 'relay_remember',
      arguments: { content: 'x'.repeat(10), memory_type: 'fact', workdir: '*' },
    })) as TextResult;
    assert.equal(result.isError, true);
    await client.close();
  });

  test('relay_remember without workdir and without env refuses', async () => {
    const client = await connectedClient();
    const result = (await client.callTool({
      name: 'relay_remember',
      arguments: { content: 'no workdir provided here', memory_type: 'fact' },
    })) as TextResult;
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /workdir required/i);
    await client.close();
  });
});

describe('mcp quarantine at recall (REQ-MCP-05)', () => {
  test('default recall excludes unverified MCP writes; explicit min_trust=unverified includes them', async () => {
    const client = await connectedClient();
    const marker = `quarantine-recall-${Date.now()}`;
    await client.callTool({
      name: 'relay_remember',
      arguments: { content: `${marker} lesson body`, memory_type: 'lesson', workdir: '/tmp/phase9-q' },
    });

    const defaulted = parseText(await client.callTool({
      name: 'relay_recall',
      arguments: { query: marker, workdir: '/tmp/phase9-q' },
    }));
    const defaultedHits = (defaulted['memories'] as Array<{ content: string }>).filter(
      m => m.content.includes(marker)
    );
    assert.equal(defaultedHits.length, 0, 'provisional floor must hide unverified MCP writes');

    const opened = parseText(await client.callTool({
      name: 'relay_recall',
      arguments: { query: marker, workdir: '/tmp/phase9-q', min_trust: 'unverified' },
    }));
    const openedHits = (opened['memories'] as Array<{ content: string }>).filter(
      m => m.content.includes(marker)
    );
    assert.equal(openedHits.length, 1, 'explicit unverified opt-in surfaces the write');
    await client.close();
  });

  test('relay_recall without workdir refuses instead of going global', async () => {
    const client = await connectedClient();
    const result = (await client.callTool({
      name: 'relay_recall',
      arguments: { query: 'anything' },
    })) as TextResult;
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /workdir required/i);
    await client.close();
  });

  test('RELAY_MCP_DEFAULT_WORKDIR fallback applies', async () => {
    process.env['RELAY_MCP_DEFAULT_WORKDIR'] = '/tmp/phase9-env';
    try {
      const client = await connectedClient();
      const result = (await client.callTool({
        name: 'relay_recall',
        arguments: { query: 'env fallback probe' },
      })) as TextResult;
      assert.notEqual(result.isError, true, 'env-configured workdir must satisfy the gate');
      await client.close();
    } finally {
      delete process.env['RELAY_MCP_DEFAULT_WORKDIR'];
    }
  });
});

describe('mcp read tools (REQ-MCP-02)', () => {
  test('relay_get_memory round-trips a stored memory', async () => {
    const client = await connectedClient();
    const written = parseText(await client.callTool({
      name: 'relay_remember',
      arguments: { content: 'get-memory round trip body', memory_type: 'fact', workdir: '/tmp/phase9-get' },
    }));
    const fetched = parseText(await client.callTool({
      name: 'relay_get_memory',
      arguments: { memory_id: written['memory_id'] },
    }));
    assert.equal(fetched['content'], 'get-memory round trip body');
    await client.close();
  });

  test('relay_corpus_query on missing corpus returns isError with hint', async () => {
    const client = await connectedClient();
    const result = (await client.callTool({
      name: 'relay_corpus_query',
      arguments: { name: 'no-such-corpus', query_text: 'anything' },
    })) as TextResult;
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /corpus_not_found/);
    await client.close();
  });

  test('relay_browse_runs returns a runs array on an empty store', async () => {
    const client = await connectedClient();
    const payload = parseText(await client.callTool({ name: 'relay_browse_runs', arguments: {} }));
    assert.ok(Array.isArray(payload['runs']));
    await client.close();
  });
});

describe('relay-context prompt (REQ-MCP-07)', () => {
  test('prompt resolves workdir and returns a text message', async () => {
    const client = await connectedClient();
    const result = await client.getPrompt({
      name: 'relay-context',
      arguments: { workdir: '/tmp/phase9-prompt' },
    });
    assert.ok(result.messages.length >= 1);
    const first = result.messages[0]!;
    assert.equal(first.content.type, 'text');
    await client.close();
  });

  test('prompt without workdir and without env refuses', async () => {
    const client = await connectedClient();
    await assert.rejects(
      client.getPrompt({ name: 'relay-context', arguments: {} }),
      /workdir required/i
    );
    await client.close();
  });
});
