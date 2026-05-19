/**
 * Tests for the v0.2 schema cleanup migration (Phase 1).
 *
 * RED phase: assertions are written against the public contract of
 *   src/runtime/store/migrate-v2-drop-orphans.ts
 *   src/runtime/store/schema-version.ts
 *   src/runtime/store/db.ts (prepareDatabase export)
 * before any implementation exists. The imports must fail to resolve until
 * Task 2/Task 3 land their GREEN implementations.
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { migrateDropOrphansV02 } from './migrate-v2-drop-orphans.js';
import { readSchemaVersion, EXPECTED_SCHEMA_VERSION } from './schema-version.js';
import { applySchema, prepareDatabase } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '..', '..', 'memory', '__fixtures__', 'v0.1.2-baseline.db');

const ORPHAN_TABLES = [
  'continuity_objects',
  'recipes',
  'sign_offs',
  'sign_off_amendments',
  'jobs',
  'tasks',
  'task_deps',
  'job_events',
  'proxy_requests',
  'verifications',
  'operator_annotations',
];

function freshTmpFromFixture(): { dir: string; db: string } {
  const dir = mkdtempSync(join(tmpdir(), 'relay-fix-'));
  const dbPath = join(dir, 'relay.db');
  copyFileSync(FIXTURE, dbPath);
  return { dir, db: dbPath };
}

function listTables(db: Database.Database): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  return new Set(rows.map(r => r.name));
}

describe('migrate-v2-drop-orphans — fixture-based upgrade path', () => {
  test('T1: v0.1.2 fixture → applySchema → schema_version row exists at expected version', () => {
    const { dir, db: dbPath } = freshTmpFromFixture();
    try {
      const db = new Database(dbPath);
      applySchema(db);
      const v = readSchemaVersion(db);
      assert.equal(v, EXPECTED_SCHEMA_VERSION, `expected schema_version=${EXPECTED_SCHEMA_VERSION}, got ${v}`);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T2: v0.1.2 fixture → applySchema → all 11 orphan tables absent from sqlite_master', () => {
    const { dir, db: dbPath } = freshTmpFromFixture();
    try {
      const db = new Database(dbPath);
      applySchema(db);
      const tables = listTables(db);
      for (const orphan of ORPHAN_TABLES) {
        assert.equal(tables.has(orphan), false, `orphan table "${orphan}" should be DROPped post-migration`);
      }
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T3: v0.1.2 fixture → applySchema → memory rows unchanged', () => {
    const { dir, db: dbPath } = freshTmpFromFixture();
    try {
      // Count rows in the pristine fixture first
      const fixtureDb = new Database(dbPath, { readonly: true });
      const before = (fixtureDb.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
      fixtureDb.close();
      assert.ok(before >= 3, `fixture should have >=3 memory rows (got ${before})`);

      // Run migration via applySchema and re-count
      const db = new Database(dbPath);
      applySchema(db);
      const after = (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
      assert.equal(after, before, `memory row count must be preserved (before=${before}, after=${after})`);

      // Spot-check that the pinned row's content survived intact
      const pinned = db.prepare("SELECT content, trust_level, pinned FROM memories WHERE memory_id = 'mem-fix-001'").get() as { content: string; trust_level: string; pinned: number } | undefined;
      assert.ok(pinned, 'mem-fix-001 must still exist');
      assert.equal(pinned?.pinned, 1, 'mem-fix-001 should still be pinned');
      assert.equal(pinned?.trust_level, 'confirmed', 'mem-fix-001 trust_level should survive intact');
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T4: v0.1.2 fixture → applySchema → applySchema again is a no-op (idempotency)', () => {
    const { dir, db: dbPath } = freshTmpFromFixture();
    try {
      const db = new Database(dbPath);
      applySchema(db);
      // Second pass MUST NOT throw and MUST NOT duplicate the version=2 row
      applySchema(db);
      const count = (db.prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = ?').get(EXPECTED_SCHEMA_VERSION) as { n: number }).n;
      assert.equal(count, 1, `schema_version row for v=${EXPECTED_SCHEMA_VERSION} must not duplicate on re-run (got ${count})`);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T5: empty DB → applySchema → schema_version=expected, no orphans created', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-empty-'));
    try {
      const dbPath = join(dir, 'relay.db');
      const db = new Database(dbPath);
      applySchema(db);
      const v = readSchemaVersion(db);
      assert.equal(v, EXPECTED_SCHEMA_VERSION);
      const tables = listTables(db);
      for (const orphan of ORPHAN_TABLES) {
        assert.equal(tables.has(orphan), false, `orphan table "${orphan}" must NOT be re-created on a fresh DB`);
      }
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T6: prepareDatabase writes .v1-backup before v2 migration completes', async () => {
    const { dir, db: dbPath } = freshTmpFromFixture();
    // Ensure no opt-out leaked from caller
    const savedSkip = process.env['RELAY_SKIP_V2_BACKUP'];
    delete process.env['RELAY_SKIP_V2_BACKUP'];
    try {
      const db = new Database(dbPath);
      await prepareDatabase(db, dir);
      const backupPath = join(dir, '.v1-backup');
      assert.equal(existsSync(backupPath), true, '.v1-backup must exist after prepareDatabase on a v0.1.2 DB');
      // Backup is a valid SQLite file containing orphan content
      const backup = new Database(backupPath, { readonly: true });
      const continuityRow = backup.prepare("SELECT object_id FROM continuity_objects WHERE object_id = 'co-fix-001'").get();
      assert.ok(continuityRow, '.v1-backup must contain the original continuity_objects row');
      backup.close();
      // Migrated DB must NOT contain orphans anymore
      const tables = listTables(db);
      assert.equal(tables.has('continuity_objects'), false, 'migrated DB must not contain continuity_objects');
      db.close();
    } finally {
      if (savedSkip === undefined) delete process.env['RELAY_SKIP_V2_BACKUP'];
      else process.env['RELAY_SKIP_V2_BACKUP'] = savedSkip;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T7: RELAY_SKIP_V2_BACKUP=1 → prepareDatabase does NOT write .v1-backup', async () => {
    const { dir, db: dbPath } = freshTmpFromFixture();
    const savedSkip = process.env['RELAY_SKIP_V2_BACKUP'];
    process.env['RELAY_SKIP_V2_BACKUP'] = '1';
    try {
      const db = new Database(dbPath);
      await prepareDatabase(db, dir);
      const backupPath = join(dir, '.v1-backup');
      assert.equal(existsSync(backupPath), false, '.v1-backup must NOT exist when RELAY_SKIP_V2_BACKUP=1');
      // Migration still ran
      assert.equal(readSchemaVersion(db), EXPECTED_SCHEMA_VERSION);
      db.close();
    } finally {
      if (savedSkip === undefined) delete process.env['RELAY_SKIP_V2_BACKUP'];
      else process.env['RELAY_SKIP_V2_BACKUP'] = savedSkip;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('fixture sanity', () => {
  test('fixture file exists and is under 30KB', () => {
    assert.equal(existsSync(FIXTURE), true, `fixture must exist at ${FIXTURE}`);
    const st = statSync(FIXTURE);
    assert.ok(st.size <= 30 * 1024, `fixture must be ≤30KB (got ${st.size} bytes)`);
  });

  test('fixture contains all 11 orphan tables populated where FK-permissive', () => {
    const db = new Database(FIXTURE, { readonly: true });
    try {
      const tables = listTables(db);
      for (const t of ORPHAN_TABLES) {
        assert.equal(tables.has(t), true, `fixture must contain orphan table "${t}"`);
      }
      // FK-permissive tables must have ≥1 row
      const populated = [
        'continuity_objects',
        'recipes',
        'verifications',
        'sign_offs',
        'sign_off_amendments',
        'proxy_requests',
        'operator_annotations',
      ];
      for (const t of populated) {
        const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
        assert.ok(n >= 1, `fixture orphan "${t}" must have >=1 row (got ${n})`);
      }
    } finally {
      db.close();
    }
  });
});
