import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { findConsolidationClusters, applyConsolidation } from './consolidation.js';
import type { Memory } from './types.js';

function makeMemory(overrides: Partial<Memory> & { memory_id: string }): Memory {
  return {
    memory_type: 'lesson',
    content: 'default content',
    tags: [],
    workdir: null,
    token_count: 10,
    pinned: false,
    source_run_id: null,
    git_ref: null,
    created_at: Date.now(),
    accessed_at: Date.now(),
    expires_at: null,
    entity_key: overrides.memory_id,
    sources: [],
    recall_count: 0,
    memory_source: 'human',
    success_recall_count: 0,
    files: [],
    trust_level: 'medium' as Memory['trust_level'],
    ...overrides,
  };
}

describe('findConsolidationClusters', () => {
  test('returns empty when no memories share enough tags', () => {
    const memories = [
      makeMemory({ memory_id: 'a', tags: ['alpha', 'beta'] }),
      makeMemory({ memory_id: 'b', tags: ['gamma', 'delta'] }),
    ];
    assert.deepEqual(findConsolidationClusters(memories), []);
  });

  test('groups memories sharing ≥2 tags into a cluster', () => {
    const memories = [
      makeMemory({ memory_id: 'a', tags: ['db', 'testing', 'sqlite'] }),
      makeMemory({ memory_id: 'b', tags: ['db', 'testing', 'mock'] }),
      makeMemory({ memory_id: 'c', tags: ['unrelated', 'other'] }),
    ];
    const clusters = findConsolidationClusters(memories);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].memories.length, 2);
    assert.ok(clusters[0].shared_tags.includes('db'));
    assert.ok(clusters[0].shared_tags.includes('testing'));
  });

  test('respects minSharedTags parameter', () => {
    const memories = [
      makeMemory({ memory_id: 'a', tags: ['db', 'testing'] }),
      makeMemory({ memory_id: 'b', tags: ['db', 'testing'] }),
    ];
    assert.equal(findConsolidationClusters(memories, 3).length, 0);
    assert.equal(findConsolidationClusters(memories, 2).length, 1);
  });

  test('does not assign same memory to multiple clusters', () => {
    const memories = [
      makeMemory({ memory_id: 'a', tags: ['x', 'y', 'z'] }),
      makeMemory({ memory_id: 'b', tags: ['x', 'y', 'w'] }),
      makeMemory({ memory_id: 'c', tags: ['x', 'y', 'v'] }),
    ];
    const clusters = findConsolidationClusters(memories);
    const allIds = clusters.flatMap(c => c.memories.map(m => m.memory_id));
    const uniqueIds = new Set(allIds);
    assert.equal(allIds.length, uniqueIds.size);
  });
});

describe('applyConsolidation', () => {
  test('calls upsert on primary and forget on rest', () => {
    const upsertCalls: unknown[] = [];
    const forgetCalls: string[] = [];
    const fakeStore = {
      upsert: (params: unknown) => { upsertCalls.push(params); return 'new-id'; },
      forget: (id: string) => { forgetCalls.push(id); return true; },
    };

    const older = makeMemory({ memory_id: 'old', tags: ['db', 'testing'], accessed_at: 100, entity_key: 'old' });
    const newer = makeMemory({ memory_id: 'new', tags: ['db', 'testing'], accessed_at: 200, entity_key: 'newer' });
    const cluster = { shared_tags: ['db', 'testing'], memories: [older, newer] };

    const result = applyConsolidation(fakeStore as never, [cluster]);

    assert.equal(result.memories_consolidated, 1);
    assert.equal(result.memories_forgotten, 1);
    assert.equal(upsertCalls.length, 1);
    assert.equal(forgetCalls.length, 1);
    assert.equal(forgetCalls[0], 'old');
  });

  test('returns zero counts for empty clusters array', () => {
    const fakeStore = { upsert: () => 'id', forget: () => true };
    const result = applyConsolidation(fakeStore as never, []);
    assert.equal(result.clusters_processed, 0);
    assert.equal(result.memories_consolidated, 0);
    assert.equal(result.memories_forgotten, 0);
  });
});
