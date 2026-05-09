process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { MemoryStore } from './memory-store.js';
import { getDb } from '../runtime/store/db.js';

describe('MemoryStore.wipeWorkdir()', () => {
  beforeEach(() => {
    // Isolate: shared :memory: DB persists across tests, so clear before each.
    getDb().prepare('DELETE FROM memories').run();
  });

  test('soft delete marks all active memories for the workdir as superseded', () => {
    const store = new MemoryStore();
    const wd = '/Users/test/project-a';
    const id1 = store.remember({ content: 'first memory', memory_type: 'fact', workdir: wd });
    const id2 = store.remember({ content: 'second memory', memory_type: 'lesson', workdir: wd });
    const otherId = store.remember({ content: 'unrelated', memory_type: 'fact', workdir: '/Users/test/project-b' });

    const result = store.wipeWorkdir(wd);

    assert.strictEqual(result.soft_deleted, 2, 'should report 2 soft-deleted entries');
    assert.strictEqual(result.hard_deleted, 0);
    assert.strictEqual(store.getMemory(id1), null, 'wiped memory must not be retrievable');
    assert.strictEqual(store.getMemory(id2), null, 'wiped memory must not be retrievable');
    assert.ok(store.getMemory(otherId), 'unrelated workdir memory must survive');

    // Audit trail preserved — superseded_by row still exists.
    const auditRow = getDb()
      .prepare('SELECT superseded_by FROM memories WHERE memory_id = ?')
      .get(id1) as { superseded_by: string };
    assert.strictEqual(auditRow.superseded_by, 'wipe-workdir');
  });

  test('hard delete removes rows entirely (no audit trail)', () => {
    const store = new MemoryStore();
    const wd = '/Users/test/project-h';
    const id1 = store.remember({ content: 'memory to nuke', memory_type: 'fact', workdir: wd });
    store.remember({ content: 'another to nuke', memory_type: 'lesson', workdir: wd });

    const result = store.wipeWorkdir(wd, { hard: true });

    assert.strictEqual(result.hard_deleted, 2, 'should hard-delete both rows');
    assert.strictEqual(result.soft_deleted, 0);
    // Row should be gone from the underlying table — not just superseded.
    const row = getDb().prepare('SELECT memory_id FROM memories WHERE memory_id = ?').get(id1);
    assert.strictEqual(row, undefined, 'hard-deleted row must not exist in DB');
  });

  test('hard delete also drains rows previously soft-deleted in this workdir', () => {
    const store = new MemoryStore();
    const wd = '/Users/test/project-mixed';
    const id1 = store.remember({ content: 'soft first', memory_type: 'fact', workdir: wd });
    store.forget(id1); // soft-delete this row
    store.remember({ content: 'still active', memory_type: 'fact', workdir: wd });

    const result = store.wipeWorkdir(wd, { hard: true });

    // Both rows (the previously soft-deleted one + the active one) get hard-deleted.
    assert.ok(result.hard_deleted >= 2, `expected >=2 hard_deleted, got ${result.hard_deleted}`);
    const remaining = getDb()
      .prepare('SELECT COUNT(*) as n FROM memories WHERE workdir = ?')
      .get(wd) as { n: number };
    assert.strictEqual(remaining.n, 0, 'no rows for this workdir should remain');
  });

  test('tag filter narrows wipe to memories carrying that tag', () => {
    const store = new MemoryStore();
    const wd = '/Users/test/project-tag';
    const taggedId = store.remember({
      content: 'pii lesson',
      memory_type: 'lesson',
      workdir: wd,
      tags: ['pii', 'auto'],
    });
    const otherId = store.remember({
      content: 'normal fact',
      memory_type: 'fact',
      workdir: wd,
      tags: ['build'],
    });

    const result = store.wipeWorkdir(wd, { tag: 'pii' });

    assert.strictEqual(result.soft_deleted, 1, 'only the pii-tagged memory should be wiped');
    assert.strictEqual(store.getMemory(taggedId), null, 'pii memory must be gone');
    assert.ok(store.getMemory(otherId), 'untagged memory must survive');
  });

  test('rejects empty workdir', () => {
    const store = new MemoryStore();
    assert.throws(
      () => store.wipeWorkdir(''),
      /requires an explicit workdir/,
    );
  });

  test('rejects wildcard "*" workdir', () => {
    const store = new MemoryStore();
    assert.throws(
      () => store.wipeWorkdir('*'),
      /requires an explicit workdir/,
    );
  });

  test('returns 0/0 when no matching memories exist', () => {
    const store = new MemoryStore();
    const result = store.wipeWorkdir('/Users/test/empty-project');
    assert.strictEqual(result.soft_deleted, 0);
    assert.strictEqual(result.hard_deleted, 0);
  });
});
