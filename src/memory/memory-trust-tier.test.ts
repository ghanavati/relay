process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { MemoryStore, computeTrustLevel } from './memory-store.js';

describe('SHIP-67: computeTrustLevel pure function', () => {
  test('human + pinned = trusted', () => {
    assert.strictEqual(computeTrustLevel('human', 0, true), 'trusted');
  });

  test('any source with >= 3 successful recalls = trusted', () => {
    assert.strictEqual(computeTrustLevel('worker-mcp', 3, false), 'trusted');
    assert.strictEqual(computeTrustLevel('auto-run-recorder', 5, false), 'trusted');
  });

  test('human source (unpinned, 0 recalls) = provisional', () => {
    assert.strictEqual(computeTrustLevel('human', 0, false), 'provisional');
  });

  test('non-human with 1 successful recall = provisional', () => {
    assert.strictEqual(computeTrustLevel('auto-run-recorder', 1, false), 'provisional');
  });

  test('non-human, 0 recalls = unverified (the default)', () => {
    assert.strictEqual(computeTrustLevel('auto-run-recorder', 0, false), 'unverified');
    assert.strictEqual(computeTrustLevel('worker-mcp', 0, false), 'unverified');
    assert.strictEqual(computeTrustLevel('unknown', 0, false), 'unverified');
  });
});

describe('SHIP-67: rowToMemory derives trust_level on read', () => {
  test('freshly-written auto-run-recorder memory is unverified', () => {
    const store = new MemoryStore();
    const id = store.remember({
      content: 'freshly auto-written lesson',
      memory_type: 'lesson',
      memory_source: 'auto-run-recorder',
    });
    const mem = store.getMemory(id);
    assert.ok(mem);
    assert.strictEqual(mem.trust_level, 'unverified');
  });

  test('human-pinned memory comes back trusted', () => {
    const store = new MemoryStore();
    const id = store.remember({
      content: 'important human decision',
      memory_type: 'decision',
      memory_source: 'human',
      pinned: true,
    });
    const mem = store.getMemory(id);
    assert.ok(mem);
    assert.strictEqual(mem.trust_level, 'trusted');
  });

  test('upgradeTrust() writes computed level back to DB column', () => {
    const store = new MemoryStore();
    const id = store.remember({
      content: 'will become provisional after one recall',
      memory_type: 'lesson',
      memory_source: 'auto-run-recorder',
    });
    // Simulate one successful recall
    store.markRecallSuccess([id]);
    store.upgradeTrust(id);
    const mem = store.getMemory(id);
    assert.ok(mem);
    assert.strictEqual(mem.trust_level, 'provisional');
  });
});
