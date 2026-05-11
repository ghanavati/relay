process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { MemoryStore, computeTrustLevel } from './memory-store.js';
import { getDb } from '../runtime/store/db.js';

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

describe('T14: trust-tier fence — auto-extract tag exempt from autoPin', () => {
  test('auto-run-recorder entry WITHOUT auto-extract tag still auto-pins to trusted after AUTOPIN_THRESHOLD recalls', () => {
    const store = new MemoryStore();
    const id = store.remember({
      content: 'recorded from successful run, no auto-extract tag',
      memory_type: 'lesson',
      memory_source: 'auto-run-recorder',
      tags: ['some-other-tag'],
    });
    // 3 successful recalls — should auto-pin and become trusted
    store.markRecallSuccess([id]);
    store.markRecallSuccess([id]);
    store.markRecallSuccess([id]);
    store.upgradeTrust(id);
    const mem = store.getMemory(id);
    assert.ok(mem);
    assert.strictEqual(mem.pinned, true, 'expected unpinned auto-run-recorder entry to auto-pin after 3 recalls');
    assert.strictEqual(mem.trust_level, 'trusted', 'expected trust to graduate to trusted');
  });

  test('auto-extracted entry (tag auto-extract) does NOT auto-pin even after 3 recalls', () => {
    const store = new MemoryStore();
    const id = store.remember({
      content: 'extracted from transcript — must never auto-graduate',
      memory_type: 'lesson',
      memory_source: 'auto-run-recorder',
      tags: ['auto-extract'],
    });
    // 3 successful recalls — pin must remain off and trust must stay provisional
    store.markRecallSuccess([id]);
    store.markRecallSuccess([id]);
    store.markRecallSuccess([id]);
    store.upgradeTrust(id);
    const mem = store.getMemory(id);
    assert.ok(mem);
    assert.strictEqual(mem.pinned, false, 'auto-extract tagged entry must NOT auto-pin (memory poisoning fence)');
    // success_recall_count is 3, but the tag fence keeps pinned=0; computeTrustLevel
    // returns 'trusted' purely from successRecallCount >= AUTOPIN_THRESHOLD.
    // The fence is at the *pin* layer, not the trust-level computation. The pin
    // gate is what makes the entry GC-eligible and excludable; trust_level being
    // 'trusted' is acceptable here because the un-pinned status keeps it evictable.
    // Document this contract explicitly:
    assert.strictEqual(
      mem.trust_level,
      'trusted',
      'computeTrustLevel still returns trusted at >=AUTOPIN_THRESHOLD recalls; the fence is the pin, not the trust label'
    );
  });

  test('auto-extract tag remains unpinned even when mixed with other tags', () => {
    const store = new MemoryStore();
    const id = store.remember({
      content: 'extracted lesson with extra tags',
      memory_type: 'lesson',
      memory_source: 'auto-run-recorder',
      tags: ['lesson', 'auto-extract', 'topic:db'],
    });
    store.markRecallSuccess([id]);
    store.markRecallSuccess([id]);
    store.markRecallSuccess([id]);
    const mem = store.getMemory(id);
    assert.ok(mem);
    assert.strictEqual(mem.pinned, false, 'tag fence must match auto-extract anywhere in the tags array');
  });
});

/**
 * P2 codex finding #4 — `trust_level` column must stay in sync with
 * `computeTrustLevel(memory_source, success_recall_count, pinned)`.
 *
 * Without these tests, a memory promoted via markRecallSuccess() or upsert()
 * keeps a stale `trust_level` column, and the --min-trust=provisional SQL
 * filter (memory-store.ts:663-665) excludes memories that are provisional
 * in reality. Inspect the persisted column directly so we catch the bug
 * even if rowToMemory() happens to recompute trust on read.
 */
describe('P2 codex #4: trust_level persists in sync with markRecallSuccess + upsert', () => {
  /** Bypass rowToMemory() — read the raw column the SQL filter actually uses. */
  function readPersistedTrustLevel(memoryId: string): string {
    const db = getDb();
    const row = db
      .prepare('SELECT trust_level FROM memories WHERE memory_id = ?')
      .get(memoryId) as { trust_level: string } | undefined;
    if (!row) throw new Error(`expected row for ${memoryId}, got undefined`);
    return row.trust_level;
  }

  test('A: markRecallSuccess writes computed trust_level back to the persisted column', () => {
    const store = new MemoryStore();
    const id = store.remember({
      memory_type: 'fact',
      content: 'persisted-trust auto entry',
      memory_source: 'auto-run-recorder',
    });
    // Auto + 0 recalls + unpinned → unverified at insert time.
    assert.strictEqual(readPersistedTrustLevel(id), 'unverified');

    // 1 recall → provisional (auto-run-recorder with >=1 success).
    store.markRecallSuccess([id]);
    assert.strictEqual(readPersistedTrustLevel(id), 'provisional');

    // 4 more recalls → 5 total. >= AUTOPIN_THRESHOLD (3) → trusted.
    store.markRecallSuccess([id]);
    store.markRecallSuccess([id]);
    store.markRecallSuccess([id]);
    store.markRecallSuccess([id]);
    assert.strictEqual(readPersistedTrustLevel(id), 'trusted');
  });

  test('B: upsert recomputes trust_level when pinning state changes', () => {
    const store = new MemoryStore();
    // Human-source, unpinned → provisional from computeTrustLevel rules.
    const id1 = store.upsert({
      entity_key: 'p2-trust-test-entity',
      content: 'human entry, unpinned first',
      memory_type: 'fact',
      memory_source: 'human',
      pinned: false,
    });
    assert.strictEqual(
      readPersistedTrustLevel(id1),
      'provisional',
      'human + unpinned should persist as provisional, not unverified default'
    );

    // Re-upsert with pinned=true → computeTrustLevel('human', 0, true) === 'trusted'.
    const id2 = store.upsert({
      entity_key: 'p2-trust-test-entity',
      content: 'human entry, now pinned',
      memory_type: 'fact',
      memory_source: 'human',
      pinned: true,
    });
    assert.notStrictEqual(id1, id2, 'upsert must mint a new id when superseding');
    assert.strictEqual(
      readPersistedTrustLevel(id2),
      'trusted',
      'human + pinned should persist as trusted on upsert'
    );
  });

  test('C: --min-trust=provisional filter returns auto memory after a single recall (regression)', () => {
    const store = new MemoryStore();
    const id = store.remember({
      memory_type: 'fact',
      content: 'auto memory promoted to provisional by recall',
      memory_source: 'auto-run-recorder',
      workdir: '/p2-trust-filter',
    });
    // One successful recall should promote auto-run-recorder to provisional
    // AND persist that change so the SQL filter accepts it.
    store.markRecallSuccess([id]);

    const filtered = store.getCandidates({
      token_budget: 4000,
      workdir: '*',
      min_trust: 'provisional',
    });
    const ids = new Set(filtered.map(m => m.memory_id));
    assert.ok(
      ids.has(id),
      'min_trust=provisional must include an auto memory after 1 successful recall — previously excluded because trust_level column stayed unverified'
    );
  });
});
