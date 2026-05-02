/**
 * Unit tests for CapabilityStore — trust ledger, trust state machine, and cooling.
 *
 * Uses node:test + node:assert/strict — no external test framework.
 *
 * Test isolation: unique worker_id prefixes per test group (established project pattern).
 * In-memory SQLite is used via RELAY_DB_PATH=':memory:' set before any module imports.
 */

// Set in-memory DB before any import resolves the singleton.
process.env['RELAY_DB_PATH'] = ':memory:';

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { getDb } from '../store/db.js';
import { CapabilityStore } from './capability-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Cap = 'tool_use' | 'file_read' | 'file_write' | 'commit' | 'vision' | 'structured_output' | 'grounding';
type Ctx = 'repo_task' | 'analysis_task' | 'verification_task';

function recordMany(
  store: CapabilityStore,
  workerId: string,
  capability: Cap,
  taskContext: Ctx,
  outcomes: Array<'success' | 'failure'>,
): void {
  outcomes.forEach((outcome, i) => {
    store.recordOutcome({
      workerId,
      provider: 'openrouter',
      model: 'test-model',
      capability,
      taskContext,
      outcome,
      runId: `${workerId}-run-${i}`,
    });
  });
}

// ---------------------------------------------------------------------------
// 1. Worker Profile Management
// ---------------------------------------------------------------------------

describe('Worker Profile Management', () => {
  const store = new CapabilityStore();
  const db = getDb();
  const prefix = 'wp-';

  it('ensureWorkerProfile creates profile on first call', () => {
    const id = `${prefix}new-worker`;
    store.ensureWorkerProfile(id, 'openrouter', 'gemini-2.5-pro');
    const profile = store.getWorkerProfile(id);
    assert.ok(profile !== null, 'profile should exist after ensureWorkerProfile');
    assert.equal(profile.worker_id, id);
    assert.equal(profile.provider, 'openrouter');
    assert.equal(profile.model, 'gemini-2.5-pro');
    assert.equal(profile.cooldown_until, null);
  });

  it('ensureWorkerProfile does not overwrite existing profile (INSERT OR IGNORE)', () => {
    const id = `${prefix}existing-worker`;
    store.ensureWorkerProfile(id, 'openrouter', 'model-v1');
    // Call again with different provider/model — should be ignored
    store.ensureWorkerProfile(id, 'lmstudio', 'model-v2');
    const profile = store.getWorkerProfile(id);
    assert.ok(profile !== null);
    assert.equal(profile.provider, 'openrouter');
    assert.equal(profile.model, 'model-v1');
  });

  it('getWorkerProfile returns null for non-existent worker', () => {
    const result = store.getWorkerProfile(`${prefix}ghost-worker`);
    assert.equal(result, null);
  });

  it('listAvailableWorkers excludes workers with active cooldown', () => {
    const id = `${prefix}cooled-worker`;
    store.ensureWorkerProfile(id, 'openrouter', 'claude-opus');
    const nowTs = Date.now();
    const futureTs = nowTs + 60_000;
    db.prepare(
      'UPDATE worker_profiles SET cooldown_until = ?, updated_at = ? WHERE worker_id = ?',
    ).run(futureTs, nowTs, id);

    const available = store.listAvailableWorkers(nowTs);
    const found = available.find(w => w.worker_id === id);
    assert.equal(found, undefined, 'cooled worker should be excluded');
  });

  it('listAvailableWorkers includes workers with expired cooldown', () => {
    const id = `${prefix}expired-cool-worker`;
    store.ensureWorkerProfile(id, 'openrouter', 'claude-opus');
    const nowTs = Date.now();
    const pastCooldown = nowTs - 1_000; // expired 1 second ago
    db.prepare(
      'UPDATE worker_profiles SET cooldown_until = ?, updated_at = ? WHERE worker_id = ?',
    ).run(pastCooldown, nowTs, id);

    const available = store.listAvailableWorkers(nowTs);
    const found = available.find(w => w.worker_id === id);
    assert.ok(found !== undefined, 'worker with expired cooldown should be included');
  });
});

// ---------------------------------------------------------------------------
// 2. Evidence Recording
// ---------------------------------------------------------------------------

