/**
 * Tests for schema_version helpers (Phase 1 / Task 2 GREEN).
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import Database from 'libsql';

import {
  readSchemaVersion,
  writeSchemaVersion,
  EXPECTED_SCHEMA_VERSION,
  BASELINE_SCHEMA_DESCRIPTION,
} from './schema-version.js';

function makeDb(): Database.Database {
  return new Database(':memory:');
}

function createSchemaVersionTable(db: Database.Database): void {
  db.prepare(
    'CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, description TEXT)'
  ).run();
}

describe('schema-version helpers', () => {
  test('EXPECTED_SCHEMA_VERSION is 4', () => {
    assert.equal(EXPECTED_SCHEMA_VERSION, 4);
  });

  test('readSchemaVersion returns 0 when table is missing', () => {
    const db = makeDb();
    try {
      assert.equal(readSchemaVersion(db), 0);
    } finally {
      db.close();
    }
  });

  test('readSchemaVersion returns 0 when table exists but is empty', () => {
    const db = makeDb();
    try {
      createSchemaVersionTable(db);
      assert.equal(readSchemaVersion(db), 0);
    } finally {
      db.close();
    }
  });

  test('readSchemaVersion returns 1 after bootstrap write', () => {
    const db = makeDb();
    try {
      createSchemaVersionTable(db);
      writeSchemaVersion(db, 1, BASELINE_SCHEMA_DESCRIPTION);
      assert.equal(readSchemaVersion(db), 1);
    } finally {
      db.close();
    }
  });

  test('readSchemaVersion returns 2 after v2 write', () => {
    const db = makeDb();
    try {
      createSchemaVersionTable(db);
      writeSchemaVersion(db, 1, BASELINE_SCHEMA_DESCRIPTION);
      writeSchemaVersion(db, 2, 'v0.2 cleanup');
      assert.equal(readSchemaVersion(db), 2);
    } finally {
      db.close();
    }
  });

  test('writeSchemaVersion is idempotent — repeat writes do not duplicate rows', () => {
    const db = makeDb();
    try {
      createSchemaVersionTable(db);
      writeSchemaVersion(db, 2, 'first');
      writeSchemaVersion(db, 2, 'second');
      writeSchemaVersion(db, 2, 'third');
      const row = db.prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = 2').get() as { n: number };
      assert.equal(row.n, 1);
    } finally {
      db.close();
    }
  });

  test('writeSchemaVersion preserves the first description on repeat writes', () => {
    const db = makeDb();
    try {
      createSchemaVersionTable(db);
      writeSchemaVersion(db, 2, 'first description');
      writeSchemaVersion(db, 2, 'second description');
      const row = db.prepare('SELECT description FROM schema_version WHERE version = 2').get() as { description: string };
      assert.equal(row.description, 'first description');
    } finally {
      db.close();
    }
  });

  test('readSchemaVersion returns the MAX across multiple version rows', () => {
    const db = makeDb();
    try {
      createSchemaVersionTable(db);
      writeSchemaVersion(db, 1, 'baseline');
      writeSchemaVersion(db, 2, 'v0.2');
      assert.equal(readSchemaVersion(db), 2);
    } finally {
      db.close();
    }
  });
});
