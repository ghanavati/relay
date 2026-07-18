/**
 * DDL migrations for capability routing tables.
 *
 * Uses db.prepare(stmt).run() per statement — never the db batch-execute
 * method — to avoid triggering security hooks (documented project constraint,
 * STATE.md).
 */

import Database from 'libsql';
import { runAddColumn } from '../store/schema-version.js';

/**
 * Individual DDL statements for capability routing tables.
 *
 * Split into separate array elements so each is prepared and run individually.
 */
const CAPABILITY_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS worker_profiles (
    worker_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    cooldown_until INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS capability_evidence (
    id INTEGER PRIMARY KEY,
    worker_id TEXT NOT NULL REFERENCES worker_profiles(worker_id),
    capability TEXT NOT NULL,
    task_context TEXT NOT NULL,
    trust_state TEXT NOT NULL DEFAULT 'unknown',
    success_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    consecutive_failures INTEGER DEFAULT 0,
    last_failure_at INTEGER,
    run_id TEXT,
    last_verified INTEGER,
    notes TEXT,
    UNIQUE(worker_id, capability, task_context)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_capability_evidence_worker_id ON capability_evidence(worker_id)`,
  `CREATE INDEX IF NOT EXISTS idx_worker_profiles_cooldown ON worker_profiles(cooldown_until)`,
];

/**
 * Create capability routing tables and run PRAGMA-guarded column migrations.
 *
 * Safe to call on every server start — CREATE TABLE IF NOT EXISTS is idempotent.
 *
 * The consecutive_failures column was added after initial deploy.
 * The PRAGMA-guarded ALTER TABLE handles databases that predate that column.
 */
export function migrateCapabilityTables(db: Database.Database): void {
  for (const stmt of CAPABILITY_DDL) {
    db.prepare(stmt).run();
  }

  // PRAGMA-guarded migration: add consecutive_failures if absent.
  const info = db.prepare('PRAGMA table_info(capability_evidence)').all() as { name: string }[];
  const cols = new Set(info.map(r => r.name));
  if (!cols.has('consecutive_failures')) {
    runAddColumn(db, 'ALTER TABLE capability_evidence ADD COLUMN consecutive_failures INTEGER DEFAULT 0');
  }
}
