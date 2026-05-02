process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { MemoryStore } from './memory-store.js';

describe('MemoryStore.remember()', () => {
  test('returns non-empty string id', () => {
    const store = new MemoryStore();
    const id = store.remember({
      content: 'Test memory content',
      memory_type: 'fact',
    });
    assert.ok(id);
    assert.strictEqual(typeof id, 'string');
    assert.ok(id.length > 0);
  });

  test('stored memory retrievable via getMemory(id)', () => {
    const store = new MemoryStore();
    const id = store.remember({
      content: 'Test memory content',
      memory_type: 'fact',
    });

    const memory = store.getMemory(id);
    assert.ok(memory);
    assert.strictEqual(memory?.content, 'Test memory content');
    assert.strictEqual(memory?.memory_id, id);
    assert.strictEqual(memory?.memory_type, 'fact');
  });

  test('token_count = ceil(content.length/4)', () => {
    const store = new MemoryStore();
    const content = 'a'.repeat(100); // 100 chars -> ceil(100/4) = 25
    const id = store.remember({
      content,
      memory_type: 'fact',
    });

    const memory = store.getMemory(id);
    assert.ok(memory);
    assert.strictEqual(memory?.token_count, 25);
  });

  test('tags default to [] (plus SHIP-59 auto-extracted keywords) when not provided', () => {
    const store = new MemoryStore();
    const id = store.remember({
      content: 'xyz',
      memory_type: 'fact',
    });

    const memory = store.getMemory(id);
    assert.ok(memory);
    // SHIP-59: content 'xyz' is <= 3 chars → extractKeywords() drops it → tags stay empty
    assert.deepStrictEqual(memory?.tags, []);
  });

  test('pinned defaults to false', () => {
    const store = new MemoryStore();
    const id = store.remember({
      content: 'Test memory content',
      memory_type: 'fact',
    });

    const memory = store.getMemory(id);
    assert.ok(memory);
    assert.strictEqual(memory?.pinned, false);
  });
});
