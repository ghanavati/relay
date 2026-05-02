import { beforeEach, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { budgetedRecall, scoreMemory } from './memory-engine.js';
import { DECAY_HALF_LIFE_DAYS, TYPE_WEIGHTS, type Memory, type MemoryType, type RecallQuery } from './types.js';

const NOW = Date.parse('2026-03-17T12:00:00.000Z');
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

let nextId = 1;

function approx(actual: number, expected: number, epsilon: number = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`
  );
}

function createMemory(overrides: Partial<Memory> = {}): Memory {
  const memoryId = overrides.memory_id ?? `memory-${nextId++}`;
  return {
    memory_id: memoryId,
    memory_type: overrides.memory_type ?? 'fact',
    content: overrides.content ?? 'relay auth token cache',
    tags: overrides.tags ?? [],
    workdir: overrides.workdir ?? null,
    token_count: overrides.token_count ?? 10,
    pinned: overrides.pinned ?? false,
    source_run_id: overrides.source_run_id ?? null,
    git_ref: overrides.git_ref ?? null,
    created_at: overrides.created_at ?? NOW,
    accessed_at: overrides.accessed_at ?? NOW,
    expires_at: overrides.expires_at ?? null,
    entity_key: overrides.entity_key ?? null,
    sources: overrides.sources ?? [],
    recall_count: overrides.recall_count ?? 0,
    memory_source: overrides.memory_source ?? 'unknown',
    success_recall_count: overrides.success_recall_count ?? 0,
    files: overrides.files ?? [],
    trust_level: overrides.trust_level ?? 'unverified',
  };
}

describe('scoreMemory', () => {
  beforeEach(() => {
    nextId = 1;
  });

  it('combines tag match, content match, recency, type weight, and pin bonus when a query is present', () => {
    const memory = createMemory({
      memory_type: 'fact',
      content: 'Relay token cache strategy for auth refreshes',
      tags: ['auth', 'cache'],
      pinned: true,
    });
    const query: RecallQuery = {
      query: 'relay token cache',
      tags: ['auth'],
      token_budget: 200,
    };

    const score = scoreMemory(memory, query, NOW);
    const expected =
      0.5 * 0.35 +
      1 * 0.15 +
      1 * 0.25 +
      TYPE_WEIGHTS['fact'] * 0.15 +
      0.5 * 0.1;

    approx(score, expected);
  });

  it('falls back to recency, type, and pin weighting when query text and tags are absent', () => {
    const memory = createMemory({
      memory_type: 'decision',
      pinned: true,
      accessed_at: NOW - 30 * MS_PER_DAY,
    });

    const score = scoreMemory(memory, { token_budget: 200 }, NOW);
    const recency = Math.exp(-30 / DECAY_HALF_LIFE_DAYS['decision']);
    const expected = recency * 0.45 + TYPE_WEIGHTS['decision'] * 0.35 + 0.5 * 0.2;

    approx(score, expected);
  });

  it('yields the expected perfect score for a pinned fact with exact tag and content matches', () => {
    const memory = createMemory({
      memory_type: 'fact',
      content: 'Relay auth token cache',
      tags: ['auth'],
      pinned: true,
    });
    const query: RecallQuery = {
      query: 'relay auth token cache',
      tags: ['auth'],
      token_budget: 200,
    };

    const score = scoreMemory(memory, query, NOW);

    approx(score, 0.95);
  });

  it('bottoms out near the type floor for an ancient state memory with no matches', () => {
    const memory = createMemory({
      memory_type: 'state',
      content: 'stale terminal state',
      accessed_at: NOW - 30 * MS_PER_DAY,
    });
    const query: RecallQuery = {
      query: 'unrelated request',
      tags: ['missing'],
      token_budget: 200,
    };

    const score = scoreMemory(memory, query, NOW);

    assert.ok(score >= 0.045);
    assert.ok(score < 0.046);
  });
});

describe('scoreMemory temporal decay', () => {
  beforeEach(() => {
    nextId = 1;
  });

  const cases = [
    { label: 'hours', elapsedMs: 6 * MS_PER_HOUR },
    { label: 'days', elapsedMs: 3 * MS_PER_DAY },
    { label: 'weeks', elapsedMs: 14 * MS_PER_DAY },
  ] as const;

  for (const testCase of cases) {
    it(`matches exponential decay after ${testCase.label}`, () => {
      const memory = createMemory({
        memory_type: 'context',
        accessed_at: NOW - testCase.elapsedMs,
      });

      const score = scoreMemory(memory, { token_budget: 100 }, NOW);
      const derivedRecency = (score - TYPE_WEIGHTS['context'] * 0.35) / 0.45;
      const elapsedDays = testCase.elapsedMs / MS_PER_DAY;
      const expectedRecency = Math.exp(-elapsedDays / DECAY_HALF_LIFE_DAYS['context']);

      approx(derivedRecency, expectedRecency);
    });
  }
});

describe('scoreMemory type weights', () => {
  beforeEach(() => {
    nextId = 1;
  });

  for (const [memoryType, expectedWeight] of Object.entries(TYPE_WEIGHTS)) {
    it(`uses the configured default weight for ${memoryType}`, () => {
      const memory = createMemory({
        memory_type: memoryType as MemoryType,
      });

      const score = scoreMemory(memory, { token_budget: 100 }, NOW);
      const derivedWeight = (score - 0.45) / 0.35;

      approx(derivedWeight, expectedWeight);
    });
  }
});

describe('budgetedRecall', () => {
  beforeEach(() => {
    nextId = 1;
  });

  it('greedily packs the highest-scoring memories that fit inside the token budget', () => {
    const memories = [
      createMemory({
        memory_id: 'best-fit',
        memory_type: 'fact',
        content: 'relay auth token',
        tags: ['auth'],
        token_count: 3,
      }),
      createMemory({
        memory_id: 'too-large',
        memory_type: 'lesson',
        content: 'relay auth token',
        tags: ['auth'],
        token_count: 4,
        accessed_at: NOW - 200 * MS_PER_DAY,
      }),
      createMemory({
        memory_id: 'fits-after-skip',
        memory_type: 'context',
        content: 'workspace summary',
        tags: ['notes'],
        token_count: 2,
      }),
    ];

    const result = budgetedRecall(
      memories,
      { query: 'relay auth token', tags: ['auth'], token_budget: 5 },
      NOW
    );

    assert.deepEqual(
      result.memories.map(memory => memory.memory_id),
      ['best-fit', 'fits-after-skip']
    );
    assert.equal(result.total_tokens, 5);
    assert.equal(result.budget_remaining, 0);
    assert.equal(result.omitted_count, 1);
  });

  it('includes zero-token memories even when the budget is zero', () => {
    const memories = [
      createMemory({
        memory_id: 'free',
        memory_type: 'fact',
        token_count: 0,
      }),
      createMemory({
        memory_id: 'paid',
        memory_type: 'fact',
        token_count: 1,
        accessed_at: NOW - MS_PER_HOUR,
      }),
    ];

    const result = budgetedRecall(memories, { token_budget: 0 }, NOW);

    assert.deepEqual(
      result.memories.map(memory => memory.memory_id),
      ['free']
    );
    assert.equal(result.total_tokens, 0);
    assert.equal(result.budget_remaining, 0);
    assert.equal(result.omitted_count, 1);
  });

  it('treats expired memories like any other candidate because expiry filtering happens upstream', () => {
    const expired = createMemory({
      memory_id: 'expired',
      memory_type: 'fact',
      expires_at: NOW - MS_PER_HOUR,
    });

    const result = budgetedRecall([expired], { token_budget: 10 }, NOW);

    assert.deepEqual(
      result.memories.map(memory => memory.memory_id),
      ['expired']
    );
  });
});
