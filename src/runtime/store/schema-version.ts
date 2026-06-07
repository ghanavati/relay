/**
 * Schema version tracking helpers for the relay store.
 *
 * The `schema_version` table is the gate that determines which migrations
 * have already been applied to a database. It is the first table created by
 * `applySchema` and the first thing every destructive migration consults.
 *
 * Version semantics:
 *   - 0  → table absent (DB pre-dates schema_version, i.e. v0.1.x).
 *   - 1  → bootstrap row written the first time v0.2 code touches a v0.1.x DB.
 *   - 2  → v0.2 orphan cleanup migration has run (drops 11 tables).
 *   - 3  → budget feature removed (drops cost_events + budget_limits + budget_alerts).
 *   - 4  → universal control tables added (control_sessions, control_events,
 *          control_mailbox, control_grants, control_delivery_attempts) — Phase 8.
 *
 * `readSchemaVersion` is read-only and tolerant of a missing table; it never
 * throws. `writeSchemaVersion` uses INSERT OR IGNORE so callers may invoke it
 * multiple times for the same version without producing duplicates — the
 * (version) PRIMARY KEY gives us idempotency for free.
 */
import type Database from 'better-sqlite3';

/** Schema version the running binary expects to find applied. */
export const EXPECTED_SCHEMA_VERSION = 4 as const;

/** Description recorded for the baseline (v0.1.x) bootstrap row. */
export const BASELINE_SCHEMA_DESCRIPTION = 'baseline v0.1.x schema';

/**
 * Return the highest schema_version recorded in the DB.
 *
 * Returns 0 if the `schema_version` table does not exist (a DB created before
 * this helper was introduced). Returns the MAX(version) otherwise — a fresh
 * v0.2-or-later DB will have rows for every version applied, so the max is
 * the effective applied version.
 */
export function readSchemaVersion(db: Database.Database): number {
  // PRAGMA table_info returns rows iff the table exists.
  const info = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get();
  if (!info) return 0;
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null } | undefined;
  return row?.v ?? 0;
}

/**
 * Record that `version` has been applied. INSERT OR IGNORE makes repeat calls
 * with the same version a no-op, so callers may safely re-invoke from
 * migration code that runs on every startup.
 *
 * `applied_at` is the current epoch ms — preserving the originally-applied
 * timestamp is more useful than overwriting it on retries (and the PK
 * conflict handler keeps it that way).
 */
export function writeSchemaVersion(
  db: Database.Database,
  version: number,
  description: string,
): void {
  db.prepare(
    'INSERT OR IGNORE INTO schema_version (version, applied_at, description) VALUES (?, ?, ?)'
  ).run(version, Date.now(), description);
}
