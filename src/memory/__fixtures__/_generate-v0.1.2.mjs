#!/usr/bin/env node
/**
 * Regenerate the v0.1.2-baseline.db fixture used by Phase 1 schema-cleanup tests.
 *
 * Inputs:  none (DDL inlined below from git tag v0.1.2, commit 7c7afc2).
 * Outputs: ./v0.1.2-baseline.db (binary, ≤30KB) — committed to the repo.
 *
 * Invariants (enforced by tests in src/runtime/store/migrate-v2-drop-orphans.test.ts):
 *   • Contains all 11 orphan tables (continuity_objects, recipes, sign_offs,
 *     sign_off_amendments, jobs, tasks, task_deps, job_events, proxy_requests,
 *     verifications, operator_annotations).
 *   • Contains `memories` table with ≥3 rows (one pinned, one without embedding,
 *     one with realistic tags_json + sources_json).
 *   • Does NOT contain `schema_version` (this is v0.1.2 shape — pre-Phase-1).
 *   • Populates ≥1 row in each FK-permissive orphan: continuity_objects,
 *     recipes (valid FK), proxy_requests, sign_offs, sign_off_amendments (valid
 *     FK), operator_annotations, verifications.
 *   • tasks/jobs/job_events/task_deps left EMPTY (FK chains fragile to fabricate).
 *   • All content anonymized — NO PII, NO real tokens. See README.md.
 *
 * Usage:
 *   node src/memory/__fixtures__/_generate-v0.1.2.mjs
 *
 * Determinism:
 *   • All timestamps are FIXED_TS (epoch ms) so re-running yields a byte-stable
 *     SQLite file modulo SQLite internal page layout.
 *   • IDs are deterministic strings (fix-001, fix-002, …).
 *
 * If you bump this file, regenerate AND commit both the script and the .db.
 * Update README.md if the row set changes.
 */
import Database from 'better-sqlite3';
import { unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, 'v0.1.2-baseline.db');

try { unlinkSync(OUT_PATH); } catch { /* file may not exist */ }

const FIXED_TS = 1700000000000; // anchored: 2023-11-14T22:13:20Z

const db = new Database(OUT_PATH);
db.pragma('page_size = 512');         // small pages → compact fixture (≤30KB target)
db.pragma('journal_mode = DELETE');   // no WAL/SHM sidecars
db.pragma('foreign_keys = OFF');      // bypass FK enforcement during seeding only

// ---------------------------------------------------------------------------
// DDL — inlined from git tag v0.1.2 (commit 7c7afc2) src/runtime/store/db.ts.
// Mirrors DDL_STATEMENTS array; we issue the subset needed to populate fixtures.
// Schemas that don't change in v0.2 (runs, run_events, memories core) inlined
// to keep this generator self-contained (no Relay imports).
// ---------------------------------------------------------------------------

