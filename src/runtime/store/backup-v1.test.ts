/**
 * Tests for backup-v1.ts — the `.v1-backup` writer that guards the v0.2
 * destructive schema cleanup.
 */
import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  mkdtempSync, copyFileSync, rmSync, existsSync, statSync, chmodSync,
  writeFileSync, mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'libsql';

import { writeV1Backup, shouldSkipBackup, BACKUP_FILENAME } from './backup-v1.js';
import { writeSchemaVersion, EXPECTED_SCHEMA_VERSION } from './schema-version.js';
import { prepareDatabase } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '..', '..', 'memory', '__fixtures__', 'v0.1.2-baseline.db');

function freshTmpFromFixture(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'relay-backup-'));
  const dbPath = join(dir, 'relay.db');
  copyFileSync(FIXTURE, dbPath);
  return { dir, dbPath };
}

function withCleanEnv<T>(fn: () => T): T {
  const saved = process.env['RELAY_SKIP_V2_BACKUP'];
  delete process.env['RELAY_SKIP_V2_BACKUP'];
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env['RELAY_SKIP_V2_BACKUP'];
    else process.env['RELAY_SKIP_V2_BACKUP'] = saved;
  }
}

describe('shouldSkipBackup', () => {
  test("returns true iff env.RELAY_SKIP_V2_BACKUP === '1'", () => {
    assert.equal(shouldSkipBackup({ RELAY_SKIP_V2_BACKUP: '1' }), true);
    assert.equal(shouldSkipBackup({ RELAY_SKIP_V2_BACKUP: '0' }), false);
    assert.equal(shouldSkipBackup({ RELAY_SKIP_V2_BACKUP: 'true' }), false);
    assert.equal(shouldSkipBackup({ RELAY_SKIP_V2_BACKUP: '' }), false);
    assert.equal(shouldSkipBackup({}), false);
  });
});

