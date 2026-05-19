/**
 * Online `.v1-backup` writer for the v0.2 schema cleanup migration.
 *
 * better-sqlite3's `Database.backup(destPath)` uses SQLite's online backup
 * API — it streams pages from the live connection to a new file via the
 * SQLite VFS, so it's safe to invoke while the source DB is open. The output
 * is a complete, independent SQLite file usable for recovery.
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
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

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
    await db.backup(backupPath);
    return { skipped: false, backupPath };
  } catch {
    // Caller treats absent backupPath as failure.
    return { skipped: false };
  }
}
