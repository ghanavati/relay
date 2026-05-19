import Database from 'better-sqlite3';
import { mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as path from 'node:path';
import { migrateCapabilityTables } from '../capability/db-migrations.js';
import { migrateMemoryTables } from '../../memory/db-migrations.js';
import { migrateBudgetTables } from '../budget/db-migrations.js';
import { migrateAuthTables } from './migrations/auth.js';
import {
  readSchemaVersion,
  writeSchemaVersion,
  EXPECTED_SCHEMA_VERSION,
  BASELINE_SCHEMA_DESCRIPTION,
} from './schema-version.js';
import { migrateDropOrphansV02 } from './migrate-v2-drop-orphans.js';
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
  `CREATE TABLE IF NOT EXISTS cost_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0.0,
    workdir TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
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
  `CREATE INDEX IF NOT EXISTS idx_cost_events_run_id ON cost_events(run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_cost_events_workdir ON cost_events(workdir)`,
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
  migrateBudgetTables(db);
  migrateRunsTaskHash(db);
  migrateRunEventsTraceFields(db);
  migrateRunsRecalledMemories(db);
  migrateRunsThinkingBlocks(db);
  migrateCostEventsTextColumn(db);
  migrateAuthTables(db);
  // 4) v0.2 cleanup — drop 11 orphan tables (idempotent; no-op once v=2 is set).
  migrateDropOrphansV02(db);
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
 * SHIP-102 — adds cost_usd_text TEXT to cost_events for audit-safe decimal representation.
 * cost_usd REAL stays for backward compat; cost_usd_text is the canonical audit value.
 */
function migrateCostEventsTextColumn(db: Database.Database): void {
  const info = db.prepare('PRAGMA table_info(cost_events)').all() as { name: string }[];
  const cols = new Set(info.map(r => r.name));
  if (!cols.has('cost_usd_text')) {
    db.prepare('ALTER TABLE cost_events ADD COLUMN cost_usd_text TEXT').run();
    db.prepare("UPDATE cost_events SET cost_usd_text = printf('%.8f', cost_usd) WHERE cost_usd_text IS NULL").run();
  }
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