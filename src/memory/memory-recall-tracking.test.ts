process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { MemoryStore } from './memory-store.js';
import { getDb } from '../runtime/store/db.js';
import type { Memory } from './types.js';

function freshStore(): MemoryStore {
  const db = getDb();
  db.prepare('DELETE FROM memories').run();
  return new MemoryStore();
}

function mustGet(store: MemoryStore, id: string): Memory {
  const mem = store.getMemory(id);
  if (mem === null) throw new Error(`expected getMemory(${id}) to return a row, got null`);
  return mem;
}

describe('recall tracking + auto-pin', () => {
  test('markRecallSuccess increments success_recall_count by 1 per call', () => {
    const store = freshStore();
    const id = store.remember({ memory_type: 'fact', content: 'test increment' });
    assert.strictEqual(mustGet(store, id).success_recall_count, 0);

    store.markRecallSuccess([id]);
    assert.strictEqual(mustGet(store, id).success_recall_count, 1);

    store.markRecallSuccess([id]);
    assert.strictEqual(mustGet(store, id).success_recall_count, 2);

    store.markRecallSuccess([id]);
    assert.strictEqual(mustGet(store, id).success_recall_count, 3);
  });

  test('markRecallSuccess auto-pins at threshold 3', () => {
    const store = freshStore();
    const id = store.remember({ memory_type: 'fact', content: 'test autopin', pinned: false });
    assert.strictEqual(mustGet(store, id).pinned, false);

    store.markRecallSuccess([id]);
    store.markRecallSuccess([id]);
    store.markRecallSuccess([id]);

    const mem = mustGet(store, id);
    assert.ok(mem.pinned === true, 'should be auto-pinned at threshold 3');
    assert.ok(mem.success_recall_count >= 3, 'success_recall_count should be >= 3');
  });

  test('markRecallSuccess does NOT auto-pin at 2 or fewer', () => {
    const store = freshStore();
    const id = store.remember({ memory_type: 'fact', content: 'test no autopin', pinned: false });

    store.markRecallSuccess([id]);
    store.markRecallSuccess([id]);

    assert.strictEqual(mustGet(store, id).pinned, false);
  });

  test('demoteMemory clears pinned and resets success_recall_count', () => {
    const store = freshStore();
    const id = store.remember({ memory_type: 'fact', content: 'test demote' });

    store.markRecallSuccess([id]);
    store.markRecallSuccess([id]);
    store.markRecallSuccess([id]);
    assert.strictEqual(mustGet(store, id).pinned, true);

    store.demoteMemory(id);

    const mem = mustGet(store, id);
    assert.strictEqual(mem.pinned, false);
    assert.strictEqual(mem.success_recall_count, 0);
  });

  test('touchMemories increments recall_count', () => {
    const store = freshStore();
    const id = store.remember({ memory_type: 'fact', content: 'test touch' });
    const initial = mustGet(store, id).recall_count;

    store.touchMemories([id]);
    assert.strictEqual(mustGet(store, id).recall_count, initial + 1);

    store.touchMemories([id]);
    assert.strictEqual(mustGet(store, id).recall_count, initial + 2);
  });

  test('touchMemories updates accessed_at to a recent timestamp', async () => {
    const store = freshStore();
    const id = store.remember({ memory_type: 'fact', content: 'test touch time' });
    const initialAccessedAt = mustGet(store, id).accessed_at;

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    store.touchMemories([id]);
    const mem = mustGet(store, id);
    assert.ok(mem.accessed_at >= initialAccessedAt + 50, `accessed_at should advance: was ${initialAccessedAt}, now ${mem.accessed_at}`);
  });
});

describe('T2: --min-trust recall filter', () => {
  test('min_trust=provisional excludes unverified auto-extracted entries', () => {
    const store = freshStore();

    // Unverified: auto-source, no successful recalls, not pinned
    const unverifiedId = store.remember({
      memory_type: 'fact',
      content: 'unverified auto-extracted entry',
      memory_source: 'auto-run-recorder',
    });
    // Stamp the trust_level column (computed lazily otherwise) so the SQL filter can match
    store.upgradeTrust(unverifiedId);

    // Provisional: human-source counts as provisional immediately
    const provisionalId = store.remember({
      memory_type: 'fact',
      content: 'human-written provisional entry',
      memory_source: 'human',
    });
    store.upgradeTrust(provisionalId);

    // Trusted: human-pinned counts as trusted
    const trustedId = store.remember({
      memory_type: 'fact',
      content: 'human-pinned trusted entry',
      memory_source: 'human',
      pinned: true,
    });
    store.upgradeTrust(trustedId);

    // Default (no min_trust) returns all 3
    const allCandidates = store.getCandidates({ token_budget: 4000, workdir: '*' });
    const allIds = new Set(allCandidates.map(m => m.memory_id));
    assert.ok(allIds.has(unverifiedId), 'default recall should include unverified');
    assert.ok(allIds.has(provisionalId), 'default recall should include provisional');
    assert.ok(allIds.has(trustedId), 'default recall should include trusted');

    // min_trust=provisional must exclude unverified
    const filtered = store.getCandidates({ token_budget: 4000, workdir: '*', min_trust: 'provisional' });
    const filteredIds = new Set(filtered.map(m => m.memory_id));
    assert.ok(!filteredIds.has(unverifiedId), 'provisional filter should exclude unverified');
    assert.ok(filteredIds.has(provisionalId), 'provisional filter should include provisional');
    assert.ok(filteredIds.has(trustedId), 'provisional filter should include trusted');
  });

  test('min_trust=trusted only returns trusted entries', () => {
    const store = freshStore();

    const unverifiedId = store.remember({
      memory_type: 'fact',
      content: 'unverified entry t',
      memory_source: 'auto-run-recorder',
    });
    store.upgradeTrust(unverifiedId);

    const provisionalId = store.remember({
      memory_type: 'fact',
      content: 'provisional entry t',
      memory_source: 'human',
    });
    store.upgradeTrust(provisionalId);

    const trustedId = store.remember({
      memory_type: 'fact',
      content: 'trusted entry t',
      memory_source: 'human',
      pinned: true,
    });
    store.upgradeTrust(trustedId);

    const onlyTrusted = store.getCandidates({ token_budget: 4000, workdir: '*', min_trust: 'trusted' });
    const ids = new Set(onlyTrusted.map(m => m.memory_id));
    assert.ok(!ids.has(unverifiedId), 'trusted filter should exclude unverified');
    assert.ok(!ids.has(provisionalId), 'trusted filter should exclude provisional');
    assert.ok(ids.has(trustedId), 'trusted filter should include trusted');
  });

  test('min_trust=unverified is the default — no filter applied', () => {
    const store = freshStore();

    const unverifiedId = store.remember({
      memory_type: 'fact',
      content: 'unverified default test',
      memory_source: 'auto-run-recorder',
    });
    store.upgradeTrust(unverifiedId);

    const result = store.getCandidates({ token_budget: 4000, workdir: '*', min_trust: 'unverified' });
    const ids = new Set(result.map(m => m.memory_id));
    assert.ok(ids.has(unverifiedId), 'unverified filter must include unverified entries');
  });
});
