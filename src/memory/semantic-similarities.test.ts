/**
 * PLAN-4 T5 — Tests for computeSemanticSimilarities + cosine helpers.
 *
 * The helper sits at the impure boundary: it owns embed-the-query, BLOB
 * decode, cross-model rejection, and cosine math. Engine purity (memory-
 * engine.ts) is preserved because this helper is called from CLI/MCP
 * handlers BEFORE budgetedRecall — not from inside the scorer.
 *
 * Failure paths all return an empty Map + (deduped) stderr warning — the
 * engine then falls through to word-overlap for every row.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import type { Memory, RecallQuery } from './types.js';
import type { EmbeddingResult, EmbedOptions } from './embedding-client.js';
import {
  blobToFloat32,
  cosineSimNormalized,
  computeSemanticSimilarities,
  type SemanticSimilaritiesStore,
} from './semantic-similarities.js';

const NOMIC = 'text-embedding-nomic-embed-text-v1.5';

// ─── Fixture helpers ────────────────────────────────────────────────────────

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  const now = Date.now();
  return {
    memory_id: 'm1',
    memory_type: 'fact',
    content: 'fixture content',
    tags: [],
    workdir: null,
    token_count: 4,
    pinned: false,
    source_run_id: null,
    git_ref: null,
    created_at: now,
    accessed_at: now,
    expires_at: null,
    entity_key: null,
    sources: [],
    recall_count: 0,
    memory_source: 'unknown' as const,
    success_recall_count: 0,
    files: [],
    trust_level: 'unverified' as const,
    ...overrides,
  };
}

function makeFloat32(dim = 768, fill: (i: number) => number = (_) => 0): Float32Array {
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = fill(i);
  return out;
}

function vectorToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function makeStore(entries: Record<string, { blob: Buffer; model: string }>): SemanticSimilaritiesStore {
  return {
    getRawEmbeddings(ids: readonly string[]): Map<string, { blob: Buffer; model: string }> {
      const out = new Map<string, { blob: Buffer; model: string }>();
      for (const id of ids) {
        const entry = entries[id];
        if (entry) out.set(id, entry);
      }
      return out;
    },
  };
}

function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
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

// Mock fetchImpl that returns a scripted embedding for any /v1/embeddings POST.
function makeEmbedFetchSuccess(vector: number[]): {
  fetchImpl: typeof fetch;
  calls: number;
} {
  let calls = 0;
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls++;
    void input;
    void init;
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: vector }] }),
      text: async () => '',
    } as unknown as Response;
  }) as typeof fetch;
  return {
    get calls() {
      return calls;
    },
    fetchImpl,
  } as { fetchImpl: typeof fetch; calls: number };
}

// ─── Helper purity tests (no DB / no fetch) ─────────────────────────────────

describe('blobToFloat32 + cosineSimNormalized (PLAN-4 T5 helpers)', () => {
  test('blobToFloat32 round-trips a Float32Array', () => {
    const original = new Float32Array([0.1, -0.2, 0.3, 0.5]);
    const blob = vectorToBlob(original);
    const round = blobToFloat32(blob);
    assert.strictEqual(round.length, 4);
    for (let i = 0; i < 4; i++) {
      assert.ok(Math.abs(round[i]! - original[i]!) < 1e-6, `index ${i} ${round[i]} ~= ${original[i]}`);
    }
  });

  test('cosineSimNormalized returns 1.0 for identical unit vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([1, 0, 0]);
    assert.ok(Math.abs(cosineSimNormalized(a, b) - 1.0) < 1e-6);
  });

  test('cosineSimNormalized returns 0.0 for orthogonal unit vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    assert.ok(Math.abs(cosineSimNormalized(a, b) - 0.0) < 1e-6);
  });

  test('cosineSimNormalized returns -1.0 for anti-parallel unit vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    assert.ok(Math.abs(cosineSimNormalized(a, b) - -1.0) < 1e-6);
  });

  test('cosineSimNormalized handles non-unit vectors via full normalization', () => {
    const a = new Float32Array([3, 4, 0]); // magnitude 5
    const b = new Float32Array([3, 4, 0]);
    // Both same direction → cosine = 1 regardless of magnitude
    assert.ok(Math.abs(cosineSimNormalized(a, b) - 1.0) < 1e-6);
  });

  test('cosineSimNormalized returns 0 when either input is zero-magnitude (avoids NaN)', () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 0, 0]);
    const sim = cosineSimNormalized(a, b);
    assert.ok(Number.isFinite(sim), `zero-vector cosine must be finite, got ${sim}`);
    assert.strictEqual(sim, 0);
  });
});

// ─── computeSemanticSimilarities tests ───────────────────────────────────────

describe('computeSemanticSimilarities (PLAN-4 T5)', () => {
  let savedFetch: typeof fetch | undefined;
  let savedModel: string | undefined;
  let savedEndpoint: string | undefined;

  beforeEach(() => {
    savedFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    savedModel = process.env['RELAY_EMBEDDING_MODEL'];
    savedEndpoint = process.env['LMSTUDIO_ENDPOINT'];
  });

  afterEach(() => {
    if (savedFetch) (globalThis as { fetch?: typeof fetch }).fetch = savedFetch;
    if (savedModel === undefined) delete process.env['RELAY_EMBEDDING_MODEL'];
    else process.env['RELAY_EMBEDDING_MODEL'] = savedModel;
    if (savedEndpoint === undefined) delete process.env['LMSTUDIO_ENDPOINT'];
    else process.env['LMSTUDIO_ENDPOINT'] = savedEndpoint;
  });

  test('empty query.query → empty Map, ZERO embed calls (no fetch)', async () => {
    process.env['RELAY_EMBEDDING_MODEL'] = NOMIC;
    const fetchMock = makeEmbedFetchSuccess(Array.from(makeFloat32()));
    const store = makeStore({});
    const candidates: Memory[] = [makeMemory({ memory_id: 'm1' })];
    const query: RecallQuery = { token_budget: 1000 }; // no query.query

    const result = await computeSemanticSimilarities(store, query, candidates, {
      fetchImpl: fetchMock.fetchImpl,
    });

    assert.strictEqual(result.size, 0);
    assert.strictEqual(fetchMock.calls, 0, 'no embed call for empty query');
  });

  test('RELAY_EMBEDDING_MODEL unset → empty Map, ZERO embed calls, ZERO warnings', async () => {
    delete process.env['RELAY_EMBEDDING_MODEL'];
    const fetchMock = makeEmbedFetchSuccess(Array.from(makeFloat32()));
    const store = makeStore({});
    const candidates: Memory[] = [makeMemory({ memory_id: 'm1' })];
    const query: RecallQuery = { query: 'real query', token_budget: 1000 };

    const stderr = captureStderr();
    try {
      const result = await computeSemanticSimilarities(store, query, candidates, {
        fetchImpl: fetchMock.fetchImpl,
      });
      assert.strictEqual(result.size, 0);
      assert.strictEqual(fetchMock.calls, 0);
    } finally {
      stderr.restore();
    }
    assert.strictEqual(
      stderr.lines.filter((l) => l.includes('RELAY')).length,
      0,
      'no warning when feature off'
    );
  });

  test('success path: returns Map sized to non-null/matching candidates', async () => {
    process.env['RELAY_EMBEDDING_MODEL'] = NOMIC;
    const queryVec = makeFloat32(768, (i) => (i === 0 ? 1 : 0));
    const docVec = makeFloat32(768, (i) => (i === 0 ? 1 : 0)); // identical → cosine 1
    const fetchMock = makeEmbedFetchSuccess(Array.from(queryVec));

    const store = makeStore({
      m1: { blob: vectorToBlob(docVec), model: NOMIC },
      m2: { blob: vectorToBlob(docVec), model: NOMIC },
    });
    const candidates: Memory[] = [
      makeMemory({ memory_id: 'm1' }),
      makeMemory({ memory_id: 'm2' }),
    ];

    const result = await computeSemanticSimilarities(
      store,
      { query: 'whatever', token_budget: 1000 },
      candidates,
      { fetchImpl: fetchMock.fetchImpl }
    );

    assert.strictEqual(result.size, 2);
    assert.ok(Math.abs(result.get('m1')! - 1.0) < 1e-6);
    assert.ok(Math.abs(result.get('m2')! - 1.0) < 1e-6);
  });

  test('mixed corpus: 3 valid + 2 NULL-blob → Map has exactly 3 entries', async () => {
    process.env['RELAY_EMBEDDING_MODEL'] = NOMIC;
    const queryVec = Array.from(makeFloat32(768, (i) => (i === 0 ? 1 : 0)));
    const fetchMock = makeEmbedFetchSuccess(queryVec);
    const docVec = makeFloat32(768, (i) => (i === 0 ? 1 : 0));

    const store = makeStore({
      m1: { blob: vectorToBlob(docVec), model: NOMIC },
      m2: { blob: vectorToBlob(docVec), model: NOMIC },
      m3: { blob: vectorToBlob(docVec), model: NOMIC },
      // m4, m5 absent — store reports NULL blob/model
    });
    const candidates = [
      makeMemory({ memory_id: 'm1' }),
      makeMemory({ memory_id: 'm2' }),
      makeMemory({ memory_id: 'm3' }),
      makeMemory({ memory_id: 'm4' }),
      makeMemory({ memory_id: 'm5' }),
    ];

    const result = await computeSemanticSimilarities(
      store,
      { query: 'q', token_budget: 1000 },
      candidates,
      { fetchImpl: fetchMock.fetchImpl }
    );

    assert.strictEqual(result.size, 3, 'only rows with embeddings get entries');
    assert.ok(result.has('m1'));
    assert.ok(result.has('m2'));
    assert.ok(result.has('m3'));
    assert.ok(!result.has('m4'));
    assert.ok(!result.has('m5'));
  });

  test('cross-model rejection: row with bge model excluded when active is nomic', async () => {
    process.env['RELAY_EMBEDDING_MODEL'] = NOMIC;
    const queryVec = Array.from(makeFloat32(768, (i) => (i === 0 ? 1 : 0)));
    const fetchMock = makeEmbedFetchSuccess(queryVec);
    const docVec = makeFloat32(768, (i) => (i === 0 ? 1 : 0));

    const store = makeStore({
      m1: { blob: vectorToBlob(docVec), model: NOMIC },
      m2: { blob: vectorToBlob(docVec), model: 'bge-large-en-v1.5' }, // wrong model
    });
    const candidates = [makeMemory({ memory_id: 'm1' }), makeMemory({ memory_id: 'm2' })];

    const result = await computeSemanticSimilarities(
      store,
      { query: 'q', token_budget: 1000 },
      candidates,
      { fetchImpl: fetchMock.fetchImpl }
    );

    assert.strictEqual(result.size, 1);
    assert.ok(result.has('m1'));
    assert.ok(!result.has('m2'), 'bge-embedded row rejected when nomic is active');
  });

  test('fetch failure → empty Map + one stderr warning (deduped per reason)', async () => {
    process.env['RELAY_EMBEDDING_MODEL'] = NOMIC;
    // fetchImpl that returns http-500
    const fetchImpl = (async () => {
      return {
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => '',
      } as unknown as Response;
    }) as typeof fetch;

    const store = makeStore({
      m1: { blob: vectorToBlob(makeFloat32()), model: NOMIC },
    });
    const candidates = [makeMemory({ memory_id: 'm1' })];

    const stderr = captureStderr();
    let result: ReadonlyMap<string, number>;
    try {
      // Call twice — should see ONE warning, not two (deduped).
      result = await computeSemanticSimilarities(
        store,
        { query: 'q', token_budget: 1000 },
        candidates,
        { fetchImpl }
      );
      await computeSemanticSimilarities(
        store,
        { query: 'q', token_budget: 1000 },
        candidates,
        { fetchImpl }
      );
    } finally {
      stderr.restore();
    }

    assert.strictEqual(result.size, 0, 'failed embed → empty Map');
    const warnings = stderr.lines.filter((l) => l.includes('RELAY: embedding skipped'));
    assert.strictEqual(
      warnings.length,
      1,
      `expected 1 deduped warning, got ${warnings.length}: ${warnings.join('|')}`
    );
    assert.ok(warnings[0]!.includes('http-500'));
  });

  test('wrong-dim response → empty Map + warning (defense-in-depth)', async () => {
    process.env['RELAY_EMBEDDING_MODEL'] = NOMIC;
    // 512-dim instead of 768 → embedding-client returns reason='wrong-dim'
    const wrongDim = Array.from(new Array(512).fill(0));
    const fetchMock = makeEmbedFetchSuccess(wrongDim);
    const store = makeStore({
      m1: { blob: vectorToBlob(makeFloat32()), model: NOMIC },
    });
    const candidates = [makeMemory({ memory_id: 'm1' })];

    const stderr = captureStderr();
    let result: ReadonlyMap<string, number>;
    try {
      result = await computeSemanticSimilarities(
        store,
        { query: 'q', token_budget: 1000 },
        candidates,
        { fetchImpl: fetchMock.fetchImpl }
      );
    } finally {
      stderr.restore();
    }

    assert.strictEqual(result.size, 0);
    assert.ok(
      stderr.lines.some((l) => l.includes('wrong-dim')),
      'wrong-dim surfaced as warning'
    );
  });

  test('clamps cosine to [0, 1] before inserting (negative similarity → 0)', async () => {
    process.env['RELAY_EMBEDDING_MODEL'] = NOMIC;
    // Query and doc are anti-parallel → raw cosine = -1
    const queryVec = makeFloat32(768, (i) => (i === 0 ? 1 : 0));
    const docVec = makeFloat32(768, (i) => (i === 0 ? -1 : 0));
    const fetchMock = makeEmbedFetchSuccess(Array.from(queryVec));

    const store = makeStore({
      m1: { blob: vectorToBlob(docVec), model: NOMIC },
    });
    const candidates = [makeMemory({ memory_id: 'm1' })];

    const result = await computeSemanticSimilarities(
      store,
      { query: 'q', token_budget: 1000 },
      candidates,
      { fetchImpl: fetchMock.fetchImpl }
    );

    assert.strictEqual(result.size, 1);
    assert.strictEqual(result.get('m1'), 0, 'anti-parallel clamped to 0');
  });

  test('endpoint and model overridable via opts (for testing without env)', async () => {
    delete process.env['RELAY_EMBEDDING_MODEL'];
    delete process.env['LMSTUDIO_ENDPOINT'];

    const calls: string[] = [];
    const fetchImpl = (async (input: unknown) => {
      calls.push(String(input));
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ embedding: Array.from(makeFloat32()) }] }),
        text: async () => '',
      } as unknown as Response;
    }) as typeof fetch;

    const store = makeStore({
      m1: { blob: vectorToBlob(makeFloat32()), model: NOMIC },
    });
    const candidates = [makeMemory({ memory_id: 'm1' })];

    const result = await computeSemanticSimilarities(
      store,
      { query: 'override test', token_budget: 1000 },
      candidates,
      { fetchImpl, endpoint: 'http://custom:9999', model: NOMIC }
    );

    assert.strictEqual(result.size, 1);
    assert.ok(calls.some((c) => c.includes('http://custom:9999/v1/embeddings')));
  });
});
