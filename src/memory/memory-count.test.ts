import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';

// MUST be the very first line before any other imports
process.env['RELAY_DB_PATH'] = ':memory:';

import { MemoryStore } from './memory-store.js';

describe('MemoryStore.count() and totalTokens()', () => {
  test('empty store count is 0', () => {
    const store = new MemoryStore();
    // Filter by a unique workdir that no other test uses so the count is always 0
    const emptyDir = '/count-test-empty-' + Date.now();
    assert.strictEqual(store.count(emptyDir), 0);
    assert.strictEqual(store.totalTokens(emptyDir), 0);
  });

  test('count increases by 1 after remember()', () => {
    const store = new MemoryStore();
    const scopeDir = '/count-test-one-' + Date.now();
    store.remember({
      content: 'Test memory',
      memory_type: 'fact',
      workdir: scopeDir,
    });
    assert.strictEqual(store.count(scopeDir), 1);
    // Token count for "Test memory" (11 chars) should be > 0
    assert.ok(store.totalTokens(scopeDir) > 0);
  });

  test('after upsert() with same entity_key, count stays at 1', () => {
    const store = new MemoryStore();
    const scopeDir = '/count-test-upsert-' + Date.now();
    const entityKey = 'unique-upsert-key-' + Date.now();

    store.upsert({
      entity_key: entityKey,
      content: 'First version',
      memory_type: 'fact',
      workdir: scopeDir,
    });
    assert.strictEqual(store.count(scopeDir), 1);

    store.upsert({
      entity_key: entityKey,
      content: 'Second version',
      memory_type: 'fact',
      workdir: scopeDir,
    });
    // Upsert with same entity_key + workdir supersedes the first — count stays at 1
    assert.strictEqual(store.count(scopeDir), 1);
  });

  test('workdir-filtered count only counts entries for that workdir', () => {
    const store = new MemoryStore();
    const suffix = '-' + Date.now();
    const wdirA = '/path/to/workdir-a' + suffix;
    const wdirB = '/path/to/workdir-b' + suffix;
    const wdirNone = '/path/to/nonexistent' + suffix;

    store.remember({
      content: 'Workdir A memory',
      memory_type: 'fact',
      workdir: wdirA,
    });
    store.remember({
      content: 'Workdir B memory',
      memory_type: 'fact',
      workdir: wdirB,
    });

    assert.strictEqual(store.count(wdirA), 1);
    assert.strictEqual(store.count(wdirB), 1);
    assert.strictEqual(store.count(wdirNone), 0);
  });
});
