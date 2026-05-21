/**
 * PLAN-4 T2 — Lazy embed-on-write via queueMicrotask.
 *
 * After sync INSERT in remember() / upsert(), the store schedules a
 * queueMicrotask that calls embedClient (injected for tests; defaults to
 * embedDocument). The microtask UPDATEs the row with the 768-dim BLOB +
 * model id. Failures NEVER throw and NEVER block the sync write.
 *
 * Key invariants asserted:
 *   - remember() returns sync (Date.now() before == Date.now() after, modulo
 *     a millisecond) with NULL embedding_blob initially.
 *   - One microtask tick later: success path → BLOB + model populated;
 *     failure path → row stays NULL + one stderr warning (deduped per reason).
 *   - With RELAY_EMBEDDING_MODEL unset → zero embed calls + zero warnings.
 *   - Existing 60s content_hash dedup STILL works (regression guard).
 *   - upsert() follows the same lazy path.
 */

process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { MemoryStore } from './memory-store.js';
import { closeDb } from '../runtime/store/db.js';
import type { EmbeddingResult, EmbedOptions } from './embedding-client.js';

const NOMIC = 'text-embedding-nomic-embed-text-v1.5';

/** Run all pending microtasks (one tick is enough for queueMicrotask). */
async function flushMicrotasks(): Promise<void> {
  // queueMicrotask schedules into the same microtask queue. A single
  // `await Promise.resolve()` flushes the entire queue including chained
  // .then() callbacks the embedClient mock resolves with.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** Capture stderr output during a block, restoring the real stderr after. */
function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  // Cast through unknown — we only need write(string) — overload soup.
  (process.stderr.write as unknown as (chunk: string) => boolean) = ((chunk: string) => {
    lines.push(String(chunk));
    return true;
  }) as unknown as typeof process.stderr.write;
  return {
    lines,
    restore: () => {
      (process.stderr.write as unknown as (chunk: string) => boolean) = original as unknown as (
        chunk: string
      ) => boolean;
    },
  };
}

/** Build a 768-dim Float32Array fixture (all zeros — content does not matter
 *  for the round-trip, only the byte length and embedding_model presence). */
function makeFloat32Fixture(): Float32Array {
  return new Float32Array(768);
}

interface MockEmbed {
  fn: (text: string, opts: EmbedOptions) => Promise<EmbeddingResult>;
  calls: Array<{ text: string; opts: EmbedOptions }>;
}

function makeMockEmbed(result: EmbeddingResult | (() => EmbeddingResult)): MockEmbed {
  const calls: MockEmbed['calls'] = [];
  return {
    calls,
    fn: async (text, opts) => {
      calls.push({ text, opts });
      return typeof result === 'function' ? result() : result;
    },
  };
}

