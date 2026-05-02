process.env['RELAY_DB_PATH'] = ':memory:';
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { MemoryStore } from './memory-store.js';

describe('MemoryStore.touchMemories', () => {
  test('updates accessed_at to approximately now', () => {
    const store = new MemoryStore();
    const before = Date.now() - 10_000;
    const id = store.remember({ content: 'touch test', memory_type: 'fact', accessed_at: before } as never);
    store.touchMemories([id]);
    const mem = store.getMemory(id);
    assert.ok(mem !== null);
    assert.ok(mem.accessed_at >= Date.now() - 1000);
  });

  test('empty array does not throw', () => {
    const store = new MemoryStore();
    assert.doesNotThrow(() => store.touchMemories([]));
  });

  test('non-existent id does not throw', () => {
    const store = new MemoryStore();
    assert.doesNotThrow(() => store.touchMemories(['non-existent-id']));
  });
});
