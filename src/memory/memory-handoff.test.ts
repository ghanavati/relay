process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { MemoryStore } from './memory-store.js';
import { getDb } from '../runtime/store/db.js';

describe('MemoryStore.getLatestHandoff', () => {
  test('returns null when no handoff exists', () => {
    const store = new MemoryStore();
    // Use a unique workdir so handoffs from other tests don't bleed in
    const emptyDir = '/handoff-empty-' + Date.now();
    const result = store.getLatestHandoff(emptyDir);
    assert.strictEqual(result, null);
  });

  test('returns most recent handoff when multiple exist', () => {
    const store = new MemoryStore();
    const now = Date.now();
    const scopeDir = '/handoff-recency-' + now;
    const olderId = store.remember({
      content: 'older handoff',
      memory_type: 'handoff',
      workdir: scopeDir,
    });
    getDb().prepare('UPDATE memories SET created_at = ?, accessed_at = ? WHERE memory_id = ?')
      .run(now - 1000, now - 1000, olderId);
    const latestId = store.remember({
      content: 'newer handoff',
      memory_type: 'handoff',
      workdir: scopeDir,
    });
    getDb().prepare('UPDATE memories SET created_at = ?, accessed_at = ? WHERE memory_id = ?')
      .run(now, now, latestId);

    const result = store.getLatestHandoff(scopeDir);
    assert.ok(result);
    assert.strictEqual(result.memory_id, latestId);
    assert.strictEqual(result.content, 'newer handoff');
  });

  test('workdir filter returns handoff for that workdir not another', () => {
    const store = new MemoryStore();
    const suffix = '-' + Date.now();
    const wdirA = 'workdirA' + suffix;
    const wdirB = 'workdirB' + suffix;
    const wdirC = 'workdirC' + suffix;
    store.remember({
      content: 'handoff for workdirA',
      memory_type: 'handoff',
      workdir: wdirA,
    });
    const expectedId = store.remember({
      content: 'handoff for workdirB',
      memory_type: 'handoff',
      workdir: wdirB,
    });
    store.remember({
      content: 'handoff for workdirC',
      memory_type: 'handoff',
      workdir: wdirC,
    });

    const result = store.getLatestHandoff(wdirB);
    assert.ok(result);
    assert.strictEqual(result.memory_id, expectedId);
    assert.strictEqual(result.workdir, wdirB);
    assert.strictEqual(result.content, 'handoff for workdirB');
  });

  test('superseded handoff entries not returned', () => {
    const store = new MemoryStore();
    const scopeDir = '/handoff-superseded-' + Date.now();
    const oldId = store.remember({
      content: 'old handoff',
      memory_type: 'handoff',
      workdir: scopeDir,
    });
    store.forget(oldId);
    const newId = store.remember({
      content: 'new handoff',
      memory_type: 'handoff',
      workdir: scopeDir,
    });

    const result = store.getLatestHandoff(scopeDir);
    assert.ok(result);
    assert.strictEqual(result.memory_id, newId);
    assert.strictEqual(result.content, 'new handoff');
  });
});
