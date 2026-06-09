/**
 * Phase 9 / Plan 03 — MCP memory tools: relay_memory_recall + relay_memory_save.
 *
 * The tools are THIN wrappers over the existing handlers (handleRecall /
 * handleRemember) — these tests prove the wrapper contract, not the engine:
 *   - store-backed results (shared :memory: DB via the getDb() singleton)
 *   - inputSchema IS the contracts Zod object (same-object identity, MCP-03)
 *   - workdir scoping inherited from MemoryStore.assertWorkdirAllowed
 *     (MCP-02, T-09-08): forbidden workdir → isError MEMORY_WORKDIR_FORBIDDEN,
 *     never another project's memory
 *   - boundary redaction (MCP-04, T-09-09): the handlers do NOT redact; the
 *     MCP wrapper must — on success AND error paths.
 *
 * Tests share a single :memory: DB connection (control/tools.test.ts idiom).
 * Distinct content strings + per-concern workdirs avoid the store's 60s
 * content-hash dedup and cross-test bleed.
 */

process.env['RELAY_DB_PATH'] = ':memory:';
delete process.env['RELAY_MEMORY_ALLOWED_WORKDIRS'];
delete process.env['RELAY_EMBEDDING_MODEL'];

import { describe, test, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildMemoryMcpTools } from './tools-memory.js';
import { RecallArgsSchema } from '../contracts/memory.js';
import { MemoryStore } from '../memory/memory-store.js';
import { getDb } from '../runtime/store/db.js';

// Secret-shaped fixtures built at runtime from string parts (result.test.ts
// idiom) — no literal credential-looking value sits in source.
const figmaSecret = (): string => ['figd', 'AAAA1111BBBB2222cccc'].join('_');

const WORKDIR = '/tmp/relay-mcp-tools-test/project-a';
const SECRET_WORKDIR = '/tmp/relay-mcp-tools-test/secret-project';
const ALLOWED_ONLY = '/tmp/relay-mcp-tools-test/the-only-allowed';

afterEach(() => {
  // Forbidden-workdir tests set the allow-list; never let it leak forward.
  delete process.env['RELAY_MEMORY_ALLOWED_WORKDIRS'];
});

describe('relay_memory_recall', () => {
  test('returns store-backed memories for the workdir within the token budget (Test 1)', async () => {
    const store = new MemoryStore();
    store.remember({
      content: 'quasar alignment heuristics guide relay dispatch routing',
      memory_type: 'fact',
      tags: ['mcp-recall-test'],
      workdir: WORKDIR,
    });

    const [recall] = buildMemoryMcpTools();
    const result = await recall.handler(
      RecallArgsSchema.parse({ token_budget: 2000, query: 'quasar alignment', workdir: WORKDIR })
    );

    assert.notStrictEqual(result.isError, true);
    const text = result.content[0].text;
    const parsed = JSON.parse(text) as {
      memories: Array<{ content: string; memory_type: string }>;
      total_tokens: number;
      budget_remaining: number;
      omitted_count: number;
      candidate_count: number;
    };
    assert.ok(
      parsed.memories.some(m => m.content.includes('quasar alignment heuristics')),
      `expected the seeded memory in: ${text}`
    );
    assert.strictEqual(typeof parsed.total_tokens, 'number');
    assert.strictEqual(typeof parsed.budget_remaining, 'number');
  });

  test('inputSchema IS RecallArgsSchema from contracts/memory.ts — same object (Test 2)', () => {
    const [recall] = buildMemoryMcpTools();
    assert.strictEqual(recall.name, 'relay_memory_recall');
    assert.strictEqual(recall.config.inputSchema, RecallArgsSchema);
  });

  test('forbidden workdir → isError MEMORY_WORKDIR_FORBIDDEN, no cross-workdir leak (Test 3)', async () => {
    // Seed a canary in WORKDIR, then allow ONLY a different root: the request
    // for WORKDIR must surface the coded error — never the canary's content.
    const store = new MemoryStore();
    store.remember({
      content: 'canary memory that must never cross a forbidden workdir boundary',
      memory_type: 'fact',
      workdir: WORKDIR,
    });
    process.env['RELAY_MEMORY_ALLOWED_WORKDIRS'] = ALLOWED_ONLY;

    const [recall] = buildMemoryMcpTools();
    const result = await recall.handler(
      RecallArgsSchema.parse({ token_budget: 2000, workdir: WORKDIR })
    );

    assert.strictEqual(result.isError, true);
    const parsed = JSON.parse(result.content[0].text) as { ok: boolean; code: string };
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.code, 'MEMORY_WORKDIR_FORBIDDEN');
    assert.ok(
      !result.content[0].text.includes('canary memory'),
      'a forbidden workdir must not leak memory content'
    );
  });

  test('secret-shaped memory content is redacted at the MCP boundary (Test 4)', async () => {
    // The store redacts on SAVE, so a secret written today never reaches disk
    // raw. The boundary threat (T-09-09) is rows the save-side patterns missed
    // — e.g. rows written before a redaction pattern existed. Simulate one by
    // updating the row UNDER the store's sanitizer, then prove the WRAPPER
    // redacts on the way out (handleRecall itself does not redact).
    const secret = figmaSecret();
    const store = new MemoryStore();
    const id = store.remember({
      content: 'placeholder row for boundary redaction proof',
      memory_type: 'fact',
      workdir: SECRET_WORKDIR,
    });
    getDb()
      .prepare('UPDATE memories SET content = ? WHERE memory_id = ?')
      .run(`legacy row carrying token ${secret} in plain text`, id);

    const [recall] = buildMemoryMcpTools();
    const result = await recall.handler(
      RecallArgsSchema.parse({ token_budget: 2000, workdir: SECRET_WORKDIR })
    );

    assert.notStrictEqual(result.isError, true);
    const text = result.content[0].text;
    assert.ok(!text.includes(secret), 'raw secret must not cross the MCP boundary');
    assert.ok(text.includes('[REDACTED:FIGMA_PAT]'), `expected placeholder in: ${text}`);
  });
});
