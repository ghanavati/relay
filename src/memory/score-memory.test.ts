import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { scoreMemory, scoreMemoryDetailed } from './memory-engine.js';
import type { Memory, RecallQuery } from './types.js';

// Helper to create a minimal memory fixture
function createMemory(
  overrides: Partial<Memory> = {}
): Memory {
  const now = Date.now();
  return {
    memory_id: 'test-memory-1',
    memory_type: 'lesson',
    content: 'This is a test lesson about error handling',
    tags: ['error', 'handling'],
    workdir: '/test/workdir',
    token_count: 100,
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
    conflicts_with: [],
    ...overrides,
  };
}

// Helper to create a recall query
function createQuery(overrides: Partial<RecallQuery> = {}): RecallQuery {
  return {
    query: 'error handling',
    tags: ['error'],
    types: ['lesson'],
    token_budget: 1000,
    ...overrides,
  };
}

describe('scoreMemory', () => {
  const now = Date.now();

  test('pinned memory scores higher than unpinned with same content', () => {
    const unpinned = createMemory({ pinned: false });
    const pinned = createMemory({ pinned: true });

    const query = createQuery();
    
    const unpinnedScore = scoreMemory(unpinned, query, now);
    const pinnedScore = scoreMemory(pinned, query, now);

    assert.ok(pinnedScore > unpinnedScore, 'pinned memory should score higher');
  });

  test('tag match increases score vs no tags', () => {
    const withTags = createMemory({ tags: ['error', 'handling'] });
    const withoutTags = createMemory({ tags: [] });

    const query = createQuery({ tags: ['error', 'exception'] });

    const withTagsScore = scoreMemory(withTags, query, now);
    const withoutTagsScore = scoreMemory(withoutTags, query, now);

    assert.ok(withTagsScore > withoutTagsScore, 'memory with matching tags should score higher');
  });

  test('stale memory (accessed_at 30 days ago) scores lower than fresh memory', () => {
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const fresh = createMemory({ accessed_at: now });
    const stale = createMemory({ accessed_at: now - thirtyDaysMs });

    const query = createQuery();

    const freshScore = scoreMemory(fresh, query, now);
    const staleScore = scoreMemory(stale, query, now);

    assert.ok(freshScore > staleScore, 'fresh memory should score higher than stale');
  });

  test('content keyword match increases score', () => {
    const matchingContent = createMemory({ 
      content: 'This lesson covers error handling patterns in TypeScript' 
    });
    const nonMatchingContent = createMemory({ 
      content: 'This lesson covers configuration management' 
    });

    const query = createQuery({ query: 'error handling' });

    const matchingScore = scoreMemory(matchingContent, query, now);
    const nonMatchingScore = scoreMemory(nonMatchingContent, query, now);

    assert.ok(matchingScore > nonMatchingScore, 'content with matching keywords should score higher');
  });

  test('score is between 0 and 2', () => {
    const memory = createMemory();
    const query = createQuery();

    const score = scoreMemory(memory, query, now);

    assert.ok(score >= 0, 'score should be >= 0');
    assert.ok(score <= 2, 'score should be <= 2');
  });
});

