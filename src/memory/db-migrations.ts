/**
 * Memory table DDL — PRAGMA-guarded migration.
 *
 * Same pattern as capability tables: safe to call on every startup.
 * Uses CREATE TABLE IF NOT EXISTS + PRAGMA table_info guard for ALTERs.
 */

import type Database from 'libsql';

/**
 * Tables created up-front. Indexes/triggers that depend on optional columns
 * (e.g. `entity_key`) live in POST_ALTER_DDL — they must run AFTER ALTERs that
 * add those columns to old DBs.
 */
const PRE_ALTER_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS memories (
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
    sources_json TEXT NOT NULL DEFAULT '[]'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_workdir ON memories(workdir)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_accessed ON memories(accessed_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC)`,
];

const POST_ALTER_DDL: readonly string[] = [
  // Index that needs entity_key column — must run AFTER PRAGMA-ALTERs.
  `CREATE INDEX IF NOT EXISTS idx_memories_entity_key ON memories(entity_key, workdir)`,
  // FTS5 semantic search — content table reads from memories, rowid-mapped
  `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
   USING fts5(content, memory_id UNINDEXED, content=memories, content_rowid=rowid)`,
  // Insert trigger: keep FTS in sync as new memories arrive
  `CREATE TRIGGER IF NOT EXISTS memories_fts_insert
   AFTER INSERT ON memories BEGIN
     INSERT INTO memories_fts(rowid, content, memory_id)
     VALUES (new.rowid, new.content, new.memory_id);
   END`,
  // Delete trigger: remove from FTS when a memory is hard-deleted
  `CREATE TRIGGER IF NOT EXISTS memories_fts_delete
   AFTER DELETE ON memories BEGIN
     INSERT INTO memories_fts(memories_fts, rowid, content, memory_id)
     VALUES ('delete', old.rowid, old.content, old.memory_id);
   END`,
];

export function migrateMemoryTables(db: Database.Database): void {
  // 1. Tables + non-conditional indexes (independent of optional columns).
  for (const stmt of PRE_ALTER_DDL) {
    db.prepare(stmt).run();
  }

  // 2. PRAGMA-guarded ALTERs for existing databases that predate these columns.
  const existingCols = new Set(
    (db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>).map(r => r.name)
  );
  if (!existingCols.has('entity_key')) {
    db.prepare('ALTER TABLE memories ADD COLUMN entity_key TEXT').run();
  }
  if (!existingCols.has('sources_json')) {
    db.prepare("ALTER TABLE memories ADD COLUMN sources_json TEXT NOT NULL DEFAULT '[]'").run();
  }
  if (!existingCols.has('recall_count')) {
    db.prepare('ALTER TABLE memories ADD COLUMN recall_count INTEGER NOT NULL DEFAULT 0').run();
  }
  if (!existingCols.has('content_hash')) {
    db.prepare('ALTER TABLE memories ADD COLUMN content_hash TEXT').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash, created_at DESC)').run();
  }
  if (!existingCols.has('memory_source')) {
    db.prepare("ALTER TABLE memories ADD COLUMN memory_source TEXT NOT NULL DEFAULT 'unknown'").run();
  }
  if (!existingCols.has('success_recall_count')) {
    db.prepare('ALTER TABLE memories ADD COLUMN success_recall_count INTEGER NOT NULL DEFAULT 0').run();
  }
  if (!existingCols.has('trust_level')) {
    db.prepare("ALTER TABLE memories ADD COLUMN trust_level TEXT NOT NULL DEFAULT 'unverified'").run();
  }
  if (!existingCols.has('files_json')) {
    db.prepare("ALTER TABLE memories ADD COLUMN files_json TEXT NOT NULL DEFAULT '[]'").run();
  }
  // PLAN-4 §5 — semantic embeddings. Nullable BLOB so legacy rows keep working
  // and the word-overlap fallback path stays valid. 3072 bytes when populated
  // (768 little-endian float32). No index — cosine is computed in JS over the
  // FTS-narrowed candidate set (<=500 rows per recall).
  if (!existingCols.has('embedding_blob')) {
    db.prepare('ALTER TABLE memories ADD COLUMN embedding_blob BLOB').run();
  }
  // PLAN-4 T1 (cross-model rejection per PITFALL 2.3) — record which embedding
  // model produced `embedding_blob`. Nullable TEXT, NO DEFAULT (NULL = not yet
  // embedded, mirroring embedding_blob IS NULL). Cross-model rows (e.g. a
  // row embedded with 'bge-large-en-v1.5' while the active model is
  // 'nomic-embed-text-v1.5') get excluded from cosine similarity by
  // semantic-similarities.ts. Without this column a silent model swap would
  // mix vector spaces and corrupt recall.
  if (!existingCols.has('embedding_model')) {
    db.prepare('ALTER TABLE memories ADD COLUMN embedding_model TEXT').run();
  }
  // PLAN-5 T1 (CONFLICT-01) — write-time conflict detection stores reciprocal
  // memory_ids as a JSON array. NOT NULL DEFAULT '[]' means legacy rows read
  // safely without a backfill pass: '[]' = "no known conflicts" matches the
  // pre-Phase-5 behavior bit-exactly. Recall annotation only fires when a
  // memory's array is non-empty, so v0.1.2 → v0.2 upgrade observes no change.
  if (!existingCols.has('conflicts_with_json')) {
    db.prepare("ALTER TABLE memories ADD COLUMN conflicts_with_json TEXT NOT NULL DEFAULT '[]'").run();
  }

  // 3. Indexes/triggers that depend on the columns added in step 2.
  for (const stmt of POST_ALTER_DDL) {
    db.prepare(stmt).run();
  }

  // Populate FTS index for any memories that existed before this migration.
  // Safe to call repeatedly: `merge=-1` is a no-op on an already-current index.
  const ftsTableExists = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'")
      .get() as { name: string } | undefined
  ) !== undefined;
  if (ftsTableExists) {
    const ftsRowCount = (db.prepare('SELECT count(*) as n FROM memories_fts').get() as { n: number }).n;
    const memRowCount = (db.prepare('SELECT count(*) as n FROM memories').get() as { n: number }).n;
    if (ftsRowCount === 0 && memRowCount > 0) {
      db.prepare("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')").run();
    }
  }
}