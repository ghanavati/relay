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
import { RecallArgsSchema, RememberArgsSchema } from '../contracts/memory.js';
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

describe('relay_memory_save', () => {
  test('persists through the same SQLite store with the worker-mcp source (Test 1)', async () => {
    const [, save] = buildMemoryMcpTools();
    const result = await save.handler(
      RememberArgsSchema.parse({
        content: 'relay mcp save persistence proof nonce-7f3a',
        memory_type: 'decision',
        workdir: WORKDIR,
      })
    );

    assert.notStrictEqual(result.isError, true);
    const parsed = JSON.parse(result.content[0].text) as {
      memory_id: string;
      memory_type: string;
      store_stats: { total_memories: number; total_tokens: number };
    };
    assert.ok(parsed.memory_id.length > 0, 'save must return the new memory_id');
    assert.strictEqual(parsed.memory_type, 'decision');

    // Same SQLite store the CLI uses: read the row back through the shared
    // getDb() connection, and pin the MCP provenance + trust contract.
    const row = getDb()
      .prepare(
        'SELECT content, memory_source, trust_level, workdir FROM memories WHERE memory_id = ?'
      )
      .get(parsed.memory_id) as
      | { content: string; memory_source: string; trust_level: string; workdir: string }
      | undefined;
    assert.ok(row, 'saved row must exist in the shared store');
    assert.ok(row.content.includes('nonce-7f3a'));
    assert.strictEqual(row.workdir, WORKDIR);
    // Pins MCP_MEMORY_SOURCE's literal value: no MCP-specific MemorySource
    // exists, so saves carry the closest worker-mcp tag — and the trust model
    // keeps non-human sources unverified-by-default.
    assert.strictEqual(row.memory_source, 'worker-mcp');
    assert.strictEqual(row.trust_level, 'unverified');
  });

  test('inputSchema IS RememberArgsSchema from contracts/memory.ts — same object (Test 2)', () => {
    const [, save] = buildMemoryMcpTools();
    assert.strictEqual(save.name, 'relay_memory_save');
    assert.strictEqual(save.config.inputSchema, RememberArgsSchema);
  });

  test('forbidden workdir → isError MEMORY_WORKDIR_FORBIDDEN, write rejected (Test 3)', async () => {
    process.env['RELAY_MEMORY_ALLOWED_WORKDIRS'] = ALLOWED_ONLY;
    const countBefore = (
      getDb().prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }
    ).n;

    const [, save] = buildMemoryMcpTools();
    const result = await save.handler(
      RememberArgsSchema.parse({
        content: 'this write must be rejected by the workdir gate',
        memory_type: 'fact',
        workdir: WORKDIR,
      })
    );

    assert.strictEqual(result.isError, true);
    const parsed = JSON.parse(result.content[0].text) as { ok: boolean; code: string };
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.code, 'MEMORY_WORKDIR_FORBIDDEN');

    const countAfter = (
      getDb().prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }
    ).n;
    assert.strictEqual(countAfter, countBefore, 'a forbidden save must not insert a row');
  });

  test('success result is redacted at the MCP boundary (Test 4)', async () => {
    // handleRemember echoes args.tags into its response — a secret-shaped tag
    // is the input field that round-trips into the success envelope, proving
    // the wrapper redacts the SUCCESS path (the handler itself does not).
    const secret = figmaSecret();
    const [, save] = buildMemoryMcpTools();
    const result = await save.handler(
      RememberArgsSchema.parse({
        content: 'memory whose tag carries a secret-shaped token nonce-9c1d',
        memory_type: 'fact',
        tags: [secret],
        workdir: WORKDIR,
      })
    );

    assert.notStrictEqual(result.isError, true);
    const text = result.content[0].text;
    assert.ok(!text.includes(secret), 'raw secret must not cross the MCP boundary');
    assert.ok(text.includes('[REDACTED:FIGMA_PAT]'), `expected placeholder in: ${text}`);
  });
});

describe('buildMemoryMcpTools surface', () => {
  test('exposes exactly relay_memory_recall and relay_memory_save, in order (Test 5)', () => {
    const tools = buildMemoryMcpTools();
    assert.strictEqual(tools.length, 2);
    assert.deepStrictEqual(
      tools.map(t => t.name),
      ['relay_memory_recall', 'relay_memory_save']
    );
    // The killed scope stays killed: no control tools, no dispatch tool,
    // no shell surface — and every registration is client-ready.
    for (const tool of tools) {
      assert.strictEqual(typeof tool.handler, 'function');
      assert.ok(tool.config.description.length > 0, `${tool.name} needs a description`);
    }
  });
});
