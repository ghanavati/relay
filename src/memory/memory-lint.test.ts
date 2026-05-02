import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';

// MUST BE THE VERY FIRST LINE - sets in-memory SQLite before getDb() is called
process.env['RELAY_DB_PATH'] = ':memory:';

import { MemoryStore } from './memory-store.js';
import { getDb } from '../runtime/store/db.js';

describe('MemoryStore.lint()', () => {
  test('empty store returns []', () => {
    const store = new MemoryStore();
    // Pass a unique workdir that no other test uses so global rows don't bleed in
    const emptyDir = '/lint-empty-' + Date.now();
    const result = store.lint(emptyDir);
    assert.deepStrictEqual(result, []);
  });

  test('a stale auto entry (tags includes auto, not pinned, accessed_at set to 60 days ago) appears in results with reason stale_auto_entry', () => {
    const store = new MemoryStore();
    const sixtyDaysAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;
    const scopeDir = '/lint-stale-auto-' + Date.now();

    const staleId = store.remember({
      content: 'This is a stale auto-written entry',
      memory_type: 'lesson',
      tags: ['auto'],
      pinned: false,
      workdir: scopeDir,
    });
    getDb().prepare('UPDATE memories SET accessed_at = ? WHERE memory_id = ?')
      .run(sixtyDaysAgo, staleId);

    const result = store.lint(scopeDir);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].reason, 'stale_auto_entry');
    assert.strictEqual(result[0].entity_key, null);
    assert.ok(result[0].suggestion.includes('auto-written entries'));
  });

  test('a fresh auto entry (accessed_at = now) does NOT appear', () => {
    const store = new MemoryStore();
    const scopeDir = '/lint-fresh-auto-' + Date.now();

    const freshId = store.remember({
      content: 'This is a fresh auto-written entry',
      memory_type: 'lesson',
      tags: ['auto'],
      pinned: false,
      workdir: scopeDir,
    });
    getDb().prepare('UPDATE memories SET accessed_at = ? WHERE memory_id = ?')
      .run(Date.now(), freshId);

    const result = store.lint(scopeDir);
    assert.deepStrictEqual(result, []);
  });

  test('a stale pinned entry (> 30 days) appears with reason stale_pinned_entry', () => {
    const store = new MemoryStore();
    const sixtyDaysAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;
    const scopeDir = '/lint-pinned-' + Date.now();

    const pinnedId = store.remember({
      content: 'This is a pinned auto-written entry',
      memory_type: 'lesson',
      tags: ['auto'],
      pinned: true,
      workdir: scopeDir,
    });
    getDb().prepare('UPDATE memories SET accessed_at = ? WHERE memory_id = ?')
      .run(sixtyDaysAgo, pinnedId);

    const result = store.lint(scopeDir);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].reason, 'stale_pinned_entry');
  });
});
