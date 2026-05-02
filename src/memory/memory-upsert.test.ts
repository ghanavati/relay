process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { MemoryStore } from './memory-store.js';

describe('MemoryStore.upsert()', () => {
  test('first upsert with entity_key creates one entry, count()=1', () => {
    const store = new MemoryStore();
    const id = store.upsert({
      entity_key: 'test-entity',
      content: 'test content',
      memory_type: 'fact',
    });
    assert.ok(id);
    assert.strictEqual(store.count(), 1);
    const memory = store.getMemory(id);
    assert.ok(memory);
    assert.strictEqual(memory.entity_key, 'test-entity');
    assert.strictEqual(memory.content, 'test content');
  });

  test('second upsert with same entity_key keeps count at 1 (old superseded)', () => {
    const store = new MemoryStore();
    const id1 = store.upsert({
      entity_key: 'test-entity',
      content: 'first content',
      memory_type: 'fact',
    });
    const id2 = store.upsert({
      entity_key: 'test-entity',
      content: 'second content',
      memory_type: 'fact',
    });
    assert.ok(id1);
    assert.ok(id2);
    assert.strictEqual(id1 !== id2, true);
    assert.strictEqual(store.count(), 1);
    const memory = store.getMemory(id2);
    assert.ok(memory);
    assert.strictEqual(memory.content, 'second content');
  });

  test('second upsert returns a different memory_id', () => {
    const store = new MemoryStore();
    const id1 = store.upsert({
      entity_key: 'test-entity',
      content: 'first content',
      memory_type: 'fact',
    });
    const id2 = store.upsert({
      entity_key: 'test-entity',
      content: 'second content',
      memory_type: 'fact',
    });
    assert.ok(id1);
    assert.ok(id2);
    assert.strictEqual(id1 === id2, false);
  });

  test('getMemory() on the OLD id returns null after upsert', () => {
    const store = new MemoryStore();
    const id1 = store.upsert({
      entity_key: 'test-entity',
      content: 'first content',
      memory_type: 'fact',
    });
    store.upsert({
      entity_key: 'test-entity',
      content: 'second content',
      memory_type: 'fact',
    });
    const oldMemory = store.getMemory(id1);
    assert.strictEqual(oldMemory, null);
  });
});