db.exec(`
  -- 11 orphans (the cleanup target)
  CREATE TABLE IF NOT EXISTS continuity_objects (
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
  );
  CREATE TABLE IF NOT EXISTS recipes (
    recipe_id TEXT PRIMARY KEY,
    object_id TEXT NOT NULL REFERENCES continuity_objects(object_id),
    name TEXT NOT NULL,
    recipe_version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_continuity_objects_kind ON continuity_objects(object_kind);
  CREATE INDEX IF NOT EXISTS idx_continuity_objects_status ON continuity_objects(status);
  CREATE INDEX IF NOT EXISTS idx_recipes_object_id ON recipes(object_id);
  CREATE TABLE IF NOT EXISTS verifications (
    verification_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    reviewer TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    confidence_score REAL,
    verification_source TEXT CHECK(verification_source IN ('llm', 'default', 'unavailable')) DEFAULT 'llm'
  );
  CREATE INDEX IF NOT EXISTS idx_verifications_run_id ON verifications(run_id);
  CREATE TABLE IF NOT EXISTS sign_offs (
    run_id TEXT PRIMARY KEY,
    approver TEXT NOT NULL,
    signed_at INTEGER NOT NULL,
    notes TEXT,
    task_hash TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sign_offs_run_id ON sign_offs(run_id);
  CREATE TABLE IF NOT EXISTS sign_off_amendments (
    amendment_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    amended_by TEXT NOT NULL,
    amended_at INTEGER NOT NULL,
    old_notes TEXT,
    new_notes TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES sign_offs(run_id)
  );
  CREATE TRIGGER IF NOT EXISTS trg_sign_offs_no_update
    BEFORE UPDATE ON sign_offs
    WHEN OLD.approver IS NOT NULL AND (NEW.approver != OLD.approver OR NEW.signed_at != OLD.signed_at OR NEW.run_id != OLD.run_id)
    BEGIN
      SELECT RAISE(FAIL, 'sign_off records are immutable');
    END;
  CREATE TRIGGER IF NOT EXISTS trg_sign_offs_no_delete
    BEFORE DELETE ON sign_offs
    BEGIN
      SELECT RAISE(FAIL, 'sign_off records cannot be deleted');
    END;
  CREATE TABLE IF NOT EXISTS proxy_requests (
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
    created_at INTEGER NOT NULL,
    messages_json TEXT,
    response_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_proxy_requests_created_at ON proxy_requests(created_at);
  CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY,
    repo_root TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    metadata TEXT
  );
  CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(job_id),
    status TEXT NOT NULL DEFAULT 'queued',
    worker_id TEXT,
    lease_token TEXT,
    lease_expires_at INTEGER,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    result TEXT,
    claimed_at INTEGER,
    heartbeat_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS task_deps (
    job_id TEXT NOT NULL REFERENCES jobs(job_id),
    task_id TEXT NOT NULL REFERENCES tasks(task_id),
    depends_on_task_id TEXT NOT NULL REFERENCES tasks(task_id),
    PRIMARY KEY (task_id, depends_on_task_id)
  );
  CREATE TABLE IF NOT EXISTS job_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_job_id ON tasks(job_id);
  CREATE INDEX IF NOT EXISTS idx_job_events_job_id ON job_events(job_id);
  CREATE TABLE IF NOT EXISTS operator_annotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    reason TEXT NOT NULL,
    content TEXT NOT NULL,
    related_session_id TEXT,
    is_manual INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_operator_annotations_created_at ON operator_annotations(created_at);
  CREATE INDEX IF NOT EXISTS idx_operator_annotations_session ON operator_annotations(related_session_id);

  -- core memories table (preserved across v2 migration). Schema mirrors v0.1.2
  -- post-migration shape with all ALTERed columns already applied.
  CREATE TABLE IF NOT EXISTS memories (
    memory_id TEXT PRIMARY KEY,
    memory_type TEXT NOT NULL,
    content TEXT NOT NULL,
    tags_json TEXT NOT NULL DEFAULT '[]',
    workdir TEXT,
    token_count INTEGER NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    source_run_id TEXT,
    git_ref TEXT,
    superseded_by TEXT,
    created_at INTEGER NOT NULL,
    accessed_at INTEGER NOT NULL,
    expires_at INTEGER,
    entity_key TEXT,
    sources_json TEXT NOT NULL DEFAULT '[]',
    recall_count INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT,
    memory_source TEXT NOT NULL DEFAULT 'unknown',
    success_recall_count INTEGER NOT NULL DEFAULT 0,
    trust_level TEXT NOT NULL DEFAULT 'unverified',
    files_json TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);
  CREATE INDEX IF NOT EXISTS idx_memories_workdir ON memories(workdir);
  CREATE INDEX IF NOT EXISTS idx_memories_accessed ON memories(accessed_at DESC);
`);

// ---------------------------------------------------------------------------
// Seed orphan rows — populated subset (FK-permissive only)
// ---------------------------------------------------------------------------

