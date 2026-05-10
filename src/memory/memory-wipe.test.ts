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

  // T7: workdir literal-match — `_` in the workdir argument must NOT match
  // arbitrary single-character substitutes (which is what an unescaped LIKE
  // would do). The SQL uses `workdir = ?` (equality), so this passes even
  // without escaping; the test guards against accidental regression to LIKE.
  test('underscore in workdir matches only the literal path (not any single char)', () => {
    const store = new MemoryStore();
    const target = '/tmp/foo_bar';
    const decoy = '/tmp/fooXbar'; // would match `/tmp/foo_bar` under naive LIKE
    const targetId = store.remember({ content: 'target', memory_type: 'fact', workdir: target });
    const decoyId = store.remember({ content: 'decoy', memory_type: 'fact', workdir: decoy });

    const result = store.wipeWorkdir(target);

    assert.strictEqual(result.soft_deleted, 1, 'only the literal workdir should be wiped');
    assert.strictEqual(store.getMemory(targetId), null, 'target must be gone');
    assert.ok(store.getMemory(decoyId), 'decoy with `X` instead of `_` must survive');
  });

  test('percent in workdir matches only the literal path (not any substring)', () => {
    const store = new MemoryStore();
    const target = '/tmp/foo%bar';
    const decoy = '/tmp/fooanybar'; // would match `/tmp/foo%bar` under naive LIKE
    const targetId = store.remember({ content: 'target', memory_type: 'fact', workdir: target });
    const decoyId = store.remember({ content: 'decoy', memory_type: 'fact', workdir: decoy });

    const result = store.wipeWorkdir(target);

    assert.strictEqual(result.soft_deleted, 1, 'only the literal workdir should be wiped');
    assert.strictEqual(store.getMemory(targetId), null, 'target must be gone');
    assert.ok(store.getMemory(decoyId), 'decoy with `any` instead of `%` must survive');
  });

  // T7: tag clause IS a LIKE — the escape must prevent `_` and `%` in the tag
  // argument from matching unintended tags.
  test('underscore in tag matches only the literal tag (not any single char)', () => {
    const store = new MemoryStore();
    const wd = '/Users/test/project-tag-underscore';
    const targetId = store.remember({
      content: 'target',
      memory_type: 'fact',
      workdir: wd,
      tags: ['pi_'],
    });
    const decoyId = store.remember({
      content: 'decoy',
      memory_type: 'fact',
      workdir: wd,
      tags: ['pii'], // naive LIKE on `pi_` would match this
    });

    const result = store.wipeWorkdir(wd, { tag: 'pi_' });

    assert.strictEqual(result.soft_deleted, 1, 'only the literal `pi_` tag should be wiped');
    assert.strictEqual(store.getMemory(targetId), null, 'pi_ memory must be gone');
    assert.ok(store.getMemory(decoyId), 'pii memory must survive');
  });

  test('percent in tag matches only the literal tag (not any substring)', () => {
    const store = new MemoryStore();
    const wd = '/Users/test/project-tag-percent';
    const targetId = store.remember({
      content: 'target',
      memory_type: 'fact',
      workdir: wd,
      tags: ['rate%limit'],
    });
    const decoyId = store.remember({
      content: 'decoy',
      memory_type: 'fact',
      workdir: wd,
      tags: ['rateXlimit'], // naive LIKE on `rate%limit` would match this
    });

    const result = store.wipeWorkdir(wd, { tag: 'rate%limit' });

    assert.strictEqual(result.soft_deleted, 1, 'only the literal `rate%limit` tag should be wiped');
    assert.strictEqual(store.getMemory(targetId), null, 'rate%limit memory must be gone');
    assert.ok(store.getMemory(decoyId), 'rateXlimit memory must survive');
  });
});
