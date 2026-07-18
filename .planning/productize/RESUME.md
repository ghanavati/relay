# Productize — resume state (§14 cutoff protocol active)

Branch: `productize` (worktree off phase-9-v04). If this session died, resume from the
commit sequence below — done items are committed on this branch; everything else is not
started unless a commit says otherwise. Grounding docs: GAP-TABLE.md + MCP-AUDIT.md here.

User decisions locked in:
- npm registry / publishing is OUT. Distribution = git clone + build, or release tarball.
  Do not spend effort on npm name/private/publish.
- DB config: `RELAY_DB_URL` (+ optional `RELAY_DB_AUTH_TOKEN`), both secret, never logged.
  Precedence env > config file > default; global CLI flag skipped (no global-flag
  mechanism exists in the CLI; env is relay's established override idiom).
- libSQL/Turso is the one hosted target. No driver registry, no ORM, one schema.

Verified facts a resumer must not re-derive:
- libsql compat: repo uses NOTHING libsql lacks except `db.backup()` (backup-v1.ts:90);
  `VACUUM INTO ?` with bound param works as replacement (tested). libsql silently IGNORES
  `readonly` and `fileMustExist` ctor options (tested) — guard both call sites
  (runtime/store/db.ts:158, cli/cmd-doctor.ts:122) with explicit existsSync.
- libsql ships better-sqlite3-compatible .d.ts — swap is import-specifier rename in 14 files.
- FTS5 (porter/bm25/snippet), WAL, transactions, same-file interop: all pass on libsql (tested).
- ink+react ARE used — dynamic import in cmd-tui.ts:310-311. Do NOT remove.
- Fresh-user roundtrip (tarball → clean prefix → scrubbed HOME/env → remember → recall)
  WORKS today. Workdir gate is opt-in (off when RELAY_MEMORY_ALLOWED_WORKDIRS unset).

STATUS 2026-07-18: ALL ELEVEN STEPS DONE — sequence below is complete, suite 2004/2004 green,
typecheck clean. Deviations from the original plan, each deliberate:
- ink/react NOT removed (gap row 2 was wrong — `relay tui` loads them via dynamic import).
- Offline remote mode refuses SAVES instead of queueing (observed silent data loss with
  out-of-protocol replica writes; see BACKLOG B-13). Reads work offline.
- npm registry publishing parked by owner decision; distribution = clone or release tarball.
Remaining for the owner: paste the Codex audit for re-verification against this branch; decide
distribution channel (release workflow); merge.

Commit sequence (mark by looking at `git log --oneline` on this branch):
 0. docs(planning): this checkpoint
 1. fix(init): remove author-machine migrate-cc-memory script + its doc surface
 2. fix(cli): fatal errors without stack traces (RELAY_DEBUG=1 opt-in) + test
 3. feat(store): swap better-sqlite3 → libsql (imports, guards, VACUUM INTO) — suite green
 4. feat(store): RELAY_DB_URL remote/replica mode + boundary validation + sync hooks + tests
 5. (verify only) remote path against local sqld binary — fixes fold into 4's follow-up
 6. feat(mcp): client config writers (Claude Code, Desktop, Cursor, Codex) + init/doctor wiring
 7. test(memory): cross-surface roundtrip test (CLI write → MCP recall, and reverse)
 8. chore(pack): exclude compiled tests + fixtures from tarball (files negation)
 9. feat(cli): `save` alias for `memory remember`
10. docs: install.md + database.md new; commands.md stale fix; quickstart MCP pointer
11. docs(planning): scope addendum (BYO-DB trigger = owner brief 2026-07-17), backlog, close this file

Every commit: build + typecheck + full `npm test` green before committing. No `git add .`.