const insertContinuity = db.prepare(`
  INSERT INTO continuity_objects (
    object_id, object_kind, status, schema_version, parent_ref,
    source_run_ids, artifact_refs, payload,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
insertContinuity.run(
  'co-fix-001', 'plan', 'draft', '1.0', 'root',
  '[]', '[]', '{"summary":"anonymized fixture continuity object"}',
  FIXED_TS, FIXED_TS
);

const insertRecipe = db.prepare(`
  INSERT INTO recipes (recipe_id, object_id, name, recipe_version, status, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
insertRecipe.run('rcp-fix-001', 'co-fix-001', 'fixture-recipe', '1.0', 'draft', FIXED_TS, FIXED_TS);

const insertVerification = db.prepare(`
  INSERT INTO verifications (verification_id, run_id, reviewer, status, reason, created_at, confidence_score, verification_source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
insertVerification.run('ver-fix-001', 'run-fix-001', 'fixture-reviewer', 'approved', 'anonymized fixture verification', FIXED_TS, 0.9, 'default');

const insertSignOff = db.prepare(`
  INSERT INTO sign_offs (run_id, approver, signed_at, notes, task_hash)
  VALUES (?, ?, ?, ?, ?)
`);
insertSignOff.run('run-fix-002', 'fixture-approver', FIXED_TS, 'anonymized fixture sign-off', 'hash-fixture');

const insertAmendment = db.prepare(`
  INSERT INTO sign_off_amendments (amendment_id, run_id, amended_by, amended_at, old_notes, new_notes)
  VALUES (?, ?, ?, ?, ?, ?)
`);
insertAmendment.run('amd-fix-001', 'run-fix-002', 'fixture-amender', FIXED_TS, 'old', 'new amended notes');

const insertProxy = db.prepare(`
  INSERT INTO proxy_requests (
    request_id, model, tool, source, prompt_preview,
    prompt_tokens, completion_tokens, cost_usd, streaming,
    duration_ms, status, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
insertProxy.run('prx-fix-001', 'fixture-model', 'fixture-tool', 'fixture-source', '[anonymized preview]', 10, 20, 0.001, 0, 100, 'completed', FIXED_TS);

const insertAnnotation = db.prepare(`
  INSERT INTO operator_annotations (actor, reason, content, related_session_id, is_manual, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);
insertAnnotation.run('fixture-operator', 'fixture-reason', 'anonymized operator annotation', 'session-fix-001', 1, FIXED_TS);

// ---------------------------------------------------------------------------
// Seed memories (3 rows): preserved across v2 migration.
// ---------------------------------------------------------------------------

const insertMemory = db.prepare(`
  INSERT INTO memories (
    memory_id, memory_type, content, tags_json, workdir, token_count,
    pinned, source_run_id, git_ref, created_at, accessed_at,
    sources_json, recall_count, memory_source, success_recall_count, trust_level, files_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
// Row 1: pinned + confirmed trust_level (anonymized content)
insertMemory.run(
  'mem-fix-001', 'lesson', 'prefer kebab-case for CSS class names',
  JSON.stringify(['css', 'naming']),
  '/fixture/workdir', 8, 1, null, null, FIXED_TS, FIXED_TS,
  JSON.stringify([]), 0, 'manual', 0, 'confirmed', JSON.stringify([])
);
// Row 2: minimal (no tags, no sources) — represents a row with no embedding_blob
insertMemory.run(
  'mem-fix-002', 'note', 'fixture note with no tags',
  JSON.stringify([]),
  '/fixture/workdir', 6, 0, null, null, FIXED_TS, FIXED_TS,
  JSON.stringify([]), 0, 'unknown', 0, 'unverified', JSON.stringify([])
);
// Row 3: realistic — populated tags + sources
insertMemory.run(
  'mem-fix-003', 'lesson', 'anonymized lesson with tags and sources',
  JSON.stringify(['fixture', 'test']),
  '/fixture/workdir', 10, 0, 'run-fix-003', 'fixture-ref-001', FIXED_TS, FIXED_TS,
  JSON.stringify([{ type: 'fixture-source', uri: 'fixture://source' }]),
  1, 'extract', 1, 'verified', JSON.stringify(['fixture-file.md'])
);

// Compact + close.
db.exec('VACUUM');
db.close();

console.log(`Fixture written: ${OUT_PATH}`);
