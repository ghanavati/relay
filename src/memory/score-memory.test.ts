import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { scoreMemory } from './memory-engine.js';
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
