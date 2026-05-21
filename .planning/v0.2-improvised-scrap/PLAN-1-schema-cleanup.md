# PLAN-1 — Schema Cleanup (v0.2)

**Scope:** ROADMAP §1. Add `schema_version` table + versioned DROP migration that
removes 11 orphan tables. Execute via CC subagents (no codex). TDD throughout.

**Sources:** `ROADMAP.md:18-43`, `.planning/v0.2/ROADMAP-DRIFT.md:9-26`,
`.planning/v0.2/BUDGET-CLI-SCHEMA-MAP.md:88-178,267-275`.

---

## Goal

Establish a forward-compatible schema-version mechanism in `src/runtime/store/db.ts`
and use it to gate a one-time DROP of 11 orphan tables identified in
`BUDGET-CLI-SCHEMA-MAP.md:158-170`. After v2 runs once, `schema_version` row reads
`2` and re-running `applySchema()` is a no-op. Existing populated v1 DBs must
migrate cleanly without data loss to retained tables (especially `memories`,
`runs`, `run_events`, `cost_events`, `relay_sessions`, `command_events`,
`idempotency_keys`, `corpora`, `corpora_fts`, `run_diffs`, `memory_reads`).

---

## Files to touch

| Path | Lines (current) | Change |
|---|---|---|
| `src/runtime/store/db.ts` | `:15-252` (DDL_STATEMENTS) | remove DDL for 11 orphan tables + their indexes (`:71-95,98,106-113,126-153,154-170,196,197-230,232-242`); insert `schema_version` DDL as first entry. |
| `src/runtime/store/db.ts` | `:284-299` (`migrateTasksLeaseFields`) | DELETE function. |
| `src/runtime/store/db.ts` | `:316-322,329-338` (`migrateVerifications*`) | DELETE functions. |
| `src/runtime/store/db.ts` | `:340-349` (`migrateProxyRequestsFullBody`) | DELETE function. |
| `src/runtime/store/db.ts` | `:402-404` (`purgeTaintedVerificationRecords`) | DELETE function and its call at `:410`. |
| `src/runtime/store/db.ts` | `:406-427` (`applySchema`) | (a) read current version before DDL loop; (b) bootstrap row for fresh DBs; (c) replace dead migration calls; (d) append `migrateDropOrphansV02(db)` and `recordSchemaVersion(db, 2, …)`. |
| `src/runtime/store/db.ts` | NEW helpers | add `readSchemaVersion(db) → number`, `recordSchemaVersion(db, n, desc)`, `migrateDropOrphansV02(db)` near other migration functions. |
| `src/memory/db-migrations.ts` | UNCHANGED | Memory tables stay versionless/idempotent; orthogonal to this plan. |
| `tests/runtime/store/schema-version.test.ts` | NEW | RED tests for version table, idempotency, drop ordering. |
| `tests/runtime/store/migrate-v1-to-v2.test.ts` | NEW | RED tests against a populated v1 DB fixture. |
| `tests/fixtures/db/v1-populated.sql` | NEW | Hand-rolled SQL fixture: full v1 schema + sample rows in every retained + dropped table. |

**Out of scope (do NOT touch this PR):**
- `src/contracts/continuity.ts`, `src/contracts/amend_sign_off.ts` — orphan Zod
  schemas; leave for a later cleanup PR to avoid scope creep.
- `src/runtime/budget/db-migrations.ts` — handled by ROADMAP §7 (separate plan).
- `src/memory/db-migrations.ts` — versioning retrofit is non-goal for v0.2.

---

## Task breakdown (TDD)

Dependencies are listed as `→ Tn`. All tasks executed by CC subagents serially
unless parallelisable below. Each task ends GREEN with all prior tests still passing.

### T1 — fixture: populated v1 DB
- **RED:** create `tests/runtime/store/fixture-loads.test.ts` asserting a fresh
  `better-sqlite3` DB loaded from `tests/fixtures/db/v1-populated.sql` contains
  rows in `runs`, `cost_events`, `memories`, AND in every soon-to-be-dropped
  orphan table (`continuity_objects`, `recipes`, `sign_offs`,
  `sign_off_amendments`, `operator_annotations`, `proxy_requests`, `jobs`,
  `tasks`, `task_deps`, `job_events`, `verifications`). Fixture file does not
  exist → test fails on missing file.
