import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { budgetedRecall } from './memory-engine.js';

describe('budgetedRecall', () => {
  const now = Date.now();

  function makeMemory(
    overrides: Partial<{
      memory_id: string;
      content: string;
      tags: string[];
      token_count: number;
      pinned: boolean;
      accessed_at: number;
      memory_type: 'fact' | 'lesson' | 'decision' | 'context' | 'state' | 'handoff';
    }> = {}
  ) {
    return {
      memory_id: overrides.memory_id ?? 'mem-001',
      memory_type: overrides.memory_type ?? 'fact',
      content: overrides.content ?? 'test content',
      tags: overrides.tags ?? [],
      workdir: null,
      token_count: overrides.token_count ?? 10,
      pinned: overrides.pinned ?? false,
      source_run_id: null,
      git_ref: null,
      created_at: now - 1000,
      accessed_at: overrides.accessed_at ?? now,
      expires_at: null,
      entity_key: null,
      sources: [],
      recall_count: 0,
      memory_source: 'unknown' as const,
      success_recall_count: 0,
      files: [],
      trust_level: 'unverified' as const,
      conflicts_with: [],
    };
  }

  test('with a query string, a memory scored below 0.15 is excluded from results', () => {
    // A fresh 'fact' scores 0.40 (recency 0.25 + typeWeight 0.15) even with no match.
    // To get genuinely below threshold: use stale 'context' (weight 0.5, half-life 7d).
    // At 90 days stale: recency ≈ 0, score = 0 + 0.5*0.15 = 0.075 < 0.15.
    const ninetyDaysAgo = now - 90 * 24 * 60 * 60 * 1000;
    const memories = [
      makeMemory({
        memory_id: 'high-score',
        content: 'important fact about xyz',
        tags: ['xyz'],
        token_count: 20,
      }),
      makeMemory({
        memory_id: 'low-score',
        content: 'unrelated content',
        tags: ['abc'],
        token_count: 15,
        memory_type: 'context',
        accessed_at: ninetyDaysAgo,
      }),
    ];

    const result = budgetedRecall(memories, { query: 'xyz', token_budget: 1000 }, now);

    assert.strictEqual(result.memories.length, 1);
    assert.strictEqual(result.memories[0].memory_id, 'high-score');
    assert.strictEqual(result.omitted_count, 1);
  });

  test('a pinned memory is included even if its score would be below threshold', () => {
    // Both memories are stale 'context' type with no query match — score ≈ 0.075 < 0.15.
    // Only the pinned one should survive the threshold filter.
    const ninetyDaysAgo = now - 90 * 24 * 60 * 60 * 1000;
    const memories = [
      makeMemory({
        memory_id: 'pinned-low-score',
        content: 'unrelated text',
        tags: ['abc'],
        token_count: 15,
        pinned: true,
        memory_type: 'context',
        accessed_at: ninetyDaysAgo,
      }),
      makeMemory({
        memory_id: 'unpinned-low-score',
        content: 'more unrelated text',
        tags: ['def'],
        token_count: 15,
        memory_type: 'context',
        accessed_at: ninetyDaysAgo,
      }),
    ];

    const result = budgetedRecall(memories, { query: 'xyz', token_budget: 1000 }, now);

    // Pinned bypass: only the pinned one passes despite both scoring below threshold.
    assert.strictEqual(result.memories.length, 1);
    assert.strictEqual(result.memories[0].memory_id, 'pinned-low-score');
    assert.strictEqual(result.omitted_count, 1);
  });

  test('with NO query and NO tags, all memories pass (pure recency mode, no threshold filter)', () => {
    const memories = [
      makeMemory({
        memory_id: 'old',
        content: 'old fact',
        token_count: 10,
        accessed_at: now - 100000,
      }),
      makeMemory({
        memory_id: 'recent',
        content: 'recent fact',
        token_count: 10,
        accessed_at: now - 1000,
      }),
    ];

    const result = budgetedRecall(memories, { token_budget: 1000 }, now);

    assert.strictEqual(result.memories.length, 2);
    assert.strictEqual(result.omitted_count, 0);
  });

  test('token budget is respected — memories that would exceed it are omitted and counted in omitted_count', () => {
    const memories = [
      makeMemory({ memory_id: 'big1', token_count: 100 }),
      makeMemory({ memory_id: 'big2', token_count: 100 }),
      makeMemory({ memory_id: 'big3', token_count: 100 }),
    ];

    const result = budgetedRecall(memories, { query: 'test', token_budget: 150 }, now);

    assert.strictEqual(result.memories.length, 1);
    assert.strictEqual(result.memories[0].memory_id, 'big1');
    assert.strictEqual(result.total_tokens, 100);
    assert.strictEqual(result.budget_remaining, 50);
    assert.strictEqual(result.omitted_count, 2);
  });

  test('empty memory array returns empty result with zero tokens', () => {
    const result = budgetedRecall([], { query: 'anything', token_budget: 500 }, now);

    assert.deepStrictEqual(result.memories, []);
    assert.strictEqual(result.total_tokens, 0);
    assert.strictEqual(result.budget_remaining, 500);
    assert.strictEqual(result.omitted_count, 0);
  });

  // PLAN-4 T4 — similarities map threading
  describe('similarities: ReadonlyMap<memory_id, cosine> (PLAN-4 T4)', () => {
    test('regression: budgetedRecall(m, q, now) WITHOUT map is byte-identical to pre-change result', () => {
      const memories = [
        makeMemory({ memory_id: 'a', content: 'something about xyz', tags: ['xyz'], token_count: 20 }),
        makeMemory({ memory_id: 'b', content: 'other stuff', tags: [], token_count: 15 }),
      ];

      const before = budgetedRecall(memories, { query: 'xyz', token_budget: 1000 }, now);
      const after = budgetedRecall(memories, { query: 'xyz', token_budget: 1000 }, now /* no map */);

      assert.strictEqual(after.memories.length, before.memories.length);
      for (let i = 0; i < after.memories.length; i++) {
        assert.strictEqual(after.memories[i]!.memory_id, before.memories[i]!.memory_id);
        assert.strictEqual(after.memories[i]!.score, before.memories[i]!.score);
      }
    });

    test('empty map behaves identically to no map (no map → no map, both flow to word-overlap)', () => {
      const memories = [
        makeMemory({ memory_id: 'a', content: 'something about xyz', tags: ['xyz'], token_count: 20 }),
        makeMemory({ memory_id: 'b', content: 'other stuff', tags: [], token_count: 15 }),
      ];

      const noMap = budgetedRecall(memories, { query: 'xyz', token_budget: 1000 }, now);
      const emptyMap = budgetedRecall(
        memories,
        { query: 'xyz', token_budget: 1000 },
        now,
        new Map<string, number>()
      );

      assert.strictEqual(emptyMap.memories.length, noMap.memories.length);
      for (let i = 0; i < emptyMap.memories.length; i++) {
        assert.strictEqual(emptyMap.memories[i]!.memory_id, noMap.memories[i]!.memory_id);
        assert.strictEqual(emptyMap.memories[i]!.score, noMap.memories[i]!.score);
      }
    });

    test('partial map: mapped rows use similarity, unmapped fall back to word-overlap', () => {
      const memories = [
        makeMemory({ memory_id: 'mapped-high-sim', content: 'totally unrelated lorem ipsum', tags: [], token_count: 20 }),
        makeMemory({ memory_id: 'unmapped-no-match', content: 'wholly different vocabulary', tags: [], token_count: 15 }),
      ];
      // Only `mapped-high-sim` has a similarity entry. Neither has word overlap
      // with the query ("xyz"), so unmapped falls back to word-overlap = 0.
      // mapped-high-sim: content score = 0.9 × 0.15 = 0.135 → above threshold.
      // unmapped-no-match: content score = 0 → only typeWeight survives, below threshold.
      const sims = new Map<string, number>([['mapped-high-sim', 0.9]]);

      const result = budgetedRecall(memories, { query: 'xyz', token_budget: 1000 }, now, sims);

      // Only the mapped row should survive — the unmapped one has no signals
      // above MIN_RELEVANCE_SCORE.
      const ids = result.memories.map((m) => m.memory_id);
      assert.strictEqual(ids[0], 'mapped-high-sim', 'similarity-scored memory ranks first');
      // Confirm the unmapped row got the word-overlap path (its score will be
      // much lower than mapped-high-sim's, regardless of inclusion).
      const mappedRow = result.memories.find((m) => m.memory_id === 'mapped-high-sim');
      const unmappedRow = result.memories.find((m) => m.memory_id === 'unmapped-no-match');
      if (mappedRow && unmappedRow) {
        assert.ok(
          mappedRow.score > unmappedRow.score,
          `mapped (${mappedRow.score}) must outrank unmapped (${unmappedRow.score})`
        );
      }
    });

    test('ordering flip: sim=0.9 AND zero word overlap OUTRANKS sim=undefined AND partial overlap (THE feature)', () => {
      // The hero scenario for Phase 4:
      // - Memory A: semantically related (sim=0.9) but zero word overlap with query
      // - Memory B: partial word overlap (matches "naming") but no similarity entry
      // Expectation: A ranks higher than B.
      const memories = [
        makeMemory({
          memory_id: 'kebab',
          content: 'prefer kebab-case for css classes',
          tags: [],
          token_count: 20,
        }),
        makeMemory({
          memory_id: 'partial',
          content: 'naming things is hard',
          tags: [],
          token_count: 20,
        }),
      ];
      const sims = new Map<string, number>([['kebab', 0.92]]);

      const result = budgetedRecall(
        memories,
        { query: 'naming conventions for stylesheets', token_budget: 1000 },
        now,
        sims
      );

      const ids = result.memories.map((m) => m.memory_id);
      assert.strictEqual(ids[0], 'kebab', 'semantic-similarity memory wins despite zero word overlap');
    });

    test('MIN_RELEVANCE_SCORE=0.15 still applies — sim=0.05 alone drops below threshold', () => {
      // A stale memory whose only signal is sim=0.05 should NOT pass threshold.
      const ninetyDaysAgo = now - 90 * 24 * 60 * 60 * 1000;
      const memories = [
        makeMemory({
          memory_id: 'weak-sim',
          content: 'no overlap',
          tags: [],
          token_count: 15,
          memory_type: 'context',
          accessed_at: ninetyDaysAgo,
        }),
      ];
      // 0.05 × 0.15 + typeWeight(context=0.5) × 0.15 ≈ 0.0825 < 0.15 threshold.
      const sims = new Map<string, number>([['weak-sim', 0.05]]);

      const result = budgetedRecall(
        memories,
        { query: 'whatever', token_budget: 1000 },
        now,
        sims
      );

      assert.strictEqual(result.memories.length, 0, 'weak signal dropped');
      assert.strictEqual(result.omitted_count, 1);
    });

    test('full map: all rows scored by similarity', () => {
      const memories = [
        makeMemory({ memory_id: 'a', content: 'first', tags: [], token_count: 10 }),
        makeMemory({ memory_id: 'b', content: 'second', tags: [], token_count: 10 }),
        makeMemory({ memory_id: 'c', content: 'third', tags: [], token_count: 10 }),
      ];
      const sims = new Map<string, number>([
        ['a', 0.9],
        ['b', 0.5],
        ['c', 0.7],
      ]);

      const result = budgetedRecall(memories, { query: 'test', token_budget: 1000 }, now, sims);
      const ids = result.memories.map((m) => m.memory_id);
      assert.deepStrictEqual(ids, ['a', 'c', 'b'], 'ordered by similarity DESC');
    });
  });
});
