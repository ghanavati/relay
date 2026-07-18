/**
 * Online `.v1-backup` writer for the v0.2 schema cleanup migration.
 *
 * Uses `VACUUM INTO` (SQLite ≥3.27) from the live connection — libsql does
 * not implement better-sqlite3's `Database.backup()`, and VACUUM INTO gives
 * the same guarantee: a complete, independent, internally-consistent SQLite
 * file written while the source DB is open.
 *
 * The backup is the SINGLE recovery artifact for R-01-03 (DROP irreversible).
 * `prepareDatabase` calls this BEFORE the destructive v2 migration runs, and
 * treats any backup failure as fatal unless the user explicitly opted out
 * via `RELAY_SKIP_V2_BACKUP=1`.
 *
 * Skip semantics (the function returns rather than throwing, so callers can
 * decide what to do):
 *
 *   • `RELAY_SKIP_V2_BACKUP=1`  → skipped:'RELAY_SKIP_V2_BACKUP=1' (user opt-out)
 *   • storeDir missing/not-a-dir → skipped:'no-store-dir' (in-memory / test)
 *   • schema_version >= 2       → skipped:'already-migrated' (no work to do)
 *   • `.v1-backup` exists       → skipped:'backup-exists' (preserve the
 *                                  earliest pre-migration snapshot — never
 *                                  overwrite it)
 *   • otherwise                 → skipped:false, backupPath set on success.
 */
import { existsSync, statSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'libsql';

import { readSchemaVersion, EXPECTED_SCHEMA_VERSION } from './schema-version.js';

export interface BackupResult {
  skipped: boolean;
  backupPath?: string;
  reason?: string;
}

/** Filename used for the pre-migration backup, written into storeDir. */
export const BACKUP_FILENAME = '.v1-backup';

/**
 * True iff `RELAY_SKIP_V2_BACKUP === '1'`.
 *
 * The strict equality check (not "truthy") is intentional — any other value
 * (`'0'`, `'true'`, etc.) means "no opt-out". Keeps the gate explicit and
 * impossible to trip by accident.
 */
export function shouldSkipBackup(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['RELAY_SKIP_V2_BACKUP'] === '1';
}

/**
 * Write `.v1-backup` to `storeDir` via the SQLite online backup API.
 *
 * Returns a structured result so callers can distinguish "skipped on
 * purpose" (good) from "tried but failed" (fatal pre-DROP).
 */
export async function writeV1Backup(
  db: Database.Database,
  storeDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BackupResult> {
  if (shouldSkipBackup(env)) {
    return { skipped: true, reason: 'RELAY_SKIP_V2_BACKUP=1' };
  }
  if (!storeDir || !existsSync(storeDir)) {
    return { skipped: true, reason: 'no-store-dir' };
  }
  let stat;
  try {
    stat = statSync(storeDir);
  } catch {
    return { skipped: true, reason: 'no-store-dir' };
  }
  if (!stat.isDirectory()) {
    return { skipped: true, reason: 'no-store-dir' };
  }

  if (readSchemaVersion(db) >= EXPECTED_SCHEMA_VERSION) {
    return { skipped: true, reason: 'already-migrated' };
  }

  const backupPath = join(storeDir, BACKUP_FILENAME);
  if (existsSync(backupPath)) {
    // Never overwrite — the existing file may be the earliest pre-migration
    // snapshot and is the user's only recovery handle (R-01-05).
    return { skipped: true, reason: 'backup-exists', backupPath };
  }

  try {
    db.prepare('VACUUM INTO ?').run(backupPath);
    return { skipped: false, backupPath };
  } catch {
    // Caller treats absent backupPath as failure.
    return { skipped: false };
  }
}

/**
 * Synchronous companion to writeV1Backup, used by getDb (which cannot be
 * async without changing every caller's signature).
 *
 * Strategy: copy the on-disk relay.db file byte-for-byte via copyFileSync.
 * This is safe under the assumption that the connection is opened in
 * WAL mode with a full checkpoint AFTER the copy runs (so the WAL/SHM
 * sidecars don't contain unflushed pages at copy time). Since the caller
 * runs this BEFORE opening the DB for writes, there is nothing in WAL
 * yet — copyFileSync of the main file produces an internally-consistent
 * snapshot.
 *
 * Same skip semantics as writeV1Backup.
 */
export function writeV1BackupSync(
  sourceDbPath: string,
  storeDir: string,
  env: NodeJS.ProcessEnv = process.env,
): BackupResult {
  if (shouldSkipBackup(env)) {
    return { skipped: true, reason: 'RELAY_SKIP_V2_BACKUP=1' };
  }
  if (!storeDir || !existsSync(storeDir)) {
    return { skipped: true, reason: 'no-store-dir' };
  }
  let dirStat;
  try {
    dirStat = statSync(storeDir);
  } catch {
    return { skipped: true, reason: 'no-store-dir' };
  }
  if (!dirStat.isDirectory()) {
    return { skipped: true, reason: 'no-store-dir' };
  }
  if (!existsSync(sourceDbPath)) {
    // No source DB yet — nothing to back up. The caller is creating a fresh
    // DB, not migrating one.
    return { skipped: true, reason: 'no-source-db' };
  }

  const backupPath = join(storeDir, BACKUP_FILENAME);
  if (existsSync(backupPath)) {
    return { skipped: true, reason: 'backup-exists', backupPath };
  }

  try {
    copyFileSync(sourceDbPath, backupPath);
    return { skipped: false, backupPath };
  } catch {
    return { skipped: false };
  }
}

/**
 * Sync sibling to {@link writeV1BackupSync} that also checks the applied
 * schema version on the source DB before doing the copy. Use this when the
 * caller has the source DB path but no live connection.
 *
 * Opens the source DB read-only, reads schema_version, closes, then either
 * skips (`already-migrated`) or runs writeV1BackupSync.
 */
export function backupBeforeMigrationSync(
  sourceDbPath: string,
  storeDir: string,
  openReadOnly: (path: string) => Database.Database,
  env: NodeJS.ProcessEnv = process.env,
): BackupResult {
  if (shouldSkipBackup(env)) {
    return { skipped: true, reason: 'RELAY_SKIP_V2_BACKUP=1' };
  }
  if (!existsSync(sourceDbPath)) {
    return { skipped: true, reason: 'no-source-db' };
  }

  // Peek at the applied version without holding the connection open.
  try {
    const probe = openReadOnly(sourceDbPath);
    try {
      if (readSchemaVersion(probe) >= EXPECTED_SCHEMA_VERSION) {
        return { skipped: true, reason: 'already-migrated' };
      }
    } finally {
      try { probe.close(); } catch { /* best-effort */ }
    }
  } catch {
    // If we can't even open it read-only, fall through and try copy anyway —
    // a copyFileSync failure surfaces as `skipped:false, backupPath: undefined`
    // which is the canonical fail-loud signal for callers.
  }

  return writeV1BackupSync(sourceDbPath, storeDir, env);
}
