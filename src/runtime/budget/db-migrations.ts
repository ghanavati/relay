import type Database from 'better-sqlite3';

/**
 * Allowed `scope` values for `budget_limits` / `budget_alerts`.
 *
 * v0.1 shipped with only the first three. v0.2 (ROADMAP #7) added `provider`
 * and `workdir` so per-project and per-provider budget visibility is possible.
 *
 * SQLite cannot ALTER an existing CHECK constraint in place, so on databases
 * created before v0.2 we must detect the old CHECK and transactionally
 * recreate the table with the expanded list — see {@link upgradeCheckIfNeeded}.
 */
const ALLOWED_SCOPES = ['model', 'owner', 'global', 'provider', 'workdir'] as const;
const SCOPE_CHECK_LIST = ALLOWED_SCOPES.map(s => `'${s}'`).join(', ');

const BUDGET_LIMITS_DDL = `
  CREATE TABLE IF NOT EXISTS budget_limits (
    limit_id    TEXT    NOT NULL PRIMARY KEY,
    scope       TEXT    NOT NULL CHECK(scope IN (${SCOPE_CHECK_LIST})),
    scope_value TEXT    NOT NULL,
    limit_usd   REAL    NOT NULL,
    period      TEXT    NOT NULL CHECK(period IN ('daily', 'monthly', 'alltime')),
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  )
`;

const BUDGET_ALERTS_DDL = `
  CREATE TABLE IF NOT EXISTS budget_alerts (
    alert_id    TEXT    NOT NULL PRIMARY KEY,
    scope       TEXT    NOT NULL CHECK(scope IN (${SCOPE_CHECK_LIST})),
    scope_value TEXT    NOT NULL,
    limit_usd   REAL    NOT NULL,
    current_usd REAL    NOT NULL,
    pct_used    REAL    NOT NULL,
    level       TEXT    NOT NULL CHECK(level IN ('warning', 'exceeded')),
    period      TEXT    NOT NULL,
    created_at  INTEGER NOT NULL
  )
`;

/**
 * Probe a budget table's CHECK constraint to see whether the new `provider`
 * and `workdir` scope values are admissible. Returns `true` when the CHECK
 * already accepts them (i.e. the table is on the v0.2 schema), `false`
 * otherwise (i.e. legacy three-value CHECK).
 *
 * Uses a SAVEPOINT so the probe leaves no trace on the database. The probe
 * INSERT is rolled back unconditionally.
 */
function checkAcceptsNewScopes(db: Database.Database, table: 'budget_limits' | 'budget_alerts'): boolean {
  // If the table does not yet exist, the fresh-DDL path below will create it
  // with the v0.2 CHECK — treat this as "already correct".
  const exists = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table) as { 1: number } | undefined;
  if (!exists) return true;

  db.exec('SAVEPOINT chk_probe');
  try {
    if (table === 'budget_limits') {
      db.prepare(
        `INSERT INTO budget_limits (limit_id, scope, scope_value, limit_usd, period, created_at, updated_at)
         VALUES (?, 'provider', '__probe__', 0, 'monthly', 0, 0)`,
      ).run('__probe__');
    } else {
      db.prepare(
        `INSERT INTO budget_alerts
           (alert_id, scope, scope_value, limit_usd, current_usd, pct_used, level, period, created_at)
         VALUES (?, 'provider', '__probe__', 0, 0, 0, 'warning', 'monthly', 0)`,
      ).run('__probe__');
    }
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'SQLITE_CONSTRAINT_CHECK') return false;
    // Any other error (e.g. duplicate PK, schema mismatch) — re-throw so the
    // caller sees it. We only swallow the specific CHECK failure that signals
    // "table is on the legacy schema".
    throw err;
  } finally {
    db.exec('ROLLBACK TO SAVEPOINT chk_probe');
    db.exec('RELEASE SAVEPOINT chk_probe');
  }
}

/**
 * Transactionally recreate `budget_limits` and `budget_alerts` with the new
 * CHECK constraint, preserving every row from the old tables. Only called for
 * tables that fail {@link checkAcceptsNewScopes}.
 *
 * The whole upgrade runs inside a single TRANSACTION — if any step throws,
 * better-sqlite3 rolls back and the old schema (and rows) remain intact.
 *
 * Scope: budget tables only. Does NOT touch broader schema_version logic
 * (that is ROADMAP #1 territory and is owned by another executor).
 */
function upgradeCheckInTransaction(db: Database.Database, table: 'budget_limits' | 'budget_alerts'): void {
  const isLimits = table === 'budget_limits';
  const newDdl = isLimits
    ? BUDGET_LIMITS_DDL.replace('IF NOT EXISTS budget_limits', 'budget_limits_new')
    : BUDGET_ALERTS_DDL.replace('IF NOT EXISTS budget_alerts', 'budget_alerts_new');

  db.exec('BEGIN');
  try {
    db.exec(newDdl);
    db.exec(`INSERT INTO ${table}_new SELECT * FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
    if (isLimits) {
      db.exec(`CREATE UNIQUE INDEX idx_budget_limits_scope ON budget_limits(scope, scope_value, period)`);
    } else {
      db.exec(`CREATE INDEX idx_budget_alerts_scope ON budget_alerts(scope, scope_value)`);
      db.exec(`CREATE INDEX idx_budget_alerts_level ON budget_alerts(level)`);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function migrateBudgetTables(db: Database.Database): void {
  // Phase 1 — fresh-DB path: CREATE IF NOT EXISTS with the v0.2 CHECK.
  // For pre-existing tables this is a no-op (`IF NOT EXISTS`), and Phase 2
  // below will upgrade the CHECK if needed.
  db.prepare(BUDGET_LIMITS_DDL).run();
  db.prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_limits_scope
      ON budget_limits(scope, scope_value, period)
  `).run();
  db.prepare(BUDGET_ALERTS_DDL).run();
  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_budget_alerts_scope
      ON budget_alerts(scope, scope_value)
  `).run();
  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_budget_alerts_level
      ON budget_alerts(level)
  `).run();

  // Phase 2 — upgrade path: only fires on legacy DBs whose CHECK rejects the
  // new scope values. Idempotent: re-running on an upgraded DB finds the new
  // CHECK admissible and skips the recreate.
  if (!checkAcceptsNewScopes(db, 'budget_limits')) {
    upgradeCheckInTransaction(db, 'budget_limits');
  }
  if (!checkAcceptsNewScopes(db, 'budget_alerts')) {
    upgradeCheckInTransaction(db, 'budget_alerts');
  }
}
