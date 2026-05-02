process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { MemoryStore } from './memory-store.js';
import { getDb } from '../runtime/store/db.js';

function freshStore(): MemoryStore {
  const db = getDb();
  db.prepare('DELETE FROM memories').run();
  return new MemoryStore();
}

describe('lint additional reasons', () => {
  test('lint detects duplicate_entity_key when two active rows share entity_key+workdir', () => {
    // CRITICAL: freshStore() FIRST (it deletes all rows), THEN insert duplicates,
    // otherwise the inserts get wiped before lint() runs.
    const store = freshStore();
    const now = Date.now();
    const db = getDb();
    db.prepare(
      'INSERT INTO memories (memory_id, memory_type, content, tags_json, workdir, token_count, pinned, source_run_id, git_ref, superseded_by, created_at, accessed_at, expires_at, entity_key, sources_json, recall_count, content_hash, memory_source, success_recall_count, trust_level, files_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'm1', 'fact', 'content 1', '[]', '/tmp/test-1', 10, 0, null, null, null, now, now, null, 'same-key', '[]', 0, null, 'unknown', 0, 'unverified', '[]',
    );
    db.prepare(
      'INSERT INTO memories (memory_id, memory_type, content, tags_json, workdir, token_count, pinned, source_run_id, git_ref, superseded_by, created_at, accessed_at, expires_at, entity_key, sources_json, recall_count, content_hash, memory_source, success_recall_count, trust_level, files_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'm2', 'fact', 'content 2', '[]', '/tmp/test-1', 10, 0, null, null, null, now, now, null, 'same-key', '[]', 0, null, 'unknown', 0, 'unverified', '[]',
    );

    const results = store.lint('/tmp/test-1');

    const dupEntry = results.find((e) => e.reason === 'duplicate_entity_key');
    if (!dupEntry) throw new Error('expected a duplicate_entity_key lint entry');
    assert.strictEqual(dupEntry.entity_key, 'same-key');
    assert.ok(dupEntry.memory_ids.length >= 2, `expected at least 2 memory_ids, got ${dupEntry.memory_ids.length}`);
  });

  test('lint returns empty for an empty store', () => {
    const store = freshStore();
    const results = store.lint('/tmp/test-1');
    assert.deepStrictEqual(results, []);
  });

  test('lint returns no duplicate_entity_key when entity_keys are unique', () => {
    const store = freshStore();
    store.upsert({ memory_type: 'fact', content: 'a', tags: [], workdir: '/tmp/test-1', entity_key: 'key-a' });
    store.upsert({ memory_type: 'fact', content: 'b', tags: [], workdir: '/tmp/test-1', entity_key: 'key-b' });
    store.upsert({ memory_type: 'fact', content: 'c', tags: [], workdir: '/tmp/test-1', entity_key: 'key-c' });

    const results = store.lint('/tmp/test-1');
    const dupEntry = results.find((e) => e.reason === 'duplicate_entity_key');
    assert.strictEqual(dupEntry, undefined);
  });

  // TODO: Add test for `contradictory_lessons` lint reason once detection logic is clear from the codebase.
});
