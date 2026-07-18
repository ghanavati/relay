/**
 * v0.2 schema cleanup — phase 2: drop the entire budget feature.
 *
 * Rationale: Relay's design pivoted to local-first (LM Studio + qwen + nomic).
 * Local model usage = $0, making `cost_events` / `budget_limits` / `budget_alerts`
 * dead weight. The associated CLI (`relay budget show`), tools (set/list budget),
 * BudgetStore, and contracts are deleted in the same commit.
 *
 * Tables dropped (NO FK between them — order is arbitrary, kept alphabetical):
 *   - budget_alerts   (paid-provider threshold alerts)
 *   - budget_limits   (paid-provider spend caps)
 *   - cost_events     (every paid worker invocation's cost)
 *
 * Indexes dropped explicitly so the migration is order-independent on a
 * partially-migrated DB (mirrors the v2 migrator pattern).
 *
 * Idempotent — early-returns when `readSchemaVersion(db) >= V3_TARGET`.
 * Atomic — every DROP runs inside a single `db.transaction` so a failure
 * mid-flight rolls back to v2 state.
 *
 * Recovery: the same `.v1-backup` written by Phase 1 captures pre-v0.2 data.
 * Users who need their cost history can restore that backup file out-of-band
 * before adopting the budget-stripped binary.
 */
import type Database from 'libsql';

import { readSchemaVersion, writeSchemaVersion } from './schema-version.js';

const V3_TARGET = 3 as const;

const DROP_TABLES: readonly string[] = [
  'budget_alerts',
  'budget_limits',
  'cost_events',
];

const DROP_INDEXES: readonly string[] = [
  'idx_budget_alerts_scope',
  'idx_budget_alerts_level',
  'idx_budget_limits_scope',
  'idx_cost_events_run_id',
  'idx_cost_events_workdir',
];

/**
 * Drop the 3 budget-feature tables and record schema_version=3.
 */
export function migrateDropBudgetV03(db: Database.Database): void {
  if (readSchemaVersion(db) >= V3_TARGET) {
    return;
  }

  const txn = db.transaction(() => {
    for (const idx of DROP_INDEXES) {
      db.prepare(`DROP INDEX IF EXISTS ${idx}`).run();
    }
    for (const tbl of DROP_TABLES) {
      db.prepare(`DROP TABLE IF EXISTS ${tbl}`).run();
    }
    writeSchemaVersion(
      db,
      V3_TARGET,
      'drop budget feature tables (cost_events, budget_limits, budget_alerts)',
    );
  });

  txn();
}