describe('writeV1Backup — skip paths', () => {
  test("T1: RELAY_SKIP_V2_BACKUP=1 → skipped, no file written", async () => {
    const { dir, dbPath } = freshTmpFromFixture();
    try {
      const db = new Database(dbPath);
      try {
        const r = await writeV1Backup(db, dir, { RELAY_SKIP_V2_BACKUP: '1' });
        assert.equal(r.skipped, true);
        assert.equal(r.reason, 'RELAY_SKIP_V2_BACKUP=1');
        assert.equal(existsSync(join(dir, BACKUP_FILENAME)), false);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T3: schema_version >= EXPECTED → skipped reason "already-migrated", no overwrite', async () => {
    const { dir, dbPath } = freshTmpFromFixture();
    try {
      const db = new Database(dbPath);
      try {
        // Force v=2 onto the DB without running the migration
        db.prepare('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, description TEXT)').run();
        writeSchemaVersion(db, EXPECTED_SCHEMA_VERSION, 'pre-existing');
        await withCleanEnv(async () => {
          const r = await writeV1Backup(db, dir);
          assert.equal(r.skipped, true);
          assert.equal(r.reason, 'already-migrated');
          assert.equal(existsSync(join(dir, BACKUP_FILENAME)), false);
        });
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T4: .v1-backup pre-existing → skipped reason "backup-exists", original preserved', async () => {
    const { dir, dbPath } = freshTmpFromFixture();
    try {
      const db = new Database(dbPath);
      const backupPath = join(dir, BACKUP_FILENAME);
      // Pre-create a marker .v1-backup
      writeFileSync(backupPath, 'preexisting-marker', 'utf8');
      const beforeStat = statSync(backupPath);
      try {
        await withCleanEnv(async () => {
          const r = await writeV1Backup(db, dir);
          assert.equal(r.skipped, true);
          assert.equal(r.reason, 'backup-exists');
          assert.equal(r.backupPath, backupPath);
        });
        // File contents must not have been overwritten by db.backup
        const afterStat = statSync(backupPath);
        assert.equal(afterStat.size, beforeStat.size);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T5: storeDir missing → skipped reason "no-store-dir", no throw', async () => {
    const { dir, dbPath } = freshTmpFromFixture();
    try {
      const db = new Database(dbPath);
      try {
        await withCleanEnv(async () => {
          const missingDir = join(dir, 'does', 'not', 'exist');
          const r = await writeV1Backup(db, missingDir);
          assert.equal(r.skipped, true);
          assert.equal(r.reason, 'no-store-dir');
        });
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T5b: storeDir is a file (not a directory) → skipped reason "no-store-dir"', async () => {
    const { dir, dbPath } = freshTmpFromFixture();
    try {
      const db = new Database(dbPath);
      try {
        const filePath = join(dir, 'not-a-dir');
        writeFileSync(filePath, 'x');
        await withCleanEnv(async () => {
          const r = await writeV1Backup(db, filePath);
          assert.equal(r.skipped, true);
          assert.equal(r.reason, 'no-store-dir');
        });
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('writeV1Backup — happy path', () => {
  test('T2: fixture in tmpdir + clean env → .v1-backup written as valid SQLite with memories table', async () => {
    const { dir, dbPath } = freshTmpFromFixture();
    try {
      const db = new Database(dbPath);
      try {
        await withCleanEnv(async () => {
          const r = await writeV1Backup(db, dir);
          assert.equal(r.skipped, false);
          assert.equal(r.backupPath, join(dir, BACKUP_FILENAME));
          assert.equal(existsSync(r.backupPath as string), true);
          // Backup is a real SQLite file that we can query
          const backup = new Database(r.backupPath as string, { readonly: true });
          try {
            const n = (backup.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
            assert.ok(n >= 3, `backup should contain ≥3 memory rows (got ${n})`);
          } finally {
            backup.close();
          }
        });
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('prepareDatabase — integration', () => {
  test('T6: prepareDatabase on fixture: .v1-backup exists AND contains orphans AND main DB does not', async () => {
    const { dir, dbPath } = freshTmpFromFixture();
    try {
      const db = new Database(dbPath);
      try {
        await withCleanEnv(async () => {
          await prepareDatabase(db, dir);
          const backupPath = join(dir, BACKUP_FILENAME);
          assert.equal(existsSync(backupPath), true);
          // Backup contains orphan content
          const backup = new Database(backupPath, { readonly: true });
          try {
            const row = backup.prepare("SELECT object_id FROM continuity_objects WHERE object_id = 'co-fix-001'").get();
            assert.ok(row, '.v1-backup must contain original continuity_objects row');
          } finally {
            backup.close();
          }
          // Main DB does NOT
          const mainHasOrphan = (db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='continuity_objects'"
          ).get()) as { name: string } | undefined;
          assert.equal(mainHasOrphan, undefined, 'main DB must not contain continuity_objects after migration');
        });
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T7: storeDir read-only → backup write fails AND opt-out unset → prepareDatabase THROWS', async () => {
    const { dir, dbPath } = freshTmpFromFixture();
    let restored = false;
    try {
      // Open DB BEFORE flipping perms, then chmod storeDir read-only so any
      // file create (.v1-backup, WAL, journal) fails.
      const db = new Database(dbPath);
      chmodSync(dir, 0o555);
      try {
        // Safety property: prepareDatabase MUST reject when backup is required
        // but cannot be written. The specific error may come from db.backup
        // itself (SQLITE_READONLY_DIRECTORY) or from our defensive throw.
        // Either way, the destructive v2 migration MUST NOT silently succeed.
        await assert.rejects(
          () => withCleanEnv(() => prepareDatabase(db, dir)),
          'prepareDatabase must throw when backup is required but cannot be written',
        );
        // Also verify .v1-backup was NOT written (negative invariant)
        assert.equal(existsSync(join(dir, BACKUP_FILENAME)), false);
      } finally {
        // Restore perms BEFORE closing DB so close() can flush WAL.
        try { chmodSync(dir, 0o755); restored = true; } catch { /* ignore */ }
        db.close();
      }
    } finally {
      if (restored) rmSync(dir, { recursive: true, force: true });
    }
  });
});