- **GREEN:** author `tests/fixtures/db/v1-populated.sql` containing CREATE TABLE
  statements copied verbatim from `db.ts:16-252` (snapshot before edits) + 1–2
  INSERTs per table. Reuse FK-correct INSERT order (jobs → tasks → task_deps;
  continuity_objects → recipes; sign_offs → sign_off_amendments).
- **IMPROVE:** add helper `loadV1Fixture(): Database.Database` in
  `tests/runtime/store/__helpers/v1-fixture.ts` for reuse by T7+.
- **Deps:** none.

### T2 — RED: `readSchemaVersion()` contract
- **RED:** add to `schema-version.test.ts`: (a) on empty DB → returns `0`;
  (b) after inserting `{version:1, applied_at:N}` → returns `1`; (c) after
  inserting `{version:2,...}` then `{version:1,...}` → returns `2` (max).
- **GREEN:** implement `readSchemaVersion(db)` doing
  `SELECT COALESCE(MAX(version), 0) FROM schema_version` guarded by
  `CREATE TABLE IF NOT EXISTS schema_version (...)` if introspecting before
  `applySchema`.
- **IMPROVE:** export from `db.ts` for test access; type as `(db: Database) => number`.
- **Deps:** none (does not depend on T1).

### T3 — RED: `recordSchemaVersion()` contract
- **RED:** assert (a) inserts row with given version+desc+timestamp; (b) re-call
  with same version → no duplicate (idempotent — `INSERT OR IGNORE` semantics);
  (c) `readSchemaVersion` reflects update.
- **GREEN:** implement via `INSERT OR IGNORE INTO schema_version (version, applied_at, description) VALUES (?,?,?)`.
- **IMPROVE:** wrap timestamp via `Date.now()` injection or accept clock param
  for deterministic tests.
- **Deps:** T2.

### T4 — RED: `applySchema()` bootstraps v0 → v1 on fresh DB
- **RED:** open empty `:memory:` DB → `applySchema(db)` →
  `readSchemaVersion(db)` should be `>= 1` (the "post-bootstrap" baseline).
- **GREEN:** at top of `applySchema` after DDL loop, if `readSchemaVersion` ===
  0, call `recordSchemaVersion(db, 1, 'baseline pre-cleanup')`. This pins
  existing prod DBs at v1 the first time the new code runs against them.
- **IMPROVE:** add `SCHEMA_VERSION_BASELINE = 1` const to top of file.
- **Deps:** T2, T3.

### T5 — RED: `migrateDropOrphansV02()` is a no-op when version >= 2
- **RED:** populate DB; `recordSchemaVersion(db, 2, ...)`; create orphan tables
  manually with rows; call `migrateDropOrphansV02(db)`; assert orphan tables
  STILL exist (proves guard works).
- **GREEN:** implement function; first line:
  `if (readSchemaVersion(db) >= 2) return;`
