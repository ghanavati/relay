process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { MemoryStore } from './memory-store.js';
import { getDb } from '../runtime/store/db.js';

describe('MemoryStore.forget() — soft (default)', () => {
  test('returns {found: true, mode: "soft"} when memory exists', () => {
    const store = new MemoryStore();
    const id = store.remember({ content: 'soft target', memory_type: 'fact' });
    const result = store.forget(id);
    assert.deepStrictEqual(result, { found: true, mode: 'soft' });
  });

  test('returns {found: false, mode: "soft"} for non-existent id', () => {
    const store = new MemoryStore();
    const result = store.forget('nonexistent-' + Date.now());
    assert.deepStrictEqual(result, { found: false, mode: 'soft' });
  });

  test('after soft forget(), getMemory(id) returns null', () => {
    const store = new MemoryStore();
    const id = store.remember({ content: 'soft hides from get', memory_type: 'fact' });
    store.forget(id);
    assert.strictEqual(store.getMemory(id), null);
  });

  test('after soft forget(), count() decreases by 1', () => {
    const store = new MemoryStore();
    const id = store.remember({ content: 'soft drops count', memory_type: 'fact' });
    const before = store.count();
    store.forget(id);
    assert.strictEqual(before - store.count(), 1);
  });

  test('soft sets superseded_by = "forget" (audit-preserving marker)', () => {
    const store = new MemoryStore();
    const id = store.remember({ content: 'soft marker check', memory_type: 'fact' });
    store.forget(id);
    const row = getDb()
      .prepare('SELECT superseded_by FROM memories WHERE memory_id = ?')
      .get(id) as { superseded_by: string | null } | undefined;
    assert.ok(row, 'soft-deleted row must still exist physically');
    assert.strictEqual(row.superseded_by, 'forget');
  });

  test('soft forget() on already-superseded id returns found: false', () => {
    const store = new MemoryStore();
    const id = store.remember({ content: 'double soft', memory_type: 'fact' });
    const first = store.forget(id);
    assert.strictEqual(first.found, true);
    const second = store.forget(id);
    assert.deepStrictEqual(second, { found: false, mode: 'soft' });
  });
});

describe('MemoryStore.forget() — hard', () => {
  test('returns {found: true, mode: "hard"} when memory exists', () => {
    const store = new MemoryStore();
    const id = store.remember({ content: 'hard target', memory_type: 'fact' });
    const result = store.forget(id, { hard: true });
    assert.deepStrictEqual(result, { found: true, mode: 'hard' });
  });

  test('returns {found: false, mode: "hard"} for non-existent id', () => {
    const store = new MemoryStore();
    const result = store.forget('nonexistent-hard-' + Date.now(), { hard: true });
    assert.deepStrictEqual(result, { found: false, mode: 'hard' });
  });

  test('hard forget physically removes the row from memories table', () => {
    const store = new MemoryStore();
    const id = store.remember({ content: 'hard wipes row', memory_type: 'fact' });
    store.forget(id, { hard: true });
    const row = getDb()
      .prepare('SELECT memory_id FROM memories WHERE memory_id = ?')
      .get(id) as { memory_id: string } | undefined;
    assert.strictEqual(row, undefined);
  });

  test('hard forget removes entry from FTS index (delete trigger fires)', () => {
    const store = new MemoryStore();
    const uniqueToken = 'jellyfish_quark_' + Date.now();
    const id = store.remember({
      content: `the ${uniqueToken} is a unique searchable token`,
      memory_type: 'fact',
    });

    const db = getDb();
    const beforeFts = db
      .prepare('SELECT COUNT(*) as n FROM memories_fts WHERE memories_fts MATCH ?')
      .get(uniqueToken) as { n: number };
    assert.ok(beforeFts.n >= 1, 'FTS should index the new memory');

    store.forget(id, { hard: true });

    const afterFts = db
      .prepare('SELECT COUNT(*) as n FROM memories_fts WHERE memories_fts MATCH ?')
      .get(uniqueToken) as { n: number };
    assert.strictEqual(afterFts.n, 0, 'FTS row must be cleaned by delete trigger');
  });

  test('hard forget on a previously soft-forgotten row still removes it', () => {
    const store = new MemoryStore();
    const id = store.remember({ content: 'soft then hard', memory_type: 'fact' });
    store.forget(id);
    const result = store.forget(id, { hard: true });
    assert.deepStrictEqual(result, { found: true, mode: 'hard' });
    const row = getDb()
      .prepare('SELECT memory_id FROM memories WHERE memory_id = ?')
      .get(id) as { memory_id: string } | undefined;
    assert.strictEqual(row, undefined);
  });
});
