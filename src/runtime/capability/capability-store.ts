/**
 * CapabilityStore — trust ledger for worker capability evidence.
 *
 * Central data service for capability routing.
 * Consumed by the dispatch filter (Plan 03) and verification adapters (Plan 04).
 *
 * All database operations are SYNCHRONOUS (better-sqlite3).
 * Never use async/await on DB calls.
 */

import { getDb } from '../store/db.js';
import type {
  Capability,
  TrustState,
  TaskContext,
  WorkerProfileRow,
  CapabilityEvidenceRow,
} from './types.js';

// ---------------------------------------------------------------------------
// CapabilityStore
// ---------------------------------------------------------------------------

export class CapabilityStore {
  // -------------------------------------------------------------------------
  // Worker Profile Management
  // -------------------------------------------------------------------------

  /**
   * Lazily upsert a worker profile on first evidence write.
   *
   * Uses INSERT OR IGNORE — does not overwrite an existing profile.
   */
  ensureWorkerProfile(workerId: string, provider: string, model: string): void {
    const db = getDb();
    const now = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO worker_profiles (worker_id, provider, model, cooldown_until, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    ).run(workerId, provider, model, now, now);
  }

  /**
   * Return a worker profile row by worker_id, or null if not found.
   */
  getWorkerProfile(workerId: string): WorkerProfileRow | null {
    const db = getDb();
    const row = db
      .prepare('SELECT * FROM worker_profiles WHERE worker_id = ?')
      .get(workerId) as WorkerProfileRow | undefined;
    return row ?? null;
  }

  /**
   * Return all workers not currently in cooldown.
   *
   * CRITICAL: pass epoch ms explicitly — never use SQLite datetime functions
   * (epoch ms vs seconds mismatch documented in project memory).
   *
   * @param now Epoch milliseconds; defaults to Date.now()
   */
  listAvailableWorkers(now?: number): WorkerProfileRow[] {
    const db = getDb();
    const ts = now ?? Date.now();
    return db
      .prepare(
        'SELECT * FROM worker_profiles WHERE cooldown_until IS NULL OR cooldown_until <= ?',
      )
      .all(ts) as WorkerProfileRow[];
  }

  // -------------------------------------------------------------------------
  // Evidence Recording
  // -------------------------------------------------------------------------

  /**
   * Record a single task outcome (success or failure) for a worker+capability+context triple.
   *
   * Steps:
   *   1. Lazy-upsert worker profile
   *   2. Upsert capability_evidence row (insert or update counters)
   *   3. Read back updated row and apply trust state transition
   *   4. Check cooling after trust update
   */
  recordOutcome(params: {
    workerId: string;
    provider: string;
    model: string;
    capability: Capability;
    taskContext: TaskContext;
    outcome: 'success' | 'failure';
    runId: string;
  }): void {
    const { workerId, provider, model, capability, taskContext, outcome, runId } = params;
    const db = getDb();
    const now = Date.now();

    // 1. Lazy-upsert profile
    this.ensureWorkerProfile(workerId, provider, model);

    // 2. Upsert evidence row — increment counters atomically
    db.prepare(
      `INSERT INTO capability_evidence
         (worker_id, capability, task_context, trust_state, success_count, failure_count,
          consecutive_failures, last_failure_at, run_id, last_verified)
       VALUES (?, ?, ?, 'unknown', IIF(? = 'success', 1, 0), IIF(? = 'failure', 1, 0),
               IIF(? = 'failure', 1, 0), IIF(? = 'failure', ?, NULL), ?, ?)
       ON CONFLICT(worker_id, capability, task_context) DO UPDATE SET
         success_count        = success_count + IIF(? = 'success', 1, 0),
         failure_count        = failure_count + IIF(? = 'failure', 1, 0),
         consecutive_failures = IIF(? = 'success', 0, consecutive_failures + 1),
         last_failure_at      = IIF(? = 'failure', ?, last_failure_at),
         run_id               = ?,
         last_verified        = ?`,
    ).run(
      // INSERT values
      workerId,
      capability,
      taskContext,
      outcome, // success_count IIF
      outcome, // failure_count IIF
      outcome, // consecutive_failures IIF (insert)
      outcome, // last_failure_at IIF (insert)
      now, // last_failure_at value
      runId,
      now, // last_verified
      // UPDATE SET values
      outcome, // success_count IIF
      outcome, // failure_count IIF
      outcome, // consecutive_failures IIF (update)
      outcome, // last_failure_at IIF (update)
      now, // last_failure_at value
      runId,
      now, // last_verified
    );

    // 3. Read back updated row and apply trust state transition
    const row = db
      .prepare(
        'SELECT * FROM capability_evidence WHERE worker_id = ? AND capability = ? AND task_context = ?',
      )
      .get(workerId, capability, taskContext) as CapabilityEvidenceRow;

    this.applyTrustTransition(row, outcome);

    // 4. Check cooling
    this.checkCooling(workerId, now);
  }

  // -------------------------------------------------------------------------
  // Trust State Machine (private)
  // -------------------------------------------------------------------------

