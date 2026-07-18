/**
 * PLAN-5 T1 — Migration: `conflicts_with_json` column.
 *
 * Confirms `migrateMemoryTables(db)` adds a NOT NULL TEXT `conflicts_with_json`
 * column with DEFAULT '[]', that running the migration twice is idempotent,
 * that legacy rows inserted before the column existed read back '[]', and
 * that explicit JSON values round-trip intact.
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

describe('migrateMemoryTables — conflicts_with_json column (PLAN-5 T1)', () => {
  test('adds NOT NULL TEXT conflicts_with_json column with DEFAULT "[]" on first migration', () => {
    const db = new Database(':memory:');

    migrateMemoryTables(db);

    const cols = columnInfo(db, 'memories');
    const col = cols.find((c) => c.name === 'conflicts_with_json');
    assert.ok(col, 'conflicts_with_json column must exist after migration');
    assert.strictEqual(
      col.type.toUpperCase(),
      'TEXT',
      'conflicts_with_json column type must be TEXT'
    );
    assert.strictEqual(
      col.notnull,
      1,
      'conflicts_with_json column must be NOT NULL'
    );
    // SQLite stores DEFAULT '[]' as the literal text "'[]'" (with quotes) in PRAGMA table_info.
    assert.strictEqual(
      String(col.dflt_value).replace(/'/g, ''),
      '[]',
      'conflicts_with_json default must be empty JSON array'
    );
  });

  test('migration is idempotent — second call leaves the column count unchanged', () => {
    const db = new Database(':memory:');

    migrateMemoryTables(db);
    assert.doesNotThrow(() => migrateMemoryTables(db));

    const cols = columnInfo(db, 'memories');
    const matching = cols.filter((c) => c.name === 'conflicts_with_json');
    assert.strictEqual(
      matching.length,
      1,
      'conflicts_with_json must appear exactly once after two migrations'
    );
  });

  test('row inserted via 18-col INSERT (omitting conflicts_with_json) reads back as "[]"', () => {
    const db = new Database(':memory:');
    migrateMemoryTables(db);

    // Simulate legacy INSERT: omit conflicts_with_json — DEFAULT should fire.
    const now = Date.now();
    db.prepare(
      `INSERT INTO memories (
        memory_id, memory_type, content, tags_json, workdir,
        token_count, pinned, source_run_id, git_ref,
        superseded_by, created_at, accessed_at, expires_at,
        entity_key, sources_json, content_hash, memory_source, files_json,
        trust_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'legacy-1',
      'fact',
      'legacy row',
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
      .prepare(`SELECT conflicts_with_json FROM memories WHERE memory_id = ?`)
      .get('legacy-1') as { conflicts_with_json: string };

    assert.strictEqual(row.conflicts_with_json, '[]');
  });

  test('row inserted with explicit conflicts_with_json round-trips intact', () => {
    const db = new Database(':memory:');
    migrateMemoryTables(db);

    const payload = JSON.stringify(['abc', 'def']);
    const now = Date.now();
    db.prepare(
      `INSERT INTO memories (
        memory_id, memory_type, content, tags_json, workdir,
        token_count, pinned, source_run_id, git_ref,
        superseded_by, created_at, accessed_at, expires_at,
        entity_key, sources_json, content_hash, memory_source, files_json,
        trust_level, conflicts_with_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'explicit-1',
      'lesson',
      'with conflicts',
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
      payload
    );

    const row = db
      .prepare(`SELECT conflicts_with_json FROM memories WHERE memory_id = ?`)
      .get('explicit-1') as { conflicts_with_json: string };

    assert.strictEqual(row.conflicts_with_json, payload);
    const parsed = JSON.parse(row.conflicts_with_json) as string[];
    assert.deepEqual(parsed, ['abc', 'def']);
  });
});