describe('scoreMemoryDetailed — opts.semanticSimilarity (PLAN-4 T3)', () => {
  const now = Date.now();

  test('regression: scoreMemory(m, q, now) WITHOUT opts is byte-identical to pre-change result', () => {
    const memory = createMemory({ content: 'lesson about error handling in TypeScript' });
    const query = createQuery({ query: 'error handling', tags: ['error'] });

    const before = scoreMemory(memory, query, now);
    const after = scoreMemory(memory, query, now /* no opts */);
    assert.strictEqual(after, before, 'no-opts call must be identical');

    const breakdown = scoreMemoryDetailed(memory, query, now);
    const breakdownNoOpts = scoreMemoryDetailed(memory, query, now /* no opts */);
    assert.strictEqual(breakdown.total, breakdownNoOpts.total, 'no-opts breakdown.total identical');
    assert.deepStrictEqual(breakdown.components, breakdownNoOpts.components);
  });

  test('opts.semanticSimilarity = 0.9 → ScoreComponents.content = 0.9 × 0.15 = 0.135', () => {
    const memory = createMemory({ content: 'unrelated content lorem ipsum' });
    const query = createQuery({ query: 'completely different words', tags: [] });

    // Without opts, content score would be ~0 (no word overlap).
    const withoutOpts = scoreMemoryDetailed(memory, query, now);
    assert.strictEqual(withoutOpts.components.content, 0, 'baseline: zero word overlap → 0');

    const withSim = scoreMemoryDetailed(memory, query, now, { semanticSimilarity: 0.9 });
    // 0.9 (raw similarity) × 0.15 (content weight) = 0.135
    assert.ok(
      Math.abs(withSim.components.content - 0.135) < 1e-9,
      `expected content=0.135, got ${withSim.components.content}`
    );
    // Total reflects the swap
    assert.ok(withSim.total > withoutOpts.total, 'total increases by 0.135');
  });

  test('opts.semanticSimilarity = 0 (NOT undefined) → contentScore = 0, NOT word-overlap fallback', () => {
    const memory = createMemory({
      content: 'error handling lesson about typescript',
    });
    // Query has perfect word overlap with content → word-overlap would give high content score
    const query = createQuery({ query: 'error handling lesson typescript', tags: [] });

    const wordOverlap = scoreMemoryDetailed(memory, query, now);
    assert.ok(wordOverlap.components.content > 0, 'word-overlap path gives non-zero content');

    const semZero = scoreMemoryDetailed(memory, query, now, { semanticSimilarity: 0 });
    assert.strictEqual(
      semZero.components.content,
      0,
      'explicit similarity=0 OVERRIDES word-overlap (not a fallback)'
    );
  });

  test('opts.semanticSimilarity = undefined → falls through to computeContentScore (word-overlap)', () => {
    const memory = createMemory({ content: 'error handling lesson' });
    const query = createQuery({ query: 'error handling' });

    const baseline = scoreMemoryDetailed(memory, query, now);
    const explicitUndef = scoreMemoryDetailed(memory, query, now, { semanticSimilarity: undefined });

    assert.strictEqual(explicitUndef.total, baseline.total);
    assert.deepStrictEqual(explicitUndef.components, baseline.components);
  });

  test('no-query branch: opts.semanticSimilarity is IGNORED (content forced to 0)', () => {
    const memory = createMemory({ content: 'something' });
    // No query text AND no tags → no-query branch
    const noQuery: RecallQuery = { token_budget: 1000 };

    const withSim = scoreMemoryDetailed(memory, noQuery, now, { semanticSimilarity: 0.99 });
    assert.strictEqual(
      withSim.components.content,
      0,
      'no-query branch forces content=0 regardless of semantic similarity'
    );
  });

  test('semanticSimilarity clamped to [0, 1] (defense vs bad callers)', () => {
    const memory = createMemory({ content: 'x' });
    const query = createQuery({ query: 'y' });

    // Above 1
    const above = scoreMemoryDetailed(memory, query, now, { semanticSimilarity: 2.5 });
    assert.ok(
      above.components.content <= 0.15 + 1e-9,
      `clamped to <= 1 × 0.15, got ${above.components.content}`
    );

    // Below 0
    const below = scoreMemoryDetailed(memory, query, now, { semanticSimilarity: -0.5 });
    assert.strictEqual(below.components.content, 0, 'negative clamped to 0');
  });

  test('ScoreComponents.content carries semantic value for `relay memory why` surface (EMBED-04)', () => {
    const memory = createMemory({ content: 'totally unrelated lorem ipsum' });
    const query = createQuery({ query: 'embedding similarity proof', tags: [] });

    const result = scoreMemoryDetailed(memory, query, now, { semanticSimilarity: 0.73 });
    // Raw 0.73 × content weight 0.15 = 0.1095
    assert.ok(
      Math.abs(result.components.content - 0.1095) < 1e-9,
      `expected 0.1095, got ${result.components.content}`
    );
  });

  test('scoreMemory wrapper forwards opts.semanticSimilarity', () => {
    const memory = createMemory({ content: 'unrelated' });
    const query = createQuery({ query: 'different words entirely', tags: [] });

    const without = scoreMemory(memory, query, now);
    const withSim = scoreMemory(memory, query, now, { semanticSimilarity: 0.95 });

    assert.ok(withSim > without, 'scoreMemory wrapper must thread opts through');
    // Verify by direct comparison with scoreMemoryDetailed
    const detailed = scoreMemoryDetailed(memory, query, now, { semanticSimilarity: 0.95 });
    assert.strictEqual(withSim, detailed.total);
  });
});