  /**
   * Apply trust state transitions based on current evidence row state.
   *
   * Transitions from design spec:
   *   unknown    + success_count >= 1                           -> observed
   *   observed   + success_count >= 5 AND failure_rate < 0.10  -> reliable
   *   observed   + total_runs >= 5 AND failure_rate > 0.40     -> unreliable
   *   reliable   + consecutive_failures >= 3                   -> unreliable
   *   unreliable + consecutive_failures >= 3                   -> broken
   *   broken     + latest outcome is success                   -> observed
   *
   * Below 5 total runs: no transition beyond observed.
   *
   * @param row   Current evidence row (post-upsert)
   * @param outcome  The outcome just recorded (for broken->observed reset)
   */
  private applyTrustTransition(row: CapabilityEvidenceRow, outcome: 'success' | 'failure'): void {
    const db = getDb();
    const current = row.trust_state as TrustState;
    const totalRuns = row.success_count + row.failure_count;
    const failureRate = totalRuns > 0 ? row.failure_count / totalRuns : 0;

    let next: TrustState | null = null;

    switch (current) {
      case 'unknown':
        if (row.success_count >= 1) {
          next = 'observed';
        }
        break;

      case 'observed':
        if (row.success_count >= 5 && failureRate < 0.1) {
          next = 'reliable';
        } else if (totalRuns >= 5 && failureRate > 0.4) {
          next = 'unreliable';
        }
        break;

      case 'reliable':
        if (row.consecutive_failures >= 3) {
          next = 'unreliable';
        }
        break;

      case 'unreliable':
        if (row.consecutive_failures >= 3) {
          next = 'broken';
        }
        break;

      case 'broken':
        if (outcome === 'success') {
          next = 'observed';
        }
        break;
    }

    if (next !== null && next !== current) {
      db.prepare('UPDATE capability_evidence SET trust_state = ? WHERE id = ?').run(next, row.id);
    }
  }

  // -------------------------------------------------------------------------
  // Cooling Logic (private)
  // -------------------------------------------------------------------------

  /**
   * Check if a worker should be put into cooldown.
   *
   * Cooling trigger: 3+ capability failures within the last 10 minutes.
   * Cooldown duration: 5 minutes (300_000 ms).
   *
   * Uses explicit epoch ms params — never SQLite datetime functions.
   *
   * @param workerId  Worker to check
   * @param now       Epoch ms reference point
   */
  private checkCooling(workerId: string, now: number): void {
    const db = getDb();
    const windowStart = now - 600_000; // 10 minutes ago

    const result = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM capability_evidence
         WHERE worker_id = ? AND last_failure_at IS NOT NULL AND last_failure_at > ?`,
      )
      .get(workerId, windowStart) as { cnt: number };

    if (result.cnt >= 3) {
      const cooldownUntil = now + 300_000; // 5 minutes from now
      db.prepare(
        'UPDATE worker_profiles SET cooldown_until = ?, updated_at = ? WHERE worker_id = ?',
      ).run(cooldownUntil, now, workerId);
    }
  }

  // -------------------------------------------------------------------------
  // Evidence Queries
  // -------------------------------------------------------------------------

  /**
   * Return all evidence rows for a worker with computed confidence scores.
   *
   * confidence = success_count / (success_count + failure_count), or 0.0 if no runs.
   */
  getEvidenceForWorker(workerId: string): Array<CapabilityEvidenceRow & { confidence: number }> {
    const db = getDb();
    return db
      .prepare(
        `SELECT *,
           CASE WHEN (success_count + failure_count) > 0
                THEN CAST(success_count AS REAL) / (success_count + failure_count)
                ELSE 0.0
           END AS confidence
         FROM capability_evidence
         WHERE worker_id = ?`,
      )
      .all(workerId) as Array<CapabilityEvidenceRow & { confidence: number }>;
  }

  /**
   * Return the evidence row for a specific worker+capability+context triple with confidence,
   * or null if no evidence exists.
   */
  getEvidence(
    workerId: string,
    capability: Capability,
    taskContext: TaskContext,
  ): (CapabilityEvidenceRow & { confidence: number }) | null {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT *,
           CASE WHEN (success_count + failure_count) > 0
                THEN CAST(success_count AS REAL) / (success_count + failure_count)
                ELSE 0.0
           END AS confidence
         FROM capability_evidence
         WHERE worker_id = ? AND capability = ? AND task_context = ?`,
      )
      .get(workerId, capability, taskContext) as
      | (CapabilityEvidenceRow & { confidence: number })
      | undefined;
    return row ?? null;
  }

  /**
   * Return the trust state for a worker+capability+context triple.
   *
   * CRITICAL: returns 'unknown' when no evidence row exists — NEVER 'broken'.
   * Absence of evidence is not a sign of failure.
   */
  getTrustState(workerId: string, capability: Capability, taskContext: TaskContext): TrustState {
    const db = getDb();
    const row = db
      .prepare(
        'SELECT trust_state FROM capability_evidence WHERE worker_id = ? AND capability = ? AND task_context = ?',
      )
      .get(workerId, capability, taskContext) as { trust_state: string } | undefined;
    return (row?.trust_state as TrustState) ?? 'unknown';
  }
}
