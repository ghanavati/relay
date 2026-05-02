process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { MemoryStore } from './memory-store.js';

describe('MemoryStore.forget()', () => {
  test('returns true when memory exists', () => {
    const store = new MemoryStore();
    const id = store.remember({
      content: 'Test memory',
      memory_type: 'fact',
    });
    const result = store.forget(id);
    assert.strictEqual(result, true);
  });

  test('returns false for non-existent id', () => {
    const store = new MemoryStore();
    const result = store.forget('non-existent-id');
    assert.strictEqual(result, false);
  });

  test('after forget() getMemory(id) returns null', () => {
    const store = new MemoryStore();
    const id = store.remember({
      content: 'Test memory',
      memory_type: 'fact',
    });
    store.forget(id);
    const memory = store.getMemory(id);
    assert.strictEqual(memory, null);
  });

  test('after forget() count() decreases by 1', () => {
    const store = new MemoryStore();
    const id = store.remember({
      content: 'Test memory',
      memory_type: 'fact',
    });
    const beforeCount = store.count();
    store.forget(id);
    const afterCount = store.count();
    assert.strictEqual(beforeCount - afterCount, 1);
  });
});
