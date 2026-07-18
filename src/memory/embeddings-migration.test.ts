/**
 * PLAN-4 T1 — Migration: `embedding_blob` column.
 *
 * Confirms `migrateMemoryTables(db)` adds a nullable BLOB `embedding_blob`
 * column to the memories table, that running the migration twice is a no-op,
 * and that rows can be inserted with a NULL embedding.
 */

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import Database from 'libsql';
import { migrateMemoryTables } from './db-migrations.js';

interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: unknown;
  readonly pk: number;
}

function columnInfo(db: Database.Database, table: string): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
}

function createBaseMemoriesTable(db: Database.Database): void {
  // Recreate the legacy CREATE TABLE shape (before any embedding column exists)
  // to simulate an existing DB predating this migration. PRE_ALTER_DDL already
  // omits embedding_blob, so we just run the migration *without* the embedding
  // step to seed the baseline — easier path: run migrateMemoryTables once with
  // a DB lacking the column, then assert the column was added.
  migrateMemoryTables(db);
}

describe('migrateMemoryTables — embedding_model column (PLAN-4 T1)', () => {
  test('adds nullable TEXT embedding_model column on first migration', () => {
    const db = new Database(':memory:');

    migrateMemoryTables(db);

    const cols = columnInfo(db, 'memories');
    const model = cols.find((c) => c.name === 'embedding_model');
    assert.ok(model, 'embedding_model column must exist after migration');
    assert.strictEqual(
      model.type.toUpperCase(),
      'TEXT',
      'embedding_model column type must be TEXT'
    );
    assert.strictEqual(
      model.notnull,
      0,
      'embedding_model column must be nullable (NULL = not yet embedded)'
    );
    assert.strictEqual(
      model.dflt_value,
      null,
      'embedding_model must have no DEFAULT (NULL = not yet embedded)'
    );
  });

  test('embedding_model migration is idempotent (second call does not duplicate column)', () => {
    const db = new Database(':memory:');

    migrateMemoryTables(db);
    assert.doesNotThrow(() => migrateMemoryTables(db));

    const cols = columnInfo(db, 'memories');
    const modelCols = cols.filter((c) => c.name === 'embedding_model');
    assert.strictEqual(
      modelCols.length,
      1,
      'embedding_model must appear exactly once after two migrations'
    );
  });

  test('row can be inserted with NULL embedding_model and read back as null', () => {
    const db = new Database(':memory:');
    migrateMemoryTables(db);

    const now = Date.now();
    db.prepare(
      `INSERT INTO memories (
        memory_id, memory_type, content, tags_json, workdir,
        token_count, pinned, source_run_id, git_ref,
        superseded_by, created_at, accessed_at, expires_at,
        entity_key, sources_json, content_hash, memory_source, files_json,
        trust_level, embedding_blob, embedding_model
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`
    ).run(
      'em-test-1',
      'fact',
      'no model yet',
      '[]',
      null,
      3,
      0,
      null,
      null,
      now,
      now,
      null,
      null,
      '[]',
      null,
      'unknown',
      '[]',
      'unverified'
    );

    const row = db
      .prepare(`SELECT embedding_model FROM memories WHERE memory_id = ?`)
      .get('em-test-1') as { embedding_model: string | null };

    assert.strictEqual(row.embedding_model, null);
  });

  test('row can be inserted with embedding_model populated', () => {
    const db = new Database(':memory:');
    migrateMemoryTables(db);

    const now = Date.now();
    db.prepare(
      `INSERT INTO memories (
        memory_id, memory_type, content, tags_json, workdir,
        token_count, pinned, source_run_id, git_ref,
        superseded_by, created_at, accessed_at, expires_at,
        entity_key, sources_json, content_hash, memory_source, files_json,
        trust_level, embedding_blob, embedding_model
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
    ).run(
      'em-test-2',
      'fact',
      'model populated',
      '[]',
      null,
      3,
      0,
      null,
      null,
      now,
      now,
      null,
      null,
      '[]',
      null,
      'unknown',
      '[]',
      'unverified',
      'text-embedding-nomic-embed-text-v1.5'
    );

    const row = db
      .prepare(`SELECT embedding_model FROM memories WHERE memory_id = ?`)
      .get('em-test-2') as { embedding_model: string | null };

    assert.strictEqual(row.embedding_model, 'text-embedding-nomic-embed-text-v1.5');
  });
});

describe('migrateMemoryTables — embedding_blob column', () => {
  test('adds nullable BLOB embedding_blob column on first migration', () => {
    const db = new Database(':memory:');

    migrateMemoryTables(db);

    const cols = columnInfo(db, 'memories');
    const embedding = cols.find((c) => c.name === 'embedding_blob');
    assert.ok(embedding, 'embedding_blob column must exist after migration');
    assert.strictEqual(
      embedding.type.toUpperCase(),
      'BLOB',
      'embedding_blob column type must be BLOB'
    );
    assert.strictEqual(
      embedding.notnull,
      0,
      'embedding_blob column must be nullable'
    );
    assert.strictEqual(
      embedding.dflt_value,
      null,
      'embedding_blob must have no DEFAULT'
    );
  });

  test('migration is idempotent (second call does not duplicate column or throw)', () => {
    const db = new Database(':memory:');

    migrateMemoryTables(db);
    // Second call must not throw and must not duplicate the column
    assert.doesNotThrow(() => migrateMemoryTables(db));

    const cols = columnInfo(db, 'memories');
    const embeddingCols = cols.filter((c) => c.name === 'embedding_blob');
    assert.strictEqual(
      embeddingCols.length,
      1,
      'embedding_blob must appear exactly once after two migrations'
    );
  });

  test('can insert a row with embedding_blob = NULL and read it back as null', () => {
    const db = new Database(':memory:');
    migrateMemoryTables(db);

    const now = Date.now();
    db.prepare(
      `INSERT INTO memories (
        memory_id, memory_type, content, tags_json, workdir,
        token_count, pinned, source_run_id, git_ref,
        superseded_by, created_at, accessed_at, expires_at,
        entity_key, sources_json, content_hash, memory_source, files_json,
        trust_level, embedding_blob
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    ).run(
      'test-memory-1',
      'fact',
      'hello world',
      '[]',
      null,
      3,
      0,
      null,
      null,
      now,
      now,
      null,
      null,
      '[]',
      null,
      'unknown',
      '[]',
      'unverified'
    );

    const row = db
      .prepare(`SELECT embedding_blob FROM memories WHERE memory_id = ?`)
      .get('test-memory-1') as { embedding_blob: Buffer | null };

    assert.strictEqual(row.embedding_blob, null);
  });

  test('can insert a row with a 3072-byte embedding_blob and read it back', () => {
    const db = new Database(':memory:');
    migrateMemoryTables(db);

    // 768 little-endian float32 values = 3072 bytes
    const vec = new Float32Array(768);
    for (let i = 0; i < 768; i++) vec[i] = i / 768;
    const blob = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    assert.strictEqual(blob.length, 3072, 'fixture sanity: 768 × 4 = 3072 bytes');

    const now = Date.now();
    db.prepare(
      `INSERT INTO memories (
        memory_id, memory_type, content, tags_json, workdir,
        token_count, pinned, source_run_id, git_ref,
        superseded_by, created_at, accessed_at, expires_at,
        entity_key, sources_json, content_hash, memory_source, files_json,
        trust_level, embedding_blob
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'test-memory-2',
      'fact',
      'hello world',
      '[]',
      null,
      3,
      0,
      null,
      null,
      now,
      now,
      null,
      null,
      '[]',
      null,
      'unknown',
      '[]',
      'unverified',
      blob
    );

    const row = db
      .prepare(`SELECT embedding_blob FROM memories WHERE memory_id = ?`)
      .get('test-memory-2') as { embedding_blob: Buffer };

    assert.ok(row.embedding_blob);
    assert.strictEqual(row.embedding_blob.length, 3072);
    // Round-trip the BLOB into a Float32Array and compare
    const back = new Float32Array(
      row.embedding_blob.buffer,
      row.embedding_blob.byteOffset,
      768
    );
    assert.strictEqual(back.length, 768);
    assert.strictEqual(back[0], 0);
    assert.ok(Math.abs(back[100]! - 100 / 768) < 1e-6);
    assert.ok(Math.abs(back[767]! - 767 / 768) < 1e-6);
  });
});
