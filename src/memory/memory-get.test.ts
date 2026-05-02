process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { MemoryStore } from './memory-store.js';
import { getDb } from '../runtime/store/db.js';

describe('MemoryStore.getMemory()', () => {
  beforeEach(() => {
    // Isolate from cross-file pollution in shared :memory: singleton
    getDb().prepare('DELETE FROM memories').run();
  });

  test('returns null for non-existent id', () => {
    const store = new MemoryStore();
    const result = store.getMemory('non-existent-id');
    assert.strictEqual(result, null);
  });

  test('returns correct Memory object for known id', () => {
    const store = new MemoryStore();
    const id = store.remember({
      content: 'Test content',
      memory_type: 'fact',
      tags: ['tag1', 'tag2'],
    });

    const result = store.getMemory(id);
    assert.notStrictEqual(result, null);
    assert.strictEqual(result!.memory_id, id);
    assert.strictEqual(result!.content, 'Test content');
    assert.strictEqual(result!.memory_type, 'fact');
    // SHIP-59: tags include caller-provided tags + auto-extracted keywords from content
    assert.ok(result!.tags.includes('tag1'));
    assert.ok(result!.tags.includes('tag2'));
  });

  test('returns null for superseded entry', () => {
    const store = new MemoryStore();
    const firstId = store.upsert({
      entity_key: 'test-entity',
      content: 'First version',
      memory_type: 'fact',
    });

    const secondId = store.upsert({
      entity_key: 'test-entity',
      content: 'Second version',
      memory_type: 'fact',
    });

    const firstResult = store.getMemory(firstId);
    const secondResult = store.getMemory(secondId);

    assert.strictEqual(firstResult, null);
    assert.notStrictEqual(secondResult, null);
    assert.strictEqual(secondResult!.content, 'Second version');
  });

  test('returned object has all required fields present and non-undefined', () => {
    const store = new MemoryStore();
    const id = store.remember({
      content: 'Test content',
      memory_type: 'decision',
      tags: ['test'],
      workdir: '/some/workdir',
      pinned: true,
      source_run_id: 'run-123',
      git_ref: 'abc123',
      expires_at: Date.now() + 1000000,
      entity_key: 'test-entity',
      sources: ['https://example.com'],
    });

    const result = store.getMemory(id);
    assert.notStrictEqual(result, null);

    const memory = result!;
    assert.strictEqual(typeof memory.memory_id, 'string');
    assert.strictEqual(memory.memory_id, id);
    assert.strictEqual(memory.memory_type, 'decision');
    assert.strictEqual(memory.content, 'Test content');
    // SHIP-59: caller tag preserved; auto-extracted keywords may also be present
    assert.ok(memory.tags.includes('test'));
    assert.strictEqual(memory.workdir, '/some/workdir');
    assert.strictEqual(typeof memory.token_count, 'number');
    assert.strictEqual(memory.pinned, true);
    assert.strictEqual(memory.source_run_id, 'run-123');
    assert.strictEqual(memory.git_ref, 'abc123');
    assert.strictEqual(typeof memory.created_at, 'number');
    assert.strictEqual(typeof memory.accessed_at, 'number');
    assert.strictEqual(memory.expires_at, Date.now() + 1000000);
    assert.strictEqual(memory.entity_key, 'test-entity');
    assert.deepStrictEqual(memory.sources, ['https://example.com']);
  });
});