- **IMPROVE:** wrap with `BEGIN/COMMIT` transaction for atomicity (so a partial
  failure doesn't leave half-dropped schema).
- **Deps:** T2, T3.

### T6 — RED: `migrateDropOrphansV02()` drops in FK-safe order
- **RED:** seed DB with FK-related rows in (jobs, tasks, task_deps);
  (continuity_objects, recipes); (sign_offs, sign_off_amendments). Run
  `migrateDropOrphansV02(db)`. Assert: (a) all 11 tables gone; (b) both
  sign_off triggers gone (`SELECT * FROM sqlite_master WHERE type='trigger' AND name LIKE 'sign_off%'`);
  (c) `readSchemaVersion(db) === 2`; (d) no SQLITE_CONSTRAINT errors raised.
- **GREEN:** implement explicit DROP order:
  1. `DROP TABLE IF EXISTS task_deps`
  2. `DROP TABLE IF EXISTS tasks`
  3. `DROP TABLE IF EXISTS jobs`
  4. `DROP TABLE IF EXISTS job_events`
  5. `DROP TRIGGER IF EXISTS trg_sign_offs_immutable` (and amendments trigger;
     exact names per `db.ts:143-153`)
  6. `DROP TABLE IF EXISTS sign_off_amendments`
  7. `DROP TABLE IF EXISTS sign_offs`
  8. `DROP TABLE IF EXISTS recipes`
  9. `DROP TABLE IF EXISTS continuity_objects`
  10. `DROP TABLE IF EXISTS proxy_requests`
  11. `DROP TABLE IF EXISTS operator_annotations`
  12. `DROP TABLE IF EXISTS verifications`
  - Then `recordSchemaVersion(db, 2, 'drop 11 orphan tables')`.
- **IMPROVE:** define `ORPHAN_DROPS_V2: ReadonlyArray<string>` module const so
  the SQL is greppable and reorderable; the function loops it inside a tx.
- **Deps:** T5.

### T7 — RED: end-to-end migration of populated v1 fixture
- **RED:** load `v1-populated.sql` fixture via T1 helper → run `applySchema(db)` →
  assert: (a) all 11 orphan tables absent; (b) all retained tables still present;
  (c) row counts in `runs`, `cost_events`, `memories`, `relay_sessions`,
  `idempotency_keys`, `corpora`, `command_events`, `run_diffs`, `memory_reads`,
  `run_events` unchanged from fixture (use SELECT COUNT(*) snapshot pre/post);
  (d) `readSchemaVersion(db) === 2`; (e) second `applySchema(db)` call is a
  no-op (no errors, version still 2, retained-table counts still unchanged).
- **GREEN:** ensure `applySchema()` call order is:
  1. DDL loop (now without orphan DDL)
  2. bootstrap to v1 (T4)
  3. retained migration calls (memory, capability, auth, budget, runs ALTERs,
     run_events trace fields, runs recalled/thinking, cost_events text, sessions)
  4. `migrateDropOrphansV02(db)` (last, so it operates on a fully-migrated DB)
- **IMPROVE:** dump pre/post `sqlite_master` to a snapshot file as a
  regression artifact (committed alongside test).
- **Deps:** T1, T4, T6.

### T8 — RED: orphan DDL deleted from `DDL_STATEMENTS`
- **RED:** assert via `db.ts` static read (`fs.readFileSync`) that NONE of the
  strings `CREATE TABLE IF NOT EXISTS continuity_objects`, `recipes`,
  `sign_offs`, `sign_off_amendments`, `operator_annotations`, `proxy_requests`,
  `jobs`, `tasks`, `task_deps`, `job_events`, `verifications` appear in
  `DDL_STATEMENTS`. Equivalent assertion for orphan indexes/triggers.
- **GREEN:** delete the corresponding entries from `DDL_STATEMENTS`
  (`db.ts:71-95,98,106-113,126-153,154-170,196,197-230,232-242`). Also delete
  call sites for `migrateTasksLeaseFields`, `migrateVerificationsConfidenceScore`,
  `migrateVerificationsSource`, `migrateProxyRequestsFullBody`,
  `purgeTaintedVerificationRecords` from `applySchema` (`db.ts:411,414-416,410`)
  and the function bodies themselves.
- **IMPROVE:** also delete unused imports / dead helpers exposed only to
  removed migrations; run `tsc --noEmit` to catch dangling references.
- **Deps:** T7 (fixture must prove migration works before we delete DDL — order
  matters: T7 starts on a v1 fixture that uses the OLD DDL; the fixture
  preserves it).

### T9 — RED: full suite regression
- **RED:** run `npm test` (or repo-equivalent). Identify any test that
  imports/expects orphan tables. Most likely affected:
  `src/cli/cmd-budget.test.ts` (no — budget is orthogonal), tests under
  `tests/runtime/store/`, anything under `src/contracts/`. Capture failures.
- **GREEN:** fix or delete tests that asserted on orphan tables. If a test
  exists for `purgeTaintedVerificationRecords`, delete it. If a test asserts
  schema shape via PRAGMA, update assertion to new shape.
- **IMPROVE:** add a `tests/runtime/store/no-orphan-tables.test.ts` smoke test
  that opens a fresh DB, runs `applySchema`, and confirms NONE of the 11
  orphan table names appear in `sqlite_master`. This locks the cleanup in.
- **Deps:** T8.

### T10 — RED: runtime-fixture smoke test against a real prod-shaped DB
- **RED:** copy a real `.relay/relay.db` (or the v1 fixture from T1 if no real
  DB is available) to a temp dir; open via `getDatabase()`/equivalent;
  verify `relay info` and `relay memory recent` still succeed. (If
  Node-level — invoke `executeInfoCommand` and `executeMemoryRecentCommand`
  directly with a fake `CliIO`.)
- **GREEN:** if anything breaks, root-cause; common cause = a retained
  migration relying on a dropped table. Fix at source.
- **IMPROVE:** add to `tests/cli/` so it runs on every CI pass.
- **Deps:** T9.

### Parallelisability
- T2 || T3 may proceed in parallel (different functions, same file — merge
  carefully).
- T1 may proceed in parallel with T2/T3.
- T4 → T5 → T6 → T7 → T8 → T9 → T10 strictly serial.

---

## Acceptance criteria

All must hold simultaneously, verifiable via `npm test` + `sqlite3` shell:

1. Fresh `applySchema(:memory:)` → `SELECT MAX(version) FROM schema_version`
   returns `2`. No orphan tables exist in `sqlite_master`.
2. Running `applySchema()` on a v1-fixture DB:
   - DROPs all 11 orphan tables (verified by `sqlite_master` query).
   - Preserves row counts in: `runs`, `run_events`, `cost_events`, `memories`,
     `relay_sessions`, `idempotency_keys`, `command_events`, `corpora`,
     `corpora_fts`, `run_diffs`, `memory_reads`.
   - Records `version=2` row in `schema_version`.
3. Running `applySchema()` a second time on the same DB: zero side effects.
   `version=2` row count is exactly 1 (INSERT OR IGNORE). No errors.
4. `grep -E 'continuity_objects|recipes|sign_offs|sign_off_amendments|operator_annotations|proxy_requests|\\bjobs\\b|\\btasks\\b|task_deps|job_events|\\bverifications\\b' src/runtime/store/db.ts`
   returns **only** entries inside the `migrateDropOrphansV02` body and the
   `ORPHAN_DROPS_V2` const. No CREATE / INSERT / SELECT / DELETE remains.
5. `tsc --noEmit` passes with zero errors.
6. `relay info` and `relay memory recent` commands succeed against a migrated DB
   (T10).
7. No FK constraint violations raised during migration (proven by T6).
8. `tests/runtime/store/no-orphan-tables.test.ts` (T9 IMPROVE) passes.

---

## Runtime validation

After merge, on the maintainer's local v1 DB:

```bash
cp ~/.relay/relay.db /tmp/relay-v1-backup.db          # backup
sqlite3 /tmp/relay-v1-backup.db "SELECT COUNT(*) FROM memories;" > /tmp/pre.txt
relay info --json                                      # triggers applySchema()
sqlite3 ~/.relay/relay.db "SELECT MAX(version), description FROM schema_version;"
# expected: 2 | drop 11 orphan tables
sqlite3 ~/.relay/relay.db ".tables" | grep -E 'continuity|recipes|sign_offs|jobs|tasks|task_deps|job_events|operator_annotations|proxy_requests|verifications'
# expected: empty output
sqlite3 ~/.relay/relay.db "SELECT COUNT(*) FROM memories;" > /tmp/post.txt
diff /tmp/pre.txt /tmp/post.txt                        # expected: identical
relay memory recent --limit 5                          # expected: works, shows real rows
```

Tail `~/.relay/logs/` (or equivalent) for `SQLITE_ERROR` / `FOREIGN KEY` strings
during the first post-upgrade invocation; absence = clean migration.

---

## Risk register

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Orphan table is silently consumed by a code path grep missed | LOW | HIGH (data loss / runtime crash) | `ROADMAP-DRIFT.md:18-23` already confirmed 0 SQL outside db.ts. T9 full-suite run + T10 smoke catch any missed import. |
| R2 | A 3rd-party / external plugin (Codex CLI, MCP servers) reads orphan tables directly | LOW | MEDIUM | None known. Document in CHANGELOG; ship behind v0.2 release. |
| R3 | Migration runs partially then crashes mid-DROP | LOW | HIGH (corrupt schema_version) | T5 IMPROVE wraps drops in transaction; if any DROP fails, ROLLBACK + don't insert v2 row. Re-run on next boot retries. |
| R4 | `BEGIN TRANSACTION` inside `applySchema` collides with caller-managed transaction | MEDIUM | MEDIUM | Verify `applySchema` is currently never called inside a tx (`grep -B5 'applySchema' src/`). If it is, use SAVEPOINT instead of BEGIN. |
| R5 | `purgeTaintedVerificationRecords` deletion regresses a startup invariant (BUDGET-CLI-SCHEMA-MAP §3 mentions it's called at startup) | LOW | LOW | Function only DELETEs from `verifications`; if the table itself is dropped, the call is moot. Safe to remove together. |
| R6 | Test fixture drifts from real v1 DB shape (`v1-populated.sql` becomes inaccurate over time) | MEDIUM | LOW | Snapshot is one-time. Document in fixture header: "captured 2026-05-18 from db.ts pre-cleanup; do not edit." Future schema changes don't affect this v1→v2 test. |
| R7 | Re-running on a DB that's already at v2 attempts to drop already-dropped tables (no-op via `DROP TABLE IF EXISTS`) but writes a duplicate `schema_version` row | LOW | NEGLIGIBLE | `INSERT OR IGNORE` (T3) + early-exit guard (T5) prevents both. |
| R8 | A future cleanup PR removes orphan contracts (`continuity.ts`, `amend_sign_off.ts`) and breaks dynamic imports relied on by removed code paths | LOW | LOW | Out of scope here; track in follow-up issue. Don't pre-empt. |

---

## Rollback plan

**Schema deletion is irreversible inside the running DB.** Safety net is layered:

1. **Pre-migration backup (mandatory operator step):** the FIRST invocation of
   the new code on an existing DB should write a backup before running
   `migrateDropOrphansV02`. Implementation:
   - Inside `migrateDropOrphansV02`, before the early-exit guard returns and
     before any DROP, if `readSchemaVersion(db) === 1` AND `process.env.RELAY_SKIP_V2_BACKUP !== '1'`,
     write a copy of the DB file to `<db-path>.v1-backup` using SQLite's online
     backup API (`db.backup(targetPath)` in better-sqlite3). If file already
     exists, refuse to overwrite (no silent clobber).
   - Add this as T6 IMPROVE-or T6.5 task; tested by asserting `.v1-backup` file
     exists post-migration when started from v1.

2. **Roll-forward (the only true recovery):** if a user reports a missing-table
   error in v0.2, instruct them to:
   ```bash
   cp ~/.relay/relay.db.v1-backup ~/.relay/relay.db
   # downgrade to v0.1.x binary
   ```

3. **Code-level revert:** the PR must be a single squash-mergeable commit so
   `git revert <sha>` cleanly restores the old `db.ts`. New v0.2 DBs that
   never had orphan tables are unaffected by the revert (DDL_STATEMENTS would
   re-create them as empty — acceptable; they were unused anyway).

4. **No automated v2→v1 down-migration.** Recreating dropped tables empty is
   trivial but recreating their *data* is impossible. We do not attempt it.
   Document this explicitly in CHANGELOG: "v0.2 schema cleanup is one-way; back
   up `relay.db` before first launch of v0.2."

5. **CHANGELOG entry (must accompany PR):** "BREAKING: v0.2 drops 11 unused
   tables on first launch. A backup is written to `relay.db.v1-backup`
   automatically (set `RELAY_SKIP_V2_BACKUP=1` to opt out). See PLAN-1."

---

*End PLAN-1 — schema cleanup.*
