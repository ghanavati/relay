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
});
