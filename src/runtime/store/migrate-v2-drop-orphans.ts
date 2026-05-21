/**
 * v0.2 schema cleanup: drop 11 orphan tables left over from earlier
 * iterations that no command reads or writes (see
 * `.planning/v0.2-improvised-scrap/BUDGET-CLI-SCHEMA-MAP.md` §3 for the
 * lineage).
 *
 * The drop is gated on the `schema_version` table — once version >= 2 is
 * recorded, the migration is a no-op. This makes the function safe to call
 * on every startup (the production code path runs it inside `applySchema`).
 *
 * The drop is wrapped in a single transaction. If any statement fails the
 * entire migration rolls back and `schema_version` stays at its prior value,
 * so the next launch retries from a known starting point.
 *
 * Drop ordering is FK-safe per `SCHEMA-02`:
 *   triggers → indexes → leaf tables → parent tables → standalone tables.
 *
 * The transactional `.v1-backup` is taken by the caller (`prepareDatabase`
 * in `db.ts`) before this function ever runs. The CATASTROPHIC R-01-03
 * (DROP irreversible) is mitigated by that backup — without it the
 * migration is irreversible. See PLAN risk register.
 */
import type Database from 'better-sqlite3';

import {
  readSchemaVersion,
  writeSchemaVersion,
} from './schema-version.js';

const V2_TARGET = 2 as const;

/** Tables dropped by this migration, in FK-safe order. */
const DROP_TABLES: readonly string[] = [
  // 1) leaves that reference parents — drop first
  'task_deps',           // FK → jobs(job_id), tasks(task_id)
  'tasks',               // FK → jobs(job_id)
  'jobs',
  'job_events',
  // 2) sign_off subtree — children before parent
  'sign_off_amendments', // FK → sign_offs(run_id)
  'sign_offs',
  // 3) continuity subtree — children before parent
  'recipes',             // FK → continuity_objects(object_id)
  'continuity_objects',
  // 4) standalone orphans
  'proxy_requests',
  'operator_annotations',
  'verifications',
];

/** Triggers that must be dropped before their host table goes away. */
const DROP_TRIGGERS: readonly string[] = [
  'trg_sign_offs_no_update',
  'trg_sign_offs_no_delete',
];

/** Named indexes attached to the orphans. */
const DROP_INDEXES: readonly string[] = [
  'idx_sign_offs_run_id',
  'idx_proxy_requests_created_at',
  'idx_continuity_objects_kind',
  'idx_continuity_objects_status',
  'idx_recipes_object_id',
  'idx_verifications_run_id',
  'idx_tasks_job_id',
  'idx_job_events_job_id',
  'idx_operator_annotations_created_at',
  'idx_operator_annotations_session',
];

/**
 * Drop the 11 v0.1.x orphan tables and record schema_version=2.
 *
 * Idempotent — early-returns if `readSchemaVersion(db) >= V2_TARGET`.
 * Atomic — every DROP runs inside a single `db.transaction` so a failure
 * mid-flight rolls back to the v1 state.
 */
export function migrateDropOrphansV02(db: Database.Database): void {
  if (readSchemaVersion(db) >= V2_TARGET) {
    return;
  }

  const txn = db.transaction(() => {
    // 1) triggers — must die before their host table
    for (const trg of DROP_TRIGGERS) {
      db.prepare(`DROP TRIGGER IF EXISTS ${trg}`).run();
    }
    // 2) indexes — DROP TABLE on a referenced table also drops its indexes,
    //    but we drop them explicitly so the operation is order-independent
    //    if the host table is already gone (idempotency on a partially-
    //    migrated DB).
    for (const idx of DROP_INDEXES) {
      db.prepare(`DROP INDEX IF EXISTS ${idx}`).run();
    }
    // 3) tables — strict FK-safe order
    for (const tbl of DROP_TABLES) {
      db.prepare(`DROP TABLE IF EXISTS ${tbl}`).run();
    }
    // 4) record the migration
    writeSchemaVersion(
      db,
      V2_TARGET,
      'drop 11 orphan tables per SCHEMA-02',
    );
  });

  txn();
}