describe('Evidence Recording', () => {
  const store = new CapabilityStore();
  const prefix = 'er-';

  it('recordOutcome creates new evidence row on first call', () => {
    const id = `${prefix}worker-1`;
    store.recordOutcome({
      workerId: id,
      provider: 'openrouter',
      model: 'gemini',
      capability: 'tool_use',
      taskContext: 'repo_task',
      outcome: 'success',
      runId: 'run-001',
    });
    const evidence = store.getEvidence(id, 'tool_use', 'repo_task');
    assert.ok(evidence !== null, 'evidence row should exist after first recordOutcome');
  });

  it('recordOutcome increments success_count on success', () => {
    const id = `${prefix}worker-success`;
    recordMany(store, id, 'file_read', 'analysis_task', ['success', 'success']);
    const evidence = store.getEvidence(id, 'file_read', 'analysis_task');
    assert.ok(evidence !== null);
    assert.equal(evidence.success_count, 2);
  });

  it('recordOutcome increments failure_count on failure', () => {
    const id = `${prefix}worker-fail`;
    recordMany(store, id, 'file_write', 'repo_task', ['failure', 'failure']);
    const evidence = store.getEvidence(id, 'file_write', 'repo_task');
    assert.ok(evidence !== null);
    assert.equal(evidence.failure_count, 2);
  });

  it('recordOutcome resets consecutive_failures to 0 on success', () => {
    const id = `${prefix}worker-reset`;
    recordMany(store, id, 'commit', 'repo_task', ['failure', 'failure', 'success']);
    const evidence = store.getEvidence(id, 'commit', 'repo_task');
    assert.ok(evidence !== null);
    assert.equal(evidence.consecutive_failures, 0);
  });

  it('recordOutcome increments consecutive_failures on failure', () => {
    const id = `${prefix}worker-consec`;
    recordMany(store, id, 'grounding', 'analysis_task', ['failure', 'failure']);
    const evidence = store.getEvidence(id, 'grounding', 'analysis_task');
    assert.ok(evidence !== null);
    assert.equal(evidence.consecutive_failures, 2);
  });

  it('multiple capabilities for same worker create separate evidence rows', () => {
    const id = `${prefix}worker-multi`;
    store.recordOutcome({
      workerId: id, provider: 'openrouter', model: 'gemini',
      capability: 'tool_use', taskContext: 'repo_task', outcome: 'success', runId: 'run-m1',
    });
    store.recordOutcome({
      workerId: id, provider: 'openrouter', model: 'gemini',
      capability: 'vision', taskContext: 'repo_task', outcome: 'success', runId: 'run-m2',
    });
    const allEvidence = store.getEvidenceForWorker(id);
    const capabilities = new Set(allEvidence.map(e => e.capability));
    assert.ok(capabilities.has('tool_use'), 'tool_use evidence should exist');
    assert.ok(capabilities.has('vision'), 'vision evidence should exist');
    assert.equal(allEvidence.length, 2);
  });
});

// ---------------------------------------------------------------------------
// 3. Trust State Machine Transitions
// ---------------------------------------------------------------------------

describe('Trust State Machine Transitions', () => {
  const store = new CapabilityStore();
  const prefix = 'tsm-';

  it('unknown -> observed: first successful outcome', () => {
    const id = `${prefix}to-observed`;
    assert.equal(store.getTrustState(id, 'tool_use', 'repo_task'), 'unknown');
    recordMany(store, id, 'tool_use', 'repo_task', ['success']);
    assert.equal(store.getTrustState(id, 'tool_use', 'repo_task'), 'observed');
  });

  it('observed stays observed: fewer than 5 total runs', () => {
    const id = `${prefix}stays-observed`;
    // 4 successes — not enough for reliable (< 5 total)
    recordMany(store, id, 'tool_use', 'repo_task', ['success', 'success', 'success', 'success']);
    assert.equal(store.getTrustState(id, 'tool_use', 'repo_task'), 'observed');
  });

  it('observed -> reliable: 5+ successes with failure_rate < 10%', () => {
    const id = `${prefix}to-reliable`;
    // 5 successes, 0 failures -> failure_rate = 0 < 0.10
    recordMany(store, id, 'tool_use', 'repo_task', ['success', 'success', 'success', 'success', 'success']);
    assert.equal(store.getTrustState(id, 'tool_use', 'repo_task'), 'reliable');
  });

  it('observed -> unreliable: 5+ runs with failure_rate > 40%', () => {
    const id = `${prefix}to-unreliable`;
    // 5 runs: 2 success, 3 failure -> failure_rate = 3/5 = 0.60 > 0.40
    recordMany(store, id, 'file_write', 'repo_task', ['success', 'failure', 'success', 'failure', 'failure']);
    assert.equal(store.getTrustState(id, 'file_write', 'repo_task'), 'unreliable');
  });

  it('unreliable -> broken: 3 consecutive failures', () => {
    const id = `${prefix}to-broken`;
    // First get to unreliable: 5 runs with >40% failure rate
    recordMany(store, id, 'grounding', 'analysis_task', ['success', 'failure', 'success', 'failure', 'failure']);
    assert.equal(store.getTrustState(id, 'grounding', 'analysis_task'), 'unreliable');
    // Then 3 consecutive failures to reach broken
    recordMany(store, id, 'grounding', 'analysis_task', ['failure', 'failure', 'failure']);
    assert.equal(store.getTrustState(id, 'grounding', 'analysis_task'), 'broken');
  });

  it('broken -> observed: successful outcome resets', () => {
    const id = `${prefix}from-broken`;
    // Reach broken state
    recordMany(store, id, 'commit', 'repo_task', ['success', 'failure', 'success', 'failure', 'failure']);
    assert.equal(store.getTrustState(id, 'commit', 'repo_task'), 'unreliable');
    recordMany(store, id, 'commit', 'repo_task', ['failure', 'failure', 'failure']);
    assert.equal(store.getTrustState(id, 'commit', 'repo_task'), 'broken');
    // A success resets to observed
    recordMany(store, id, 'commit', 'repo_task', ['success']);
    assert.equal(store.getTrustState(id, 'commit', 'repo_task'), 'observed');
  });

  it('reliable -> unreliable: 3 consecutive failures', () => {
    const id = `${prefix}reliable-to-unreliable`;
    // Reach reliable: 5+ successes with <10% failure rate
    recordMany(store, id, 'file_read', 'analysis_task', ['success', 'success', 'success', 'success', 'success']);
    assert.equal(store.getTrustState(id, 'file_read', 'analysis_task'), 'reliable');
    // 3 consecutive failures drop it to unreliable
    recordMany(store, id, 'file_read', 'analysis_task', ['failure', 'failure', 'failure']);
    assert.equal(store.getTrustState(id, 'file_read', 'analysis_task'), 'unreliable');
  });

  it('evidence scoping: different task contexts have independent trust states', () => {
    const id = `${prefix}scope-test`;
    // Reach reliable in repo_task context
    recordMany(store, id, 'tool_use', 'repo_task', ['success', 'success', 'success', 'success', 'success']);
    assert.equal(store.getTrustState(id, 'tool_use', 'repo_task'), 'reliable');
    // analysis_task context for same worker/capability is independent
    assert.equal(store.getTrustState(id, 'tool_use', 'analysis_task'), 'unknown');
    // Record in analysis_task — should not affect repo_task
    recordMany(store, id, 'tool_use', 'analysis_task', ['failure']);
    assert.equal(store.getTrustState(id, 'tool_use', 'repo_task'), 'reliable');
    // analysis_task had only failure so stays unknown (no success yet → can't transition to observed)
    assert.equal(store.getTrustState(id, 'tool_use', 'analysis_task'), 'unknown');
  });
});

