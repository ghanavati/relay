process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { MemoryStore } from './memory-store.js';
import { getDb } from '../runtime/store/db.js';

function freshStore(): MemoryStore {
  // reset in-memory db
  const db = getDb();
  db.prepare('DELETE FROM memories').run();
  return new MemoryStore();
}

describe('GC methods', () => {
  test('gcByTokenBudget evicts non-pinned entries when over budget', () => {
    const store = freshStore();
    for (let i = 0; i < 5; i++) {
      store.remember({ content: `entry ${i}`, memory_type: 'fact', pinned: false });
    }
    const before = store.count();
    // Budget=1 forces eviction since each entry has at least 1 token
    const evicted = store.gcByTokenBudget(1);
    assert.ok(evicted > 0, `expected at least 1 evicted, got ${evicted}`);
    assert.ok(store.count() < before, `expected count to decrease from ${before}`);
  });

  test('gcByTokenBudget does not evict pinned entries', () => {
    const store = freshStore();
    for (let i = 0; i < 3; i++) {
      store.remember({ content: `pinned ${i}`, memory_type: 'fact', pinned: true });
    }
    for (let i = 0; i < 2; i++) {
      store.remember({ content: `unpinned ${i}`, memory_type: 'fact', pinned: false });
    }
    store.gcByTokenBudget(1000);
    assert.ok(store.count() >= 3);
  });

  test('gcPinned with maxAge=0 evicts all pinned entries', async () => {
    const store = freshStore();
    store.remember({ content: 'pinned 1', memory_type: 'fact', pinned: true });
    store.remember({ content: 'pinned 2', memory_type: 'fact', pinned: true });
    // Sleep so accessed_at < now, otherwise gcPinned(0) sees them as "current"
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const evicted = store.gcPinned(0);
    assert.ok(evicted >= 2, `expected at least 2 evicted, got ${evicted}`);
    assert.strictEqual(store.count(), 0);
  });

  test('gcPinned with large maxAge evicts none', () => {
    const store = freshStore();
    store.remember({ content: 'pinned 1', memory_type: 'fact', pinned: true });
    store.remember({ content: 'pinned 2', memory_type: 'fact', pinned: true });
    const evicted = store.gcPinned(365 * 24 * 60 * 60 * 1000);
    assert.strictEqual(evicted, 0);
    assert.strictEqual(store.count(), 2);
  });

  test('purgeSuperseded removes nothing when no superseded rows exist', () => {
    const store = freshStore();
    store.remember({ content: 'fresh 1', memory_type: 'fact' });
    store.remember({ content: 'fresh 2', memory_type: 'fact' });
    const purged = store.purgeSuperseded(0);
    assert.strictEqual(purged, 0);
  });
});
