import type Database from 'better-sqlite3';

export function migrateBudgetTables(db: Database.Database): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS budget_limits (
      limit_id    TEXT    NOT NULL PRIMARY KEY,
      scope       TEXT    NOT NULL CHECK(scope IN ('model', 'owner', 'global')),
      scope_value TEXT    NOT NULL,
      limit_usd   REAL    NOT NULL,
      period      TEXT    NOT NULL CHECK(period IN ('daily', 'monthly', 'alltime')),
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    )
  `).run();

  db.prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_limits_scope
      ON budget_limits(scope, scope_value, period)
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS budget_alerts (
      alert_id    TEXT    NOT NULL PRIMARY KEY,
      scope       TEXT    NOT NULL CHECK(scope IN ('model', 'owner', 'global')),
      scope_value TEXT    NOT NULL,
      limit_usd   REAL    NOT NULL,
      current_usd REAL    NOT NULL,
      pct_used    REAL    NOT NULL,
      level       TEXT    NOT NULL CHECK(level IN ('warning', 'exceeded')),
      period      TEXT    NOT NULL,
      created_at  INTEGER NOT NULL
    )
  `).run();

  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_budget_alerts_scope
      ON budget_alerts(scope, scope_value)
  `).run();

  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_budget_alerts_level
      ON budget_alerts(level)
  `).run();
}
