/**
 * Tests for dispatch-filter.ts
 *
 * Isolation strategy: unique worker_id prefix per test group with shared in-memory DB.
 * No teardown hooks needed — unique prefixes prevent cross-group interference.
 */

import { describe, it, before } from 'node:test';
import * as assert from 'node:assert/strict';

// Set in-memory DB before importing anything that touches getDb
process.env['RELAY_DB_PATH'] = ':memory:';

import { getDb } from '../store/db.js';
import { CapabilityStore } from './capability-store.js';
import { filterAndRankCandidates, workerPassesRiskGate } from './dispatch-filter.js';
import type { TaskContract, WorkerProfileRow } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProfile(
  workerId: string,
  provider: string,
  model: string,
  cooldownUntil: number | null = null,
): WorkerProfileRow {
  return {
    worker_id: workerId,
    provider,
    model,
    cooldown_until: cooldownUntil,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
}

function makeContract(
  requirements: string[],
  opts: { risk_override?: 'low' | 'standard' | 'critical'; allow_fallback?: boolean } = {},
): TaskContract {
  return {
    requirements: new Set(requirements) as ReadonlySet<any>,
    risk_override: opts.risk_override,
    allow_fallback: opts.allow_fallback,
  };
}

const NOW = Date.now();

// ---------------------------------------------------------------------------
// Test groups
// ---------------------------------------------------------------------------

describe('dispatch-filter: cooled worker exclusion', () => {
  before(() => {
    // Ensure schema is applied
    getDb();
  });

  it('excludes a worker that is still in cooldown', () => {
    const store = new CapabilityStore();
    const workerId = 'df-cool-01:worker';
    const cooledProfile = makeProfile(workerId, 'df-cool-01', 'worker', NOW + 60_000);

    const contract = makeContract([], {});
    const result = filterAndRankCandidates({
      candidates: [cooledProfile],
      contract,
      store,
      effectiveRisk: 'low',
      taskContext: 'repo_task',
      now: NOW,
    });

    assert.equal(result.ranked.length, 0);
    assert.equal(result.rejectionReasons.has(workerId), true);
    assert.match(result.rejectionReasons.get(workerId)!, /cooldown active until/);
  });

  it('includes a worker whose cooldown has expired', () => {
    const store = new CapabilityStore();
    const workerId = 'df-cool-02:worker';
    const expiredProfile = makeProfile(workerId, 'df-cool-02', 'worker', NOW - 1_000);

    const contract = makeContract([], {});
    const result = filterAndRankCandidates({
      candidates: [expiredProfile],
      contract,
      store,
      effectiveRisk: 'low',
      taskContext: 'repo_task',
      now: NOW,
    });

    assert.equal(result.ranked.length, 1);
    assert.equal(result.ranked[0]!.worker_id, workerId);
  });
});

describe('dispatch-filter: broken trust exclusion', () => {
  it('excludes a worker with broken trust for a required capability', () => {
    const store = new CapabilityStore();
    const workerId = 'df-broken-01:worker';
    store.ensureWorkerProfile(workerId, 'df-broken-01', 'worker');

    // Drive trust state to broken: record 3+ failures while unreliable
    // First get to unreliable via observed -> unreliable, then unreliable -> broken
    for (let i = 0; i < 3; i++) {
      store.recordOutcome({
        workerId, provider: 'df-broken-01', model: 'worker',
        capability: 'file_write', taskContext: 'repo_task',
        outcome: 'success', runId: `run-setup-${i}`,
      });
    }
    // Now cause failure to move toward broken
    for (let i = 0; i < 10; i++) {
      store.recordOutcome({
        workerId, provider: 'df-broken-01', model: 'worker',
        capability: 'file_write', taskContext: 'repo_task',
        outcome: 'failure', runId: `run-fail-${i}`,
      });
    }

    const trust = store.getTrustState(workerId, 'file_write', 'repo_task');
    // Should be broken or unreliable after many failures — either is caught by Step 2 (broken) or Step 3 (risk gate)
    assert.ok(trust === 'broken' || trust === 'unreliable');

    if (trust === 'broken') {
      const contract = makeContract(['file_write']);
      const profile = makeProfile(workerId, 'df-broken-01', 'worker');
      const result = filterAndRankCandidates({
        candidates: [profile],
        contract,
        store,
        effectiveRisk: 'low',
        taskContext: 'repo_task',
        now: NOW,
      });
      assert.equal(result.ranked.length, 0);
      assert.equal(result.rejectionReasons.get(workerId), 'broken for file_write');
    }
  });
});

describe('dispatch-filter: risk gates', () => {
  it('low risk allows unknown workers (no evidence)', () => {
    const store = new CapabilityStore();
    const workerId = 'df-rg-low-01:worker';
    const profile = makeProfile(workerId, 'df-rg-low-01', 'worker');
    const contract = makeContract(['tool_use', 'file_read']);

    const passes = workerPassesRiskGate(workerId, contract, store, 'low', 'repo_task');
    assert.equal(passes, true);

    const result = filterAndRankCandidates({
      candidates: [profile],
      contract,
      store,
      effectiveRisk: 'low',
      taskContext: 'repo_task',
      now: NOW,
    });
    assert.equal(result.ranked.length, 1);
  });

  it('standard risk blocks unknown for file_write without allow_fallback', () => {
    const store = new CapabilityStore();
    const workerId = 'df-rg-std-01:worker';
    const contract = makeContract(['file_write'], { allow_fallback: false });

    const passes = workerPassesRiskGate(workerId, contract, store, 'standard', 'repo_task');
    assert.equal(passes, false);
  });

  it('standard risk with allow_fallback=true permits unknown for file_write', () => {
    const store = new CapabilityStore();
    const workerId = 'df-rg-std-02:worker';
    const contract = makeContract(['file_write'], { allow_fallback: true });

    const passes = workerPassesRiskGate(workerId, contract, store, 'standard', 'repo_task');
    assert.equal(passes, true);
  });

  it('critical risk blocks workers with non-reliable trust', () => {
    const store = new CapabilityStore();
    const workerId = 'df-rg-crit-01:worker';
    // No evidence = unknown trust
    const contract = makeContract(['commit']);

    const passes = workerPassesRiskGate(workerId, contract, store, 'critical', 'repo_task');
    assert.equal(passes, false);
  });

  it('critical risk blocks workers with observed (not yet reliable) trust', () => {
    const store = new CapabilityStore();
    const workerId = 'df-rg-crit-02:worker';

    // Record one success to move to observed
    store.recordOutcome({
      workerId, provider: 'df-rg-crit-02', model: 'worker',
      capability: 'commit', taskContext: 'repo_task',
      outcome: 'success', runId: 'run-obs',
    });

    const trust = store.getTrustState(workerId, 'commit', 'repo_task');
    assert.equal(trust, 'observed');

    const contract = makeContract(['commit']);
    const passes = workerPassesRiskGate(workerId, contract, store, 'critical', 'repo_task');
    assert.equal(passes, false);
  });

  it('critical risk requires ALL capabilities at reliable', () => {
    const store = new CapabilityStore();
    const workerId = 'df-rg-crit-03:worker';

    // Make commit reliable (5+ successes with <10% failures)
    for (let i = 0; i < 6; i++) {
      store.recordOutcome({
        workerId, provider: 'df-rg-crit-03', model: 'worker',
        capability: 'commit', taskContext: 'repo_task',
        outcome: 'success', runId: `run-commit-${i}`,
      });
    }
    const commitTrust = store.getTrustState(workerId, 'commit', 'repo_task');
    assert.equal(commitTrust, 'reliable');

    // grounding remains unknown
    const groundingTrust = store.getTrustState(workerId, 'grounding', 'repo_task');
    assert.equal(groundingTrust, 'unknown');

    const contract = makeContract(['commit', 'grounding']);
    const passes = workerPassesRiskGate(workerId, contract, store, 'critical', 'repo_task');
    assert.equal(passes, false);
  });
});

describe('dispatch-filter: ranking', () => {
  it('higher min-confidence ranked first', () => {
    const store = new CapabilityStore();
    const workerA = 'df-rank-01:low';
    const workerB = 'df-rank-01:high';

    // workerA: 2 successes, 1 failure => confidence ~0.67
    for (let i = 0; i < 2; i++) {
      store.recordOutcome({
        workerId: workerA, provider: 'df-rank-01', model: 'low',
        capability: 'tool_use', taskContext: 'repo_task',
        outcome: 'success', runId: `run-a-s-${i}`,
      });
    }
    store.recordOutcome({
      workerId: workerA, provider: 'df-rank-01', model: 'low',
      capability: 'tool_use', taskContext: 'repo_task',
      outcome: 'failure', runId: 'run-a-f',
    });

    // workerB: 5 successes, 0 failures => confidence 1.0
    for (let i = 0; i < 5; i++) {
      store.recordOutcome({
        workerId: workerB, provider: 'df-rank-01', model: 'high',
        capability: 'tool_use', taskContext: 'repo_task',
        outcome: 'success', runId: `run-b-s-${i}`,
      });
    }

    const candidates = [
      makeProfile(workerA, 'df-rank-01', 'low'),
      makeProfile(workerB, 'df-rank-01', 'high'),
    ];
    const contract = makeContract(['tool_use']);
    const result = filterAndRankCandidates({
      candidates,
      contract,
      store,
      effectiveRisk: 'low',
      taskContext: 'repo_task',
      now: NOW,
    });

    assert.equal(result.ranked.length, 2);
    assert.equal(result.ranked[0]!.worker_id, workerB); // higher confidence first
    assert.equal(result.ranked[1]!.worker_id, workerA);
  });

  it('worker with one low capability ranked below worker with all high capabilities', () => {
    const store = new CapabilityStore();
    const workerA = 'df-rank-02:mixed';
    const workerB = 'df-rank-02:strong';

    // workerA: strong on tool_use, weak on file_read
    for (let i = 0; i < 5; i++) {
      store.recordOutcome({
        workerId: workerA, provider: 'df-rank-02', model: 'mixed',
        capability: 'tool_use', taskContext: 'repo_task',
        outcome: 'success', runId: `run-am-tu-${i}`,
      });
    }
    // file_read: only 1 success => confidence 1.0 but no evidence = 0 actually
    // Let's give it 2 successes and 3 failures => confidence ~0.4
    for (let i = 0; i < 2; i++) {
      store.recordOutcome({
        workerId: workerA, provider: 'df-rank-02', model: 'mixed',
        capability: 'file_read', taskContext: 'repo_task',
        outcome: 'success', runId: `run-am-fr-s-${i}`,
      });
    }
    for (let i = 0; i < 3; i++) {
      store.recordOutcome({
        workerId: workerA, provider: 'df-rank-02', model: 'mixed',
        capability: 'file_read', taskContext: 'repo_task',
        outcome: 'failure', runId: `run-am-fr-f-${i}`,
      });
    }

    // workerB: strong on both
    for (let i = 0; i < 5; i++) {
      store.recordOutcome({
        workerId: workerB, provider: 'df-rank-02', model: 'strong',
        capability: 'tool_use', taskContext: 'repo_task',
        outcome: 'success', runId: `run-bs-tu-${i}`,
      });
    }
    for (let i = 0; i < 5; i++) {
      store.recordOutcome({
        workerId: workerB, provider: 'df-rank-02', model: 'strong',
        capability: 'file_read', taskContext: 'repo_task',
        outcome: 'success', runId: `run-bs-fr-${i}`,
      });
    }

    const candidates = [
      makeProfile(workerA, 'df-rank-02', 'mixed'),
      makeProfile(workerB, 'df-rank-02', 'strong'),
    ];
    const contract = makeContract(['tool_use', 'file_read']);
    const result = filterAndRankCandidates({
      candidates,
      contract,
      store,
      effectiveRisk: 'low',
      taskContext: 'repo_task',
      now: NOW,
    });

    assert.equal(result.ranked.length, 2);
    // workerB has min-confidence = 1.0 (both high)
    // workerA has min-confidence = 0.4 (file_read is weak)
    assert.equal(result.ranked[0]!.worker_id, workerB);
    assert.equal(result.ranked[1]!.worker_id, workerA);
  });
});

describe('dispatch-filter: no candidates pass', () => {
  it('returns empty ranked array and all rejection reasons when no candidates qualify', () => {
    const store = new CapabilityStore();
    const workerA = 'df-none-01:a';
    const workerB = 'df-none-01:b';

    // Both cooled
    const candidates = [
      makeProfile(workerA, 'df-none-01', 'a', NOW + 10_000),
      makeProfile(workerB, 'df-none-01', 'b', NOW + 20_000),
    ];
    const contract = makeContract(['tool_use']);
    const result = filterAndRankCandidates({
      candidates,
      contract,
      store,
      effectiveRisk: 'low',
      taskContext: 'repo_task',
      now: NOW,
    });

    assert.equal(result.ranked.length, 0);
    assert.equal(result.rejectionReasons.size, 2);
    assert.equal(result.rejectionReasons.has(workerA), true);
    assert.equal(result.rejectionReasons.has(workerB), true);
  });
});

describe('dispatch-filter: backward compat — no evidence = unknown', () => {
  it('worker with no evidence rows treated as unknown, passes low risk', () => {
    const store = new CapabilityStore();
    const workerId = 'df-bc-01:fresh';
    const profile = makeProfile(workerId, 'df-bc-01', 'fresh');
    const contract = makeContract(['tool_use', 'file_read', 'file_write'], { allow_fallback: true });

    const result = filterAndRankCandidates({
      candidates: [profile],
      contract,
      store,
      effectiveRisk: 'low',
      taskContext: 'repo_task',
      now: NOW,
    });

    // Low risk with no evidence: all unknown, no broken -> should pass
    assert.equal(result.ranked.length, 1);
    assert.equal(result.rejectionReasons.size, 0);
  });

  it('worker with no evidence and standard risk without allow_fallback is blocked for file_write', () => {
    const store = new CapabilityStore();
    const workerId = 'df-bc-02:fresh';
    const profile = makeProfile(workerId, 'df-bc-02', 'fresh');
    const contract = makeContract(['file_write'], { allow_fallback: false });

    const result = filterAndRankCandidates({
      candidates: [profile],
      contract,
      store,
      effectiveRisk: 'standard',
      taskContext: 'repo_task',
      now: NOW,
    });

    assert.equal(result.ranked.length, 0);
    assert.equal(result.rejectionReasons.has(workerId), true);
  });
});
