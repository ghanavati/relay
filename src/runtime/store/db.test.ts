/**
 * applySchema / prepareDatabase integration tests.
 *
 * Covers the contract that on a FRESH (empty) DB:
 *  1. schema_version contains BOTH version=1 (bootstrap) and version=2
 *     (orphan-drop migration) rows.
 *  2. None of the 11 orphan tables are (re)created.
 *  3. Re-running applySchema is a no-op — no duplicate rows, no errors,
 *     no re-DROP attempts.
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { applySchema } from './db.js';

const ORPHAN_TABLES = [
  'continuity_objects', 'recipes', 'sign_offs', 'sign_off_amendments',
  'jobs', 'tasks', 'task_deps', 'job_events', 'proxy_requests',
  'verifications', 'operator_annotations',
];

function withTmpDb<T>(run: (db: Database.Database) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'relay-db-'));
  const dbPath = join(dir, 'relay.db');
  const db = new Database(dbPath);
  try {
    return run(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('db.ts — applySchema on fresh DB', () => {
  test('writes schema_version=1 (bootstrap) AND schema_version=2 (v2 cleanup)', () => {
    withTmpDb(db => {
      applySchema(db);
      const rows = db.prepare('SELECT version FROM schema_version ORDER BY version').all() as Array<{ version: number }>;
      const versions = rows.map(r => r.version);
      assert.deepEqual(versions, [1, 2], `expected [1,2], got ${JSON.stringify(versions)}`);
    });
  });

  test('does not create any of the 11 orphan tables on a fresh DB', () => {
    withTmpDb(db => {
      applySchema(db);
      const present = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
        .map(r => r.name);
      for (const t of ORPHAN_TABLES) {
        assert.equal(present.includes(t), false, `orphan table "${t}" must not be present after applySchema`);
      }
    });
  });

  test('second applySchema call is a no-op — no duplicate version rows, no errors', () => {
    withTmpDb(db => {
      applySchema(db);
      assert.doesNotThrow(() => applySchema(db));
      const v1Count = (db.prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = 1').get() as { n: number }).n;
      const v2Count = (db.prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = 2').get() as { n: number }).n;
      assert.equal(v1Count, 1, `version=1 should appear exactly once (got ${v1Count})`);
      assert.equal(v2Count, 1, `version=2 should appear exactly once (got ${v2Count})`);
    });
  });

  test('memories table is created with FTS5 sibling (regression: orphan removal must not break memory DDL)', () => {
    withTmpDb(db => {
      applySchema(db);
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name)
      );
      assert.equal(tables.has('memories'), true);
      assert.equal(tables.has('memories_fts'), true);
    });
  });

  test('runs, run_events, idempotency_keys, memory_reads survive cleanup', () => {
    withTmpDb(db => {
      applySchema(db);
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name)
      );
      for (const keep of ['runs', 'run_events', 'idempotency_keys', 'memory_reads', 'relay_sessions', 'cost_events', 'run_diffs']) {
        assert.equal(tables.has(keep), true, `non-orphan table "${keep}" must remain after applySchema`);
      }
    });
  });
});
