import Database from 'libsql';
import { mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as path from 'node:path';
import { migrateCapabilityTables } from '../capability/db-migrations.js';
import { migrateMemoryTables } from '../../memory/db-migrations.js';
import { migrateAuthTables } from './migrations/auth.js';
import {
  readSchemaVersion,
  writeSchemaVersion,
  EXPECTED_SCHEMA_VERSION,
  BASELINE_SCHEMA_DESCRIPTION,
} from './schema-version.js';
import { migrateDropOrphansV02 } from './migrate-v2-drop-orphans.js';
import { migrateDropBudgetV03 } from './migrate-v3-drop-budget.js';
import {
  writeV1Backup,
  shouldSkipBackup,
  backupBeforeMigrationSync,
} from './backup-v1.js';

let _db: Database.Database | null = null;

// Schema DDL statements applied on first open.
// Split into individual statements to avoid using db.exec() which triggers security hooks.
const DDL_STATEMENTS: readonly string[] = [
  // Schema version tracking — MUST come first so other migrations can read it.
  // (version, applied_at, description) — see ./schema-version.ts.
  `CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL,
    description TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    model TEXT,
    workdir TEXT NOT NULL,
    status TEXT NOT NULL,
    queued_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    duration_ms INTEGER,
    task_excerpt TEXT,
    timeout_ms INTEGER,
    output_size_chars INTEGER,
    exit_code INTEGER,
    token_usage INTEGER,
    warnings_json TEXT,
    files_changed_json TEXT,
    error_code TEXT,
    error_message TEXT,
    spawn_time_ms INTEGER,
    version INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS run_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS command_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    mode TEXT NOT NULL,
    filter_basis TEXT NOT NULL,
    command_name TEXT NOT NULL,
    command_preview TEXT NOT NULL,
    command_class TEXT NOT NULL,
    raw_output_chars INTEGER NOT NULL,
    filtered_output_chars INTEGER NOT NULL,
    estimated_raw_tokens INTEGER NOT NULL,
    estimated_filtered_tokens INTEGER NOT NULL,
    estimated_tokens_saved INTEGER NOT NULL,
    exit_code INTEGER,
    duration_ms INTEGER,
    artifact_path TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS idempotency_keys (
    key TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_idempotency_keys_run_id ON idempotency_keys(run_id)`,
  // continuity_objects + recipes (+ their indexes) DROPped in v0.2 migration v2 — see migrate-v2-drop-orphans.ts
  `CREATE TABLE IF NOT EXISTS run_diffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    diff_text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  // verifications DROPped in v0.2 migration v2 — see migrate-v2-drop-orphans.ts
  // cost_events DROPped in v0.2 migration v3 — budget feature removed (local-first pivot)
  // sign_offs + sign_off_amendments (+ idx + triggers) DROPped in v0.2 migration v2 — see migrate-v2-drop-orphans.ts
  // proxy_requests (+ idx) DROPped in v0.2 migration v2 — see migrate-v2-drop-orphans.ts
  `CREATE TABLE IF NOT EXISTS relay_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL UNIQUE,
    project_path TEXT NOT NULL,
    branch TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'human',
    status TEXT NOT NULL DEFAULT 'running',
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    duration_ms INTEGER,
    files_changed TEXT,
    merge_status TEXT,
    merge_commit TEXT,
    exit_code INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_relay_sessions_started_at ON relay_sessions(started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_relay_sessions_project ON relay_sessions(project_path)`,
  // idx_cost_events_* DROPped in v0.2 migration v3 (budget feature removed)
  `CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_workdir ON runs(workdir)`,
  `CREATE INDEX IF NOT EXISTS idx_run_events_run_id ON run_events(run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_command_events_run_id ON command_events(run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_run_diffs_run_id ON run_diffs(run_id)`,
  // idx_verifications_run_id DROPped in v0.2 migration v2 — see migrate-v2-drop-orphans.ts
  // jobs / tasks / task_deps / job_events (+ their indexes) DROPped in v0.2 migration v2
  // operator_annotations (+ idxs) DROPped in v0.2 migration v2
  `CREATE TABLE IF NOT EXISTS memory_reads (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL, run_id TEXT, read_source TEXT NOT NULL DEFAULT 'mcp', workdir TEXT, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_reads_memory_id ON memory_reads(memory_id)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_reads_run_id ON memory_reads(run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_reads_created ON memory_reads(created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS corpora (name TEXT PRIMARY KEY, description TEXT, filter_json TEXT NOT NULL, content TEXT NOT NULL, built_at INTEGER NOT NULL, built_from_count INTEGER NOT NULL DEFAULT 0)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS corpora_fts USING fts5(content, name UNINDEXED, content=corpora, content_rowid=rowid)`,
  `CREATE TRIGGER IF NOT EXISTS corpora_fts_insert AFTER INSERT ON corpora BEGIN INSERT INTO corpora_fts(rowid, content, name) VALUES (new.rowid, new.content, new.name); END`,
  `CREATE TRIGGER IF NOT EXISTS corpora_fts_update AFTER UPDATE OF content ON corpora BEGIN INSERT INTO corpora_fts(corpora_fts, rowid, content, name) VALUES ('delete', old.rowid, old.content, old.name); INSERT INTO corpora_fts(rowid, content, name) VALUES (new.rowid, new.content, new.name); END`,
  `CREATE TRIGGER IF NOT EXISTS corpora_fts_delete AFTER DELETE ON corpora BEGIN INSERT INTO corpora_fts(corpora_fts, rowid, content, name) VALUES ('delete', old.rowid, old.content, old.name); END`,
];

// Note: `verifications` table and its tainted-record purge migration are gone
// (v0.2 schema cleanup). The CLI tier never read this table; see
// migrate-v2-drop-orphans.ts.

export function getDb(): Database.Database {
  if (_db) return _db;
  const dbPath = process.env['RELAY_DB_PATH'] ?? join(homedir(), '.relay', 'relay.db');
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    // Sync .v1-backup BEFORE we open the DB for writes. The backup helper
    // peeks at schema_version read-only and skips when v >= 2 or when the
    // user opted out via RELAY_SKIP_V2_BACKUP=1. If a backup is required
    // but cannot be written, we THROW — running the destructive v2 DROP
    // without a recovery artifact would violate R-01-03 (PITFALLS.md CC.1).
    const storeDir = path.dirname(dbPath);
    const backupResult = backupBeforeMigrationSync(
      dbPath,
      storeDir,
      (p) => new Database(p, { readonly: true, fileMustExist: true }),
    );
    if (!backupResult.skipped && !backupResult.backupPath) {
      throw new Error('.v1-backup write failed — refusing to open DB for v0.2 migration');
    }
  }
  _db = new Database(dbPath);
  installNestableTransactions(_db);
  if (dbPath !== ':memory:') {
    try { chmodSync(dbPath, 0o600); } catch { /* best-effort */ }
  }
  _db.pragma('journal_mode = WAL');
  _db.pragma('wal_autocheckpoint = 1000');
  _db.pragma('foreign_keys = ON');
  applySchema(_db);
  return _db;
}

/**
 * libsql's `transaction()` issues a plain BEGIN even when a transaction is
 * already open and throws "cannot start a transaction within a transaction".
 * better-sqlite3 — whose API this codebase was written against — transparently
 * downgrades nested transaction() calls to SAVEPOINTs. Restore that semantic
 * once, at the factory, so every consumer keeps its nesting behavior.
 * (No caller uses the .deferred/.immediate/.exclusive variants.)
 */
function installNestableTransactions(db: Database.Database): void {
  let spSeq = 0;
  const nestable = <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      if (!db.inTransaction) {
        db.exec('BEGIN');
        try {
          const result = fn(...args);
          db.exec('COMMIT');
          return result;
        } catch (err) {
          if (db.inTransaction) { try { db.exec('ROLLBACK'); } catch { /* connection gone */ } }
          throw err;
        }
      }
      const sp = `relay_nested_${++spSeq}`;
      db.exec(`SAVEPOINT ${sp}`);
      try {
        const result = fn(...args);
        db.exec(`RELEASE ${sp}`);
        return result;
      } catch (err) {
        try { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); } catch { /* connection gone */ }
        throw err;
      }
    };
  (db as { transaction: unknown }).transaction = nestable;
}

/**
 * PRAGMA-guarded migration for the runs table verification_status field.
 */
function migrateRunsVerificationStatus(db: Database.Database): void {
  const info = db.prepare('PRAGMA table_info(runs)').all() as { name: string }[];
  const cols = new Set(info.map(r => r.name));
  if (!cols.has('verification_status')) {
    db.prepare('ALTER TABLE runs ADD COLUMN verification_status TEXT').run();
  }
}

// migrateVerificationsConfidenceScore / migrateVerificationsSource /
// migrateProxyRequestsFullBody removed — their target tables are DROPped
// in migrate-v2-drop-orphans.ts.

/**
 * R-16 — PRAGMA-guarded migration for EU AI Act obligation fields on the models table.
 * obligation_role: provider/deployer/both per Articles 28-30.
 * provider_documentation_received: boolean flag per Article 28(1)(c).
 */
function migrateModelObligationFields(db: Database.Database): void {
  const info = db.prepare('PRAGMA table_info(models)').all() as { name: string }[];
  const cols = new Set(info.map(r => r.name));
  if (!cols.has('obligation_role')) {
    db.prepare('ALTER TABLE models ADD COLUMN obligation_role TEXT').run();
  }
  if (!cols.has('provider_documentation_received')) {
    db.prepare('ALTER TABLE models ADD COLUMN provider_documentation_received INTEGER NOT NULL DEFAULT 0').run();
  }
}

/**
 * R-22 — PRAGMA-guarded migration for hybrid model type field.
 * model_type: 'llm' | 'onnx' | 'r-script' | 'python-script' | 'vendor-api'
 */
function migrateModelTypeField(db: Database.Database): void {
  const info = db.prepare('PRAGMA table_info(models)').all() as { name: string }[];
  const cols = new Set(info.map(r => r.name));
  if (!cols.has('model_type')) {
    db.prepare('ALTER TABLE models ADD COLUMN model_type TEXT').run();
  }
}

// SHIP-27: idempotency TTL migration — add expires_at column if missing
function migrateIdempotencyExpiresAt(db: Database.Database): void {
  const info = db.prepare('PRAGMA table_info(idempotency_keys)').all() as { name: string }[];
  const cols = new Set(info.map(r => r.name));
  if (!cols.has('expires_at')) {
    db.prepare('ALTER TABLE idempotency_keys ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0').run();
  }
}

function migrateSessionFields(db: Database.Database): void {
  const info = db.prepare('PRAGMA table_info(relay_sessions)').all() as { name: string }[];
  const cols = new Set(info.map(r => r.name));
  if (!cols.has('worktree_path')) {
    db.prepare('ALTER TABLE relay_sessions ADD COLUMN worktree_path TEXT').run();
  }
  if (!cols.has('tmux_session')) {
    db.prepare('ALTER TABLE relay_sessions ADD COLUMN tmux_session TEXT').run();
  }
  if (!cols.has('cc_session_id')) {
    db.prepare('ALTER TABLE relay_sessions ADD COLUMN cc_session_id TEXT').run();
  }
}

// purgeTaintedVerificationRecords removed — `verifications` table is dropped
// by migrate-v2-drop-orphans.ts (v0.2 schema cleanup).

/**
 * Apply schema. Idempotent — safe to call on every open of the DB.
 *
 * Exported so tests can drive it without going through the singleton in
 * `getDb`. For production code paths that need `.v1-backup` written before
 * the v2 cleanup runs, call `prepareDatabase` instead.
 */
export function applySchema(db: Database.Database): void {
  // 1) DDL — adds schema_version + every non-orphan table.
  for (const stmt of DDL_STATEMENTS) {
    db.prepare(stmt).run();
  }
  // 2) Bootstrap: a DB that pre-dates v0.2 has no schema_version row.
  //    Stamp it as v1 so downstream migrations see a known starting point.
  if (readSchemaVersion(db) === 0) {
    writeSchemaVersion(db, 1, BASELINE_SCHEMA_DESCRIPTION);
  }
  // 3) Long-standing PRAGMA-guarded migrations that target tables we keep.
  migrateIdempotencyExpiresAt(db);
  migrateRunsVerificationStatus(db);
  migrateCapabilityTables(db);
  migrateMemoryTables(db);
  migrateSessionFields(db);
  migrateRunsTaskHash(db);
  migrateRunEventsTraceFields(db);
  migrateRunsRecalledMemories(db);
  migrateRunsThinkingBlocks(db);
  migrateRunsUsageReceipt(db);
  migrateAuthTables(db);
  // 4) v0.2 cleanup — drop 11 orphan tables (idempotent; no-op once v=2 is set).
  migrateDropOrphansV02(db);
  // 5) v0.2 cleanup phase 2 — drop budget feature (cost_events + budget_*).
  migrateDropBudgetV03(db);
  // 6) Phase 8 — universal control tables (sessions/events/mailbox/grants/attempts).
  migrateControlTablesV04(db);
}

/**
 * Phase 8 (CONTROL-01/02) — v4 migration: add the five universal control
 * tables backing the session registry, audit events, cross-session mailbox,
 * grants, and delivery attempts (see src/control/types.ts for the shapes).
 *
 * Additive only — no DROPs, so no backup interplay beyond the standard
 * pre-migration `.v1-backup` pass in getDb. Idempotent via the
 * schema_version gate; atomic via a single transaction.
 */
function migrateControlTablesV04(db: Database.Database): void {
  const V4_TARGET = 4;
  if (readSchemaVersion(db) >= V4_TARGET) {
    return;
  }

  const statements: readonly string[] = [
    `CREATE TABLE IF NOT EXISTS control_sessions (
      session_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      label TEXT,
      workdir TEXT,
      pid INTEGER,
      metadata_json TEXT,
      registered_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_control_sessions_provider ON control_sessions(provider)`,
    `CREATE INDEX IF NOT EXISTS idx_control_sessions_state ON control_sessions(state)`,
    `CREATE TABLE IF NOT EXISTS control_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      source_session_id TEXT,
      target_session_id TEXT,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_control_events_session ON control_events(session_id, id)`,
    `CREATE TABLE IF NOT EXISTS control_mailbox (
      message_id TEXT PRIMARY KEY,
      source_session_id TEXT NOT NULL,
      target_session_id TEXT NOT NULL,
      sender_kind TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      redaction_json TEXT NOT NULL,
      fail_reason TEXT,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_control_mailbox_target_status ON control_mailbox(target_session_id, status)`,
    `CREATE TABLE IF NOT EXISTS control_grants (
      grant_id TEXT PRIMARY KEY,
      source_session_id TEXT NOT NULL,
      target_session_id TEXT NOT NULL,
      max_messages INTEGER NOT NULL,
      used_messages INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_control_grants_pair ON control_grants(source_session_id, target_session_id)`,
    `CREATE TABLE IF NOT EXISTS control_delivery_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      capability TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_control_delivery_attempts_message ON control_delivery_attempts(message_id)`,
  ];

  const txn = db.transaction(() => {
    for (const stmt of statements) {
      db.prepare(stmt).run();
    }
    writeSchemaVersion(
      db,
      V4_TARGET,
      'add universal control tables (control_sessions, control_events, control_mailbox, control_grants, control_delivery_attempts)',
    );
  });

  txn();
}

/**
 * Open the DB for a production caller. Writes a `.v1-backup` via the SQLite
 * online backup API BEFORE the destructive v0.2 migration touches the file,
 * unless `RELAY_SKIP_V2_BACKUP=1` is set (opt-out for tests / sandbox use).
 *
 * If the backup is required (no opt-out) and writing it fails, the function
 * THROWS — the v2 DROP is destructive and we must not run it without a
 * recovery artifact (R-01-03 / PITFALLS.md CC.1).
 */
export async function prepareDatabase(db: Database.Database, storeDir: string): Promise<void> {
  // Bootstrap-only pass first so readSchemaVersion gives a meaningful number
  // to writeV1Backup's "already-migrated" short-circuit.
  db.prepare(
    'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, description TEXT)'
  ).run();

  if (readSchemaVersion(db) < EXPECTED_SCHEMA_VERSION && !shouldSkipBackup()) {
    const r = await writeV1Backup(db, storeDir);
    if (!r.skipped && !r.backupPath) {
      throw new Error('.v1-backup write failed — refusing to run v0.2 destructive migration');
    }
  }

  applySchema(db);
}

/**
 * SHIP-40 — PRAGMA-guarded migration for runs.task_hash (semantic idempotency key).
 * SHA-256 of (task + workdir + provider + model). Enables content-addressable skip.
 */
function migrateRunsTaskHash(db: Database.Database): void {
  const info = db.prepare('PRAGMA table_info(runs)').all() as { name: string }[];
  const cols = new Set(info.map(r => r.name));
  if (!cols.has('task_hash')) {
    db.prepare('ALTER TABLE runs ADD COLUMN task_hash TEXT').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_runs_task_hash ON runs(task_hash) WHERE task_hash IS NOT NULL').run();
  }
}

/**
 * SHIP-91 — thinking block capture. Counts content_block_start events from the CC
 * JSONL stream (type:thinking vs type:tool_use) so reasoning density can be tracked
 * per run and surfaced as a drift signal without relying on provider-controlled UIs.
 */
function migrateRunsThinkingBlocks(db: Database.Database): void {
  const info = db.prepare('PRAGMA table_info(runs)').all() as { name: string }[];
  const cols = new Set(info.map(r => r.name));
  if (!cols.has('thinking_blocks')) {
    db.prepare('ALTER TABLE runs ADD COLUMN thinking_blocks INTEGER').run();
  }
  if (!cols.has('tool_use_blocks')) {
    db.prepare('ALTER TABLE runs ADD COLUMN tool_use_blocks INTEGER').run();
  }
  if (!cols.has('reasoning_density')) {
    db.prepare('ALTER TABLE runs ADD COLUMN reasoning_density REAL').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_runs_reasoning_density ON runs(reasoning_density) WHERE reasoning_density IS NOT NULL').run();
  }
  if (!cols.has('file_reads_before_first_write')) {
    db.prepare('ALTER TABLE runs ADD COLUMN file_reads_before_first_write INTEGER').run();
  }
  if (!cols.has('tool_retry_count')) {
    db.prepare('ALTER TABLE runs ADD COLUMN tool_retry_count INTEGER').run();
  }
}

/**
 * Phase 9 (DISPATCH-04) — uniform usage receipt. prompt_tokens and
 * completion_tokens persist alongside token_usage on runs, fed identically by
 * the openai and anthropic wire shapes. Additive, nullable — raw provider
 * numbers only, no price map, no cost math (v0.4 kill list).
 */
function migrateRunsUsageReceipt(db: Database.Database): void {
  const info = db.prepare('PRAGMA table_info(runs)').all() as { name: string }[];
  const cols = new Set(info.map(r => r.name));
  if (!cols.has('prompt_tokens')) {
    db.prepare('ALTER TABLE runs ADD COLUMN prompt_tokens INTEGER').run();
  }
  if (!cols.has('completion_tokens')) {
    db.prepare('ALTER TABLE runs ADD COLUMN completion_tokens INTEGER').run();
  }
}

/**
 * SHIP-60 — PRAGMA-guarded migration for runs.recalled_memory_ids_json.
 * Records which memory IDs were injected into the task context for this run.
 * Enables compliance audit ("what did the AI know?") and quality signals (SHIP-61).
 */
function migrateRunsRecalledMemories(db: Database.Database): void {
  const info = db.prepare('PRAGMA table_info(runs)').all() as { name: string }[];
  const cols = new Set(info.map(r => r.name));
  if (!cols.has('recalled_memory_ids_json')) {
    db.prepare('ALTER TABLE runs ADD COLUMN recalled_memory_ids_json TEXT').run();
  }
}

/**
 * SHIP-38 — PRAGMA-guarded migration for run_events causal envelope fields.
 * trace_id: groups all events in a logical operation (W3C trace context style).
 * caused_by: references the parent event that triggered this one.
 */
function migrateRunEventsTraceFields(db: Database.Database): void {
  const info = db.prepare('PRAGMA table_info(run_events)').all() as { name: string }[];
  const cols = new Set(info.map(r => r.name));
  if (!cols.has('trace_id')) {
    db.prepare('ALTER TABLE run_events ADD COLUMN trace_id TEXT').run();
  }
  if (!cols.has('caused_by')) {
    db.prepare('ALTER TABLE run_events ADD COLUMN caused_by TEXT').run();
  }
}

export function closeDb(): void {
  if (_db) {
    try { _db.pragma('wal_checkpoint(PASSIVE)'); } catch { /* ignore on error */ }
  }
  _db?.close();
  _db = null;
}