describe('MemoryStore — lazy embed-on-write (PLAN-4 T2)', () => {
  let savedModel: string | undefined;
  let savedEndpoint: string | undefined;

  beforeEach(() => {
    savedModel = process.env['RELAY_EMBEDDING_MODEL'];
    savedEndpoint = process.env['LMSTUDIO_ENDPOINT'];
    closeDb();
  });

  afterEach(() => {
    if (savedModel === undefined) delete process.env['RELAY_EMBEDDING_MODEL'];
    else process.env['RELAY_EMBEDDING_MODEL'] = savedModel;
    if (savedEndpoint === undefined) delete process.env['LMSTUDIO_ENDPOINT'];
    else process.env['LMSTUDIO_ENDPOINT'] = savedEndpoint;
    closeDb();
  });

  test('remember() returns sync; embedding_blob initially NULL', () => {
    delete process.env['RELAY_EMBEDDING_MODEL'];
    const store = new MemoryStore();

    const id = store.remember({ content: 'sync write', memory_type: 'fact' });
    assert.ok(id, 'remember returns id string');

    // Direct DB peek — no microtask flush yet
    const row = store.getRawEmbedding(id);
    assert.strictEqual(row?.blob, null);
    assert.strictEqual(row?.model, null);
  });

  test('with mock success + RELAY_EMBEDDING_MODEL set: after microtask flush, blob + model populated', async () => {
    process.env['RELAY_EMBEDDING_MODEL'] = NOMIC;
    const vec = makeFloat32Fixture();
    const mock = makeMockEmbed({ ok: true, vector: vec });

    const store = new MemoryStore({ embedClient: mock.fn });
    const id = store.remember({ content: 'embed me', memory_type: 'fact' });

    await flushMicrotasks();

    const row = store.getRawEmbedding(id);
    assert.ok(row);
    assert.ok(row.blob, 'blob populated');
    assert.strictEqual(row.blob.length, 3072, '768 × 4 = 3072 bytes');
    assert.strictEqual(row.model, NOMIC);
    assert.strictEqual(mock.calls.length, 1, 'embedClient called exactly once');
    assert.strictEqual(mock.calls[0]!.text, 'embed me');
    assert.strictEqual(mock.calls[0]!.opts.model, NOMIC);
  });

  test('with mock failure: row stays NULL, no throw, exactly one stderr line per reason (deduped)', async () => {
    process.env['RELAY_EMBEDDING_MODEL'] = NOMIC;
    const mock = makeMockEmbed({ ok: false, reason: 'unreachable' });

    const store = new MemoryStore({ embedClient: mock.fn });
    const stderr = captureStderr();
    try {
      // Write two memories that both fail — should produce ONE warning total.
      const id1 = store.remember({ content: 'fail1', memory_type: 'fact' });
      const id2 = store.remember({ content: 'fail2', memory_type: 'fact' });
      await flushMicrotasks();

      const r1 = store.getRawEmbedding(id1);
      const r2 = store.getRawEmbedding(id2);
      assert.strictEqual(r1?.blob, null, 'failed embed → blob NULL');
      assert.strictEqual(r2?.blob, null, 'failed embed → blob NULL');
      assert.strictEqual(r1?.model, null);
    } finally {
      stderr.restore();
    }

    const warnings = stderr.lines.filter((l) => l.includes('RELAY: embedding skipped'));
    assert.strictEqual(
      warnings.length,
      1,
      `expected 1 deduped warning per reason, got ${warnings.length}: ${warnings.join('|')}`
    );
    assert.ok(
      warnings[0]!.includes('unreachable'),
      'warning carries the failure reason'
    );
    assert.ok(
      warnings[0]!.includes("Run 'relay doctor'"),
      'warning carries the relay doctor pointer'
    );
  });

  test('with RELAY_EMBEDDING_MODEL unset: ZERO embed calls, ZERO warnings, blob NULL', async () => {
    delete process.env['RELAY_EMBEDDING_MODEL'];
    const mock = makeMockEmbed({ ok: true, vector: makeFloat32Fixture() });

    const store = new MemoryStore({ embedClient: mock.fn });
    const stderr = captureStderr();
    let id: string;
    try {
      id = store.remember({ content: 'feature off', memory_type: 'fact' });
      await flushMicrotasks();
    } finally {
      stderr.restore();
    }

    assert.strictEqual(mock.calls.length, 0, 'embedClient NOT called when model unset');
    const row = store.getRawEmbedding(id);
    assert.strictEqual(row?.blob, null);
    assert.strictEqual(
      stderr.lines.filter((l) => l.includes('RELAY:')).length,
      0,
      'no warnings when feature is off'
    );
  });

  test('60-second content_hash dedup still works (regression: dedup short-circuits before embed)', async () => {
    process.env['RELAY_EMBEDDING_MODEL'] = NOMIC;
    const mock = makeMockEmbed({ ok: true, vector: makeFloat32Fixture() });

    const store = new MemoryStore({ embedClient: mock.fn });
    const id1 = store.remember({ content: 'duplicate content', memory_type: 'fact' });
    const id2 = store.remember({ content: 'duplicate content', memory_type: 'fact' });

    assert.strictEqual(id1, id2, 'dedup returns the same id within 60s');
    await flushMicrotasks();

    // Only ONE embed call — the second write hits the dedup branch and never
    // reaches the queueMicrotask scheduling at the end of remember().
    assert.strictEqual(mock.calls.length, 1, 'deduped write does not re-embed');
  });

  test('upsert() also schedules lazy embed after sync INSERT', async () => {
    process.env['RELAY_EMBEDDING_MODEL'] = NOMIC;
    const mock = makeMockEmbed({ ok: true, vector: makeFloat32Fixture() });

    const store = new MemoryStore({ embedClient: mock.fn });
    const id = store.upsert({
      entity_key: 'css-naming',
      content: 'prefer kebab-case for css classes',
      memory_type: 'lesson',
    });

    await flushMicrotasks();

    const row = store.getRawEmbedding(id);
    assert.ok(row?.blob, 'upsert blob populated');
    assert.strictEqual(row?.blob.length, 3072);
    assert.strictEqual(row?.model, NOMIC);
    assert.strictEqual(mock.calls.length, 1);
  });

  test('LMSTUDIO_ENDPOINT non-local → embed NOT called, blob NULL, one stderr warning', async () => {
    process.env['RELAY_EMBEDDING_MODEL'] = NOMIC;
    process.env['LMSTUDIO_ENDPOINT'] = 'https://attacker.example.com';
    const mock = makeMockEmbed({ ok: true, vector: makeFloat32Fixture() });

    const store = new MemoryStore({ embedClient: mock.fn });
    const stderr = captureStderr();
    let id: string;
    try {
      id = store.remember({ content: 'must not leak', memory_type: 'fact' });
      await flushMicrotasks();
    } finally {
      stderr.restore();
    }

    assert.strictEqual(mock.calls.length, 0, 'embed client never invoked when endpoint is non-local');
    const row = store.getRawEmbedding(id);
    assert.strictEqual(row?.blob, null, 'row stays NULL when locality gate trips');
    assert.strictEqual(row?.model, null);
    const warnings = stderr.lines.filter((l) => l.includes('RELAY: embedding skipped'));
    assert.strictEqual(warnings.length, 1, `expected exactly one deduped warning, got ${warnings.length}`);
    assert.ok(
      warnings[0]!.includes('non-local-endpoint'),
      `warning should name the locality reason, got: ${warnings[0]}`
    );
  });

  test('model captured at call site: env change between INSERT and microtask flush does not affect recorded model', async () => {
    const ORIGINAL_MODEL = NOMIC;
    const SWAPPED_MODEL = 'some-other-embed-model-v2';
    process.env['RELAY_EMBEDDING_MODEL'] = ORIGINAL_MODEL;
    const mock = makeMockEmbed({ ok: true, vector: makeFloat32Fixture() });

    const store = new MemoryStore({ embedClient: mock.fn });
    const id = store.remember({ content: 'capture me', memory_type: 'fact' });
    // Simulate concurrent caller swapping the model AFTER the sync INSERT
    // returns but BEFORE the microtask fires — without call-site capture the
    // microtask would read SWAPPED_MODEL and record the wrong vector-space
    // tag on the row.
    process.env['RELAY_EMBEDDING_MODEL'] = SWAPPED_MODEL;
    await flushMicrotasks();

    const row = store.getRawEmbedding(id);
    assert.ok(row?.blob, 'blob populated');
    assert.strictEqual(
      row?.model,
      ORIGINAL_MODEL,
      'recorded model must match the model captured at scheduleEmbed call site, not the post-swap env value'
    );
    assert.strictEqual(mock.calls.length, 1);
    assert.strictEqual(
      mock.calls[0]!.opts.model,
      ORIGINAL_MODEL,
      'embed client called with the captured model, not the swapped one'
    );
  });

  test('embedClient throwing inside the promise is swallowed (never crashes process)', async () => {
    process.env['RELAY_EMBEDDING_MODEL'] = NOMIC;
    const mock: MockEmbed = {
      calls: [],
      fn: async (text, opts) => {
        mock.calls.push({ text, opts });
        throw new Error('synthetic embed crash');
      },
    };

    const store = new MemoryStore({ embedClient: mock.fn });
    const stderr = captureStderr();
    let id: string;
    try {
      id = store.remember({ content: 'crash test', memory_type: 'fact' });
      await flushMicrotasks();
    } finally {
      stderr.restore();
    }

    const row = store.getRawEmbedding(id);
    assert.strictEqual(row?.blob, null, 'crashed embed → blob NULL');
    assert.strictEqual(row?.model, null);
    // No assertion on stderr — crash path is allowed to surface but MUST NOT throw.
  });
});
