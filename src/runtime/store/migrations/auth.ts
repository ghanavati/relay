import type Database from 'libsql';

export function migrateAuthTables(db: Database.Database): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS auth_users (
      user_id       TEXT    NOT NULL PRIMARY KEY,
      email         TEXT    NOT NULL UNIQUE,
      display_name  TEXT    NOT NULL,
      provider      TEXT    NOT NULL,
      provider_id   TEXT    NOT NULL,
      team_id       TEXT,
      created_at    INTEGER NOT NULL,
      last_login_at INTEGER
    )
  `).run();

  db.prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_users_provider
      ON auth_users(provider, provider_id)
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      session_id   TEXT    NOT NULL PRIMARY KEY,
      user_id      TEXT    NOT NULL,
      team_id      TEXT,
      email        TEXT    NOT NULL,
      display_name TEXT    NOT NULL,
      expires_at   INTEGER NOT NULL,
      created_at   INTEGER NOT NULL
    )
  `).run();

  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at
      ON auth_sessions(expires_at)
  `).run();
}
