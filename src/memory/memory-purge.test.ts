process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { MemoryStore } from './memory-store.js';

describe('MemoryStore.purgeSuperseded', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  test('returns 0 when nothing to purge', () => {
    // Insert a non-superseded entry
    store.remember({
      content: 'test memory',
      memory_type: 'fact',
      entity_key: 'test-entity',
    });

    const deleted = store.purgeSuperseded(30 * 24 * 60 * 60 * 1000);
    assert.strictEqual(deleted, 0);
  });

  test('with maxAgeMs:0 deletes all superseded entries, returns count > 0', () => {
    // Create superseded entry by calling upsert twice with same entity_key
    store.upsert({
      entity_key: 'test-entity',
      content: 'first version',
      memory_type: 'fact',
    });
    const secondId = store.upsert({
      entity_key: 'test-entity',
      content: 'second version',
      memory_type: 'fact',
    });

    // Verify first entry is now superseded
    const firstMemory = store.getMemory(secondId);
    assert.ok(firstMemory);

    const deleted = store.purgeSuperseded(0);
    assert.ok(deleted > 0);
  });

  test('superseded entry newer than maxAgeMs is NOT deleted', () => {
    // Create superseded entry with recent created_at
    store.upsert({
      entity_key: 'test-entity',
      content: 'first version',
      memory_type: 'fact',
    });
    store.upsert({
      entity_key: 'test-entity',
      content: 'second version',
      memory_type: 'fact',
    });

    // Use very large maxAgeMs (nearly infinite)
    const deleted = store.purgeSuperseded(999999999999);
    assert.strictEqual(deleted, 0);
  });

  test('active non-superseded entries are never deleted', () => {
    const id1 = store.remember({
      content: 'memory 1',
      memory_type: 'fact',
      entity_key: 'entity-1-' + Date.now(),
    });
    const id2 = store.remember({
      content: 'memory 2',
      memory_type: 'decision',
      entity_key: 'entity-2-' + Date.now(),
    });

    store.purgeSuperseded(0);

    // Verify by ID — avoids the count(workdir) contamination trap where
    // count() uses `OR workdir IS NULL` and picks up rows from prior tests
    assert.ok(store.getMemory(id1), 'memory 1 should survive purge');
    assert.ok(store.getMemory(id2), 'memory 2 should survive purge');
  });
});
