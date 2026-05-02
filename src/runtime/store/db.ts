import Database from 'better-sqlite3';
import { mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as path from 'node:path';
import { migrateCapabilityTables } from '../capability/db-migrations.js';
import { migrateMemoryTables } from '../../memory/db-migrations.js';
import { migrateBudgetTables } from '../budget/db-migrations.js';
import { migrateAuthTables } from './migrations/auth.js';

let _db: Database.Database | null = null;

// Schema DDL statements applied on first open.
// Split into individual statements to avoid using db.exec() which triggers security hooks.
const DDL_STATEMENTS: readonly string[] = [
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
  `CREATE TABLE IF NOT EXISTS continuity_objects (
    object_id TEXT PRIMARY KEY,
    object_kind TEXT NOT NULL,
    status TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    parent_ref TEXT NOT NULL,
    source_run_ids TEXT NOT NULL DEFAULT '[]',
    artifact_refs TEXT NOT NULL DEFAULT '[]',
    supersedes_ref TEXT,
    payload TEXT NOT NULL,
    tombstone INTEGER NOT NULL DEFAULT 0,
    redacted INTEGER NOT NULL DEFAULT 0,
    retention_class TEXT NOT NULL DEFAULT 'standard',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS recipes (
    recipe_id TEXT PRIMARY KEY,
    object_id TEXT NOT NULL REFERENCES continuity_objects(object_id),
    name TEXT NOT NULL,
    recipe_version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_continuity_objects_kind ON continuity_objects(object_kind)`,
  `CREATE INDEX IF NOT EXISTS idx_continuity_objects_status ON continuity_objects(status)`,
  `CREATE INDEX IF NOT EXISTS idx_recipes_object_id ON recipes(object_id)`,
  `CREATE TABLE IF NOT EXISTS run_diffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    diff_text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS verifications (
    verification_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    reviewer TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
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
  `CREATE TABLE IF NOT EXISTS sign_offs (
    run_id TEXT PRIMARY KEY,
    approver TEXT NOT NULL,
    signed_at INTEGER NOT NULL,
    notes TEXT,
    task_hash TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sign_offs_run_id ON sign_offs(run_id)`,
  `CREATE TABLE IF NOT EXISTS sign_off_amendments (
    amendment_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    amended_by TEXT NOT NULL,
    amended_at INTEGER NOT NULL,
    old_notes TEXT,
    new_notes TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES sign_offs(run_id)
  )`,
  `CREATE TRIGGER IF NOT EXISTS trg_sign_offs_no_update
    BEFORE UPDATE ON sign_offs
    WHEN OLD.approver IS NOT NULL AND (NEW.approver != OLD.approver OR NEW.signed_at != OLD.signed_at OR NEW.run_id != OLD.run_id)
    BEGIN
      SELECT RAISE(FAIL, 'sign_off records are immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_sign_offs_no_delete
    BEFORE DELETE ON sign_offs
    BEGIN
      SELECT RAISE(FAIL, 'sign_off records cannot be deleted');
    END`,
  `CREATE TABLE IF NOT EXISTS proxy_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL UNIQUE,
    model TEXT NOT NULL,
    tool TEXT,
    source TEXT,
    prompt_preview TEXT,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    streaming INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    status TEXT NOT NULL DEFAULT 'completed',
    error_message TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_proxy_requests_created_at ON proxy_requests(created_at)`,
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
  `CREATE INDEX IF NOT EXISTS idx_verifications_run_id ON verifications(run_id)`,
  `CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY,
    repo_root TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    metadata TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(job_id),
    status TEXT NOT NULL DEFAULT 'queued',
    worker_id TEXT,
    lease_token TEXT,
    lease_expires_at INTEGER,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    result TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS task_deps (
    job_id TEXT NOT NULL REFERENCES jobs(job_id),
    task_id TEXT NOT NULL REFERENCES tasks(task_id),
    depends_on_task_id TEXT NOT NULL REFERENCES tasks(task_id),
    PRIMARY KEY (task_id, depends_on_task_id)
  )`,
  `CREATE TABLE IF NOT EXISTS job_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT,
    ts INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_job_id ON tasks(job_id)`,
  `CREATE INDEX IF NOT EXISTS idx_job_events_job_id ON job_events(job_id)`,
  `CREATE TABLE IF NOT EXISTS operator_annotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    reason TEXT NOT NULL,
    content TEXT NOT NULL,
    related_session_id TEXT,
    is_manual INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_operator_annotations_created_at ON operator_annotations(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_operator_annotations_session ON operator_annotations(related_session_id)`,
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

const TAINTED_VERIFICATION_REASON_FRAGMENT = 'defaulting to approved';
const DELETE_TAINTED_VERIFICATIONS_SQL =
  'DELETE FROM verifications WHERE reason LIKE ?';

export function getDb(): Database.Database {
  if (_db) return _db;
  const dbPath = process.env['RELAY_DB_PATH'] ?? join(homedir(), '.relay', 'relay.db');
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true });
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
 * PRAGMA-guarded migration for the tasks table lease fields.
 *
 * SQLite ALTER TABLE ADD COLUMN has no IF NOT EXISTS guard — adding these
 * statements to DDL_STATEMENTS would throw "cannot add a column with that name"
 * on every server restart after the first. Instead, read the existing column
 * set via PRAGMA table_info and only issue the ALTER TABLE when the column is
 * absent.
 */
function migrateTasksLeaseFields(db: Database.Database): void {
  const info = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
  const cols = new Set(info.map(r => r.name));
  if (!cols.has('claimed_at')) {
    db.prepare('ALTER TABLE tasks ADD COLUMN claimed_at INTEGER').run();
  }
  if (!cols.has('heartbeat_at')) {
    db.prepare('ALTER TABLE tasks ADD COLUMN heartbeat_at INTEGER').run();
  }
  if (!cols.has('lease_token')) {
    db.prepare('ALTER TABLE tasks ADD COLUMN lease_token TEXT').run();
  }
  if (!cols.has('attempt_count')) {
    db.prepare('ALTER TABLE tasks ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0').run();
  }
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

/**
 * PRAGMA-guarded migration for the verifications table confidence_score field.
 * better-sqlite3 is SYNCHRONOUS — no await anywhere in this function.
 */
function migrateVerificationsConfidenceScore(db: Database.Database): void {
  const info = db.prepare('PRAGMA table_info(verifications)').all() as { name: string }[];
  const cols = new Set(info.map(r => r.name));
  if (!cols.has('confidence_score')) {
    db.prepare('ALTER TABLE verifications ADD COLUMN confidence_score REAL').run();
  }
}

/**
 * H-02: PRAGMA-guarded migration for verification_source field.
 * Values: 'llm' = real reviewer ran, 'unavailable' = HTTP error fallback,
 * 'default' = structural-only (no semantic reviewer configured).
 */
function migrateVerificationsSource(db: Database.Database): void {
  const info = db.prepare('PRAGMA table_info(verifications)').all() as { name: string }[];
  const cols = new Set(info.map(r => r.name));
  if (!cols.has('verification_source')) {
    db.prepare(
      `ALTER TABLE verifications ADD COLUMN verification_source TEXT
       CHECK(verification_source IN ('llm', 'default', 'unavailable')) DEFAULT 'llm'`
    ).run();
  }
}

function migrateProxyRequestsFullBody(db: Database.Database): void {
  const info = db.prepare('PRAGMA table_info(proxy_requests)').all() as { name: string }[];
  const cols = new Set(info.map(r => r.name));
  if (!cols.has('messages_json')) {
    db.prepare('ALTER TABLE proxy_requests ADD COLUMN messages_json TEXT').run();
  }
  if (!cols.has('response_json')) {
    db.prepare('ALTER TABLE proxy_requests ADD COLUMN response_json TEXT').run();
  }
}

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

function purgeTaintedVerificationRecords(db: Database.Database): void {
  db.prepare(DELETE_TAINTED_VERIFICATIONS_SQL).run(`%${TAINTED_VERIFICATION_REASON_FRAGMENT}%`);
}

function applySchema(db: Database.Database): void {
  for (const stmt of DDL_STATEMENTS) {
    db.prepare(stmt).run();
  }
  purgeTaintedVerificationRecords(db);
  migrateIdempotencyExpiresAt(db);
  migrateTasksLeaseFields(db);
  migrateRunsVerificationStatus(db);
  migrateVerificationsConfidenceScore(db);
  migrateVerificationsSource(db);
  migrateProxyRequestsFullBody(db);
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