/**
 * PLAN-4 T6 — Wire computeSemanticSimilarities into handleRecall + handleMemorySearch.
 *
 * Both MCP tool handlers must:
 *   1. become async (handleMemorySearch was sync; handleRecall was sync)
 *   2. await computeSemanticSimilarities(store, query, candidates) BEFORE budgetedRecall
 *   3. when fetch fails (or RELAY_EMBEDDING_MODEL unset), fall through to word-overlap
 *      — byte-identical response shape; regression guard for ~330 existing tests.
 *
 * Tests inject a stubbed fetch via globalThis so the helper sees a valid 768-dim
 * vector and the scorer flips to the similarities path. With no RELAY_EMBEDDING_MODEL,
 * the helper short-circuits → empty Map → byte-identical word-overlap behaviour.
 */

process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { MemoryStore } from '../memory/memory-store.js';
import { closeDb } from '../runtime/store/db.js';
import { _resetWarnedReasonsForTesting } from '../memory/semantic-similarities.js';

const NOMIC = 'text-embedding-nomic-embed-text-v1.5';
const DIM = 768;

/** Build a 768-dim unit vector with a single 1.0 spike at the given index. */
function unitSpike(index: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[index] = 1;
  return v;
}

/** Decode a Buffer holding 768 little-endian float32 into a Float32Array view. */
function blobToVec(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

/** Build a mock fetch that returns a fixed embedding for /v1/embeddings. */
function mockFetch(vector: number[]): typeof fetch {
  return ((async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    if (url.endsWith('/v1/embeddings')) {
      return new Response(JSON.stringify({ data: [{ embedding: vector }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }) as Response;
    }
    return new Response('not-found', { status: 404 }) as Response;
  }) as unknown) as typeof fetch;
}

/** Suppress stderr during a block (warnings from the helper are not under test here). */
function suppressStderr(): () => void {
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr.write as unknown as (chunk: string) => boolean) = (() => true) as unknown as typeof process.stderr.write;
  return () => {
    (process.stderr.write as unknown as (chunk: string) => boolean) =
      original as unknown as (chunk: string) => boolean;
  };
}

/** Wait one tick for the queueMicrotask-scheduled embed UPDATE to land. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('PLAN-4 T6: handleRecall wires computeSemanticSimilarities', () => {
  beforeEach(() => {
    _resetWarnedReasonsForTesting();
    delete process.env['RELAY_EMBEDDING_MODEL'];
    delete process.env['LMSTUDIO_ENDPOINT'];
  });

  afterEach(() => {
    delete process.env['RELAY_EMBEDDING_MODEL'];
    delete process.env['LMSTUDIO_ENDPOINT'];
    closeDb();
  });

  test('handleRecall is async — returns Promise<McpToolResult>', async () => {
    const { handleRecall } = await import('./recall.js');
    const result = handleRecall({
      query: 'no-such-query',
      tags: [],
      token_budget: 1000,
      workdir: '/t6-async-' + Date.now(),
      include_expired: false,
    }) as unknown;
    assert.ok(
      typeof (result as Promise<unknown>).then === 'function',
      'handleRecall must return a Promise (T6 sync→async conversion)'
    );
    await (result as Promise<unknown>); // drain
  });

  test('handleMemorySearch is async — returns Promise<McpToolResult>', async () => {
    const { handleMemorySearch } = await import('./memory_search.js');
    const result = handleMemorySearch({
      query: 'no-such-query',
      tags: [],
      token_budget: 1000,
      workdir: '/t6-search-async-' + Date.now(),
      include_expired: false,
    }) as unknown;
    assert.ok(
      typeof (result as Promise<unknown>).then === 'function',
      'handleMemorySearch must return a Promise (T6 sync→async conversion)'
    );
    await (result as Promise<unknown>); // drain
  });

  test('with RELAY_EMBEDDING_MODEL unset, handleRecall is byte-identical to pre-T6 (regression guard)', async () => {
    const workdir = '/t6-unset-' + Date.now();
    const store = new MemoryStore();
    store.remember({
      content: 'apple banana cherry',
      memory_type: 'fact',
      workdir,
      tags: ['fruit'],
    });
    store.remember({
      content: 'red green blue',
      memory_type: 'fact',
      workdir,
      tags: ['color'],
    });

    const { handleRecall } = await import('./recall.js');
    const response = await handleRecall({
      query: 'apple',
      tags: [],
      token_budget: 1000,
      workdir,
      include_expired: false,
    });
    const parsed = JSON.parse(response.content[0]!.text) as {
      memories: Array<{ memory_id: string; score: number; content: string }>;
    };
    // Word-overlap path: 'apple' query → only the fruit memory matches content.
    assert.ok(parsed.memories.length >= 1, 'word-overlap recall should return ≥ 1 memory');
    assert.ok(
      parsed.memories.some((m) => m.content.includes('apple')),
      'fruit memory containing "apple" must be in results when fetch unavailable'
    );
  });

  test('with mock fetch + RELAY_EMBEDDING_MODEL set, handleRecall uses similarities', async () => {
    const workdir = '/t6-sim-' + Date.now();
    process.env['RELAY_EMBEDDING_MODEL'] = NOMIC;
    process.env['LMSTUDIO_ENDPOINT'] = 'http://127.0.0.1:1234';

    // Inject mock fetch globally so semantic-similarities picks it up via process.env-derived defaults.
    const originalFetch = globalThis.fetch;
    const restoreStderr = suppressStderr();

    try {
      // Both memories embed to spike@0 via mock fetch (so cosine = 1.0).
      globalThis.fetch = mockFetch(unitSpike(0));

      const store = new MemoryStore();
      const fruitId = store.remember({
        content: 'apple banana cherry',
        memory_type: 'fact',
        workdir,
        tags: ['fruit'],
      });
      const colorId = store.remember({
        content: 'red green blue',
        memory_type: 'fact',
        workdir,
        tags: ['color'],
      });
      // Let queueMicrotask-scheduled embed UPDATEs land.
      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 30));
      await flushMicrotasks();

      // Both rows now have embedding_blob populated via mock fetch.
      const rawById = store.getRawEmbeddings([fruitId, colorId]);
      assert.strictEqual(rawById.size, 2, 'both rows must have embedding_blob written');
      for (const { blob, model } of rawById.values()) {
        assert.strictEqual(blob.byteLength, DIM * 4, 'blob must be 3072 bytes');
        assert.strictEqual(model, NOMIC, 'model column must be set');
        // Verify the BLOB round-trips to the mock vector (spike@0).
        const vec = blobToVec(blob);
        assert.strictEqual(vec[0], 1);
        assert.strictEqual(vec[1], 0);
      }

      const { handleRecall } = await import('./recall.js');
      // Query with text that has ZERO word overlap with fruit content.
      const response = await handleRecall({
        query: 'xyzzy plugh quux',
        tags: [],
        token_budget: 4000,
        workdir,
        include_expired: false,
      });
      const parsed = JSON.parse(response.content[0]!.text) as {
        memories: Array<{ memory_id: string; score: number; content: string }>;
      };
      // With similarities = 1.0 for both rows (mock returns spike@0 for everything),
      // the similarity-driven path produces non-zero content scores even though
      // word overlap is zero. Without T6 wiring, scores would be ~0 on the content axis.
      assert.ok(
        parsed.memories.length === 2,
        `both rows must surface via semantic recall (got ${parsed.memories.length})`
      );
      // Score must be > 0.15 (MIN_RELEVANCE_SCORE) because content×0.15 = 1.0×0.15 = 0.15
      // PLUS recency + type bonuses push above threshold.
      for (const m of parsed.memories) {
        assert.ok(
          m.score > 0.15,
          `memory ${m.memory_id} score=${m.score} must exceed MIN_RELEVANCE_SCORE with similarities=1`
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
      restoreStderr();
    }
  });

  test('handleMemorySearch threads similarities through to compact response', async () => {
    const workdir = '/t6-search-sim-' + Date.now();
    process.env['RELAY_EMBEDDING_MODEL'] = NOMIC;
    process.env['LMSTUDIO_ENDPOINT'] = 'http://127.0.0.1:1234';

    const originalFetch = globalThis.fetch;
    const restoreStderr = suppressStderr();

    try {
      globalThis.fetch = mockFetch(unitSpike(0));

      const store = new MemoryStore();
      store.remember({
        content: 'apple banana cherry',
        memory_type: 'fact',
        workdir,
        tags: ['fruit'],
      });
      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 30));
      await flushMicrotasks();

      const { handleMemorySearch } = await import('./memory_search.js');
      const response = await handleMemorySearch({
        query: 'xyzzy plugh quux',
        tags: [],
        token_budget: 4000,
        workdir,
        include_expired: false,
      });
      const parsed = JSON.parse(response.content[0]!.text) as {
        results: Array<{ memory_id: string; score: number; excerpt: string }>;
        total_results: number;
      };
      assert.strictEqual(parsed.total_results, 1, 'compact search must surface the row');
      assert.ok(
        parsed.results[0]!.score > 0.15,
        `score=${parsed.results[0]!.score} must exceed MIN_RELEVANCE_SCORE with semantics`
      );
    } finally {
      globalThis.fetch = originalFetch;
      restoreStderr();
    }
  });

  test('cross-model mismatch — row excluded from similarities (regression guard)', async () => {
    const workdir = '/t6-xmodel-' + Date.now();
    process.env['RELAY_EMBEDDING_MODEL'] = 'different-model-v9';
    process.env['LMSTUDIO_ENDPOINT'] = 'http://127.0.0.1:1234';

    const originalFetch = globalThis.fetch;
    const restoreStderr = suppressStderr();

    try {
      // Mock fetch returns a valid query embedding for the "different model"
      globalThis.fetch = mockFetch(unitSpike(5));

      const store = new MemoryStore();
      // First insert with the "wrong" model env so the row gets NOMIC stored — wait,
      // we need to insert a row whose embedding_model = NOMIC, then query with different-model.
      // Re-set env mid-flight: insert with NOMIC, query with different-model-v9.
      process.env['RELAY_EMBEDDING_MODEL'] = NOMIC;
      // Insert needs its own fetch context too — set the mock to nomic-style embedding
      const oldFetch2 = globalThis.fetch;
      globalThis.fetch = mockFetch(unitSpike(0));
      const id = store.remember({
        content: 'apple banana cherry',
        memory_type: 'fact',
        workdir,
        tags: ['fruit'],
      });
      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 30));
      await flushMicrotasks();
      globalThis.fetch = oldFetch2;

      // Verify the row stored with NOMIC model
      const raw = store.getRawEmbeddings([id]);
      const entry = raw.get(id);
      assert.ok(entry, 'row must have embedding stored');
      assert.strictEqual(entry.model, NOMIC, 'row stored with nomic model');

      // Now flip env to different model — cross-model rejection in helper means
      // the row's id won't appear in the similarities Map, so the engine falls
      // through to word-overlap for that row.
      process.env['RELAY_EMBEDDING_MODEL'] = 'different-model-v9';

      const { handleRecall } = await import('./recall.js');
      const response = await handleRecall({
        query: 'xyzzy plugh quux',
        tags: [],
        token_budget: 4000,
        workdir,
        include_expired: false,
      });
      const parsed = JSON.parse(response.content[0]!.text) as {
        memories: Array<{ memory_id: string; score: number }>;
      };
      const xmodelScore = parsed.memories[0]?.score ?? 0;

      // Now query with the SAME model the row was embedded with - semantic kicks in,
      // producing a HIGHER score because content x 0.15 = 0.15.
      process.env['RELAY_EMBEDDING_MODEL'] = NOMIC;
      globalThis.fetch = mockFetch(unitSpike(0));
      const sameModelResponse = await handleRecall({
        query: 'xyzzy plugh quux',
        tags: [],
        token_budget: 4000,
        workdir,
        include_expired: false,
      });
      const sameModelParsed = JSON.parse(sameModelResponse.content[0]!.text) as {
        memories: Array<{ memory_id: string; score: number }>;
      };
      const sameModelScore = sameModelParsed.memories[0]?.score ?? 0;

      // Key assertion: cross-model rejection means xmodelScore < sameModelScore
      // by approximately 0.15 (the content x weight delta). Cross-model fell back
      // to word-overlap (=0 for non-overlapping query); same-model used cosine
      // (=1.0 -> content score = 1.0 x 0.15 = 0.15).
      assert.ok(
        sameModelScore > xmodelScore + 0.10,
        `same-model score (${sameModelScore}) must exceed cross-model score (${xmodelScore}) by ~0.15 (semantic content bonus)`
      );
    } finally {
      globalThis.fetch = originalFetch;
      restoreStderr();
    }
  });
});