// ---------------------------------------------------------------------------
// 4. Worker Cooling
// ---------------------------------------------------------------------------

describe('Worker Cooling', () => {
  const store = new CapabilityStore();
  const db = getDb();
  const prefix = 'cool-';

  it('3 failures within 10 minutes triggers cooldown', () => {
    const id = `${prefix}trigger`;
    store.ensureWorkerProfile(id, 'openrouter', 'test-model');

    // Pre-seed 3 evidence rows with last_failure_at within the 10-minute window
    const recentTs = Date.now() - 60_000; // 1 minute ago
    const caps: Cap[] = ['tool_use', 'file_write', 'grounding'];
    caps.forEach((cap, i) => {
      db.prepare(
        `INSERT OR IGNORE INTO capability_evidence
           (worker_id, capability, task_context, trust_state, success_count, failure_count,
            consecutive_failures, last_failure_at, run_id, last_verified)
         VALUES (?, ?, 'repo_task', 'unknown', 0, 1, 1, ?, ?, ?)`,
      ).run(id, cap, recentTs, `run-cool-${i}`, recentTs);
    });

    // recordOutcome triggers checkCooling; 3 pre-seeded + 1 new = 4 in-window failures
    const beforeRecord = Date.now();
    store.recordOutcome({
      workerId: id, provider: 'openrouter', model: 'test-model',
      capability: 'vision', taskContext: 'repo_task', outcome: 'failure', runId: 'run-cool-trigger',
    });

    const profile = store.getWorkerProfile(id);
    assert.ok(profile !== null);
    assert.ok(
      profile.cooldown_until !== null && profile.cooldown_until > beforeRecord,
      `cooldown_until (${String(profile.cooldown_until)}) should be > ${String(beforeRecord)}`,
    );
  });

  it('cooldown_until = now + 5 minutes (300_000 ms) approximately', () => {
    const id = `${prefix}duration`;
    store.ensureWorkerProfile(id, 'openrouter', 'test-model');

    const recentTs = Date.now() - 10_000; // 10 seconds ago
    const caps: Cap[] = ['tool_use', 'file_write', 'commit'];
    caps.forEach((cap, i) => {
      db.prepare(
        `INSERT OR IGNORE INTO capability_evidence
           (worker_id, capability, task_context, trust_state, success_count, failure_count,
            consecutive_failures, last_failure_at, run_id, last_verified)
         VALUES (?, ?, 'repo_task', 'unknown', 0, 1, 1, ?, ?, ?)`,
      ).run(id, cap, recentTs, `run-dur-${i}`, recentTs);
    });

    const beforeRecord = Date.now();
    store.recordOutcome({
      workerId: id, provider: 'openrouter', model: 'test-model',
      capability: 'grounding', taskContext: 'repo_task', outcome: 'failure', runId: 'run-dur-t',
    });
    const afterRecord = Date.now();

    const profile = store.getWorkerProfile(id);
    assert.ok(profile !== null);
    assert.ok(profile.cooldown_until !== null);
    const expectedMin = beforeRecord + 300_000;
    const expectedMax = afterRecord + 300_000;
    assert.ok(
      profile.cooldown_until >= expectedMin && profile.cooldown_until <= expectedMax,
      `cooldown_until ${String(profile.cooldown_until)} should be between ${String(expectedMin)} and ${String(expectedMax)}`,
    );
  });

  it('workers with active cooldown excluded from listAvailableWorkers', () => {
    const id = `${prefix}excluded`;
    store.ensureWorkerProfile(id, 'openrouter', 'test-model');
    const nowTs = Date.now();
    db.prepare(
      'UPDATE worker_profiles SET cooldown_until = ?, updated_at = ? WHERE worker_id = ?',
    ).run(nowTs + 300_000, nowTs, id);

    const available = store.listAvailableWorkers(nowTs);
    assert.equal(available.find(w => w.worker_id === id), undefined);
  });

  it('failures spread over > 10 minutes do NOT trigger cooldown', () => {
    const id = `${prefix}spread`;
    store.ensureWorkerProfile(id, 'openrouter', 'test-model');

    const nowTs = Date.now();
    // 1 failure within window (1 min ago)
    db.prepare(
      `INSERT OR IGNORE INTO capability_evidence
         (worker_id, capability, task_context, trust_state, success_count, failure_count,
          consecutive_failures, last_failure_at, run_id, last_verified)
       VALUES (?, 'tool_use', 'repo_task', 'unknown', 0, 1, 1, ?, 'run-sp1', ?)`,
    ).run(id, nowTs - 60_000, nowTs);
    // 1 failure outside window (12 min ago)
    db.prepare(
      `INSERT OR IGNORE INTO capability_evidence
         (worker_id, capability, task_context, trust_state, success_count, failure_count,
          consecutive_failures, last_failure_at, run_id, last_verified)
       VALUES (?, 'file_read', 'repo_task', 'unknown', 0, 1, 1, ?, 'run-sp2', ?)`,
    ).run(id, nowTs - 720_000, nowTs);

    // This outcome adds another in-window failure (total in-window: 2) — not enough
    store.recordOutcome({
      workerId: id, provider: 'openrouter', model: 'test-model',
      capability: 'vision', taskContext: 'repo_task', outcome: 'failure', runId: 'run-sp3',
    });

    const profile = store.getWorkerProfile(id);
    assert.ok(profile !== null);
    assert.equal(
      profile.cooldown_until,
      null,
      'should not trigger cooldown with only 2 in-window failures',
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Evidence Queries
// ---------------------------------------------------------------------------

describe('Evidence Queries', () => {
  const store = new CapabilityStore();
  const prefix = 'eq-';

  it('getEvidenceForWorker returns confidence scores', () => {
    const id = `${prefix}confidence`;
    // 3 successes, 1 failure -> confidence = 3/4 = 0.75
    recordMany(store, id, 'tool_use', 'repo_task', ['success', 'success', 'success', 'failure']);
    const rows = store.getEvidenceForWorker(id);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.ok(row !== undefined);
    assert.ok('confidence' in row, 'confidence field should exist');
    assert.ok(Math.abs(row.confidence - 0.75) < 0.001, `expected confidence ~0.75, got ${String(row.confidence)}`);
  });

  it('getEvidence returns null for non-existent combination', () => {
    const id = `${prefix}no-evidence`;
    const result = store.getEvidence(id, 'vision', 'analysis_task');
    assert.equal(result, null);
  });

  it('getTrustState returns unknown when no evidence row exists (CRITICAL backward compat)', () => {
    const id = `${prefix}absent`;
    const state = store.getTrustState(id, 'commit', 'repo_task');
    assert.equal(state, 'unknown', "absence of evidence must return 'unknown', never 'broken'");
  });

  it('confidence = success / (success + failure) computed correctly', () => {
    const id = `${prefix}conf-check`;
    // 1 success, 4 failures -> confidence = 1/5 = 0.20
    recordMany(store, id, 'grounding', 'verification_task', ['success', 'failure', 'failure', 'failure', 'failure']);
    const evidence = store.getEvidence(id, 'grounding', 'verification_task');
    assert.ok(evidence !== null);
    assert.ok(Math.abs(evidence.confidence - 0.20) < 0.001, `expected 0.20, got ${String(evidence.confidence)}`);
  });
});
