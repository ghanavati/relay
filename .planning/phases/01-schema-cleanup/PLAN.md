---
phase: 01-schema-cleanup
plan: 01
type: tdd
wave: 1
depends_on: []
files_modified:
  - src/memory/__fixtures__/v0.1.2-baseline.db        # NEW (binary, ≤30KB)
  - src/memory/__fixtures__/README.md                  # NEW (provenance + regen)
  - src/memory/__fixtures__/_generate-v0.1.2.mjs       # NEW (regen script)
  - src/runtime/store/schema-version.ts                # NEW
  - src/runtime/store/schema-version.test.ts           # NEW
  - src/runtime/store/migrate-v2-drop-orphans.ts       # NEW
  - src/runtime/store/migrate-v2-drop-orphans.test.ts  # NEW
  - src/runtime/store/backup-v1.ts                     # NEW
  - src/runtime/store/backup-v1.test.ts                # NEW
  - src/runtime/store/db.ts                            # MODIFY (DDL prepend, applySchema rewire, prepareDatabase export)
  - src/runtime/store/db.test.ts                       # NEW/MODIFY
  - src/cli/cmd-doctor.ts                              # MODIFY (schema_version probe)
  - src/cli/cmd-doctor.test.ts                         # NEW/MODIFY
autonomous: true
requirements: [SCHEMA-01, SCHEMA-02, SCHEMA-03]
must_haves:
  truths:
    - "v0.2 launched against v0.1.2 DB reports schema_version=2, all memories intact (zero data loss)"
    - "After first launch, none of the 11 orphan tables present"
    - "`.v1-backup` exists in store dir after first launch on v0.1.2 DB"
    - "RELAY_SKIP_V2_BACKUP=1 skips backup creation"
    - "`relay doctor` surfaces schema_version probe (ok | missing | failed)"
    - "Re-running migration v2 is a no-op (idempotency gate)"
    - "All 1003 pre-existing tests remain green"
  artifacts:
    - path: "src/memory/__fixtures__/v0.1.2-baseline.db"
      provides: "v0.1.2-shape DB with populated orphan tables + ≥3 memory rows (CC.1 enforcement gate)"
    - path: "src/runtime/store/schema-version.ts"
      exports: ["readSchemaVersion", "writeSchemaVersion", "EXPECTED_SCHEMA_VERSION"]
    - path: "src/runtime/store/migrate-v2-drop-orphans.ts"
      exports: ["migrateDropOrphansV02"]
      provides: "Idempotent transactional DROP of 11 orphans in FK-safe order"
    - path: "src/runtime/store/backup-v1.ts"
      exports: ["writeV1Backup", "shouldSkipBackup"]
      provides: "Online backup via db.backup(); honors RELAY_SKIP_V2_BACKUP=1"
    - path: "src/runtime/store/db.ts"
      contains: "CREATE TABLE IF NOT EXISTS schema_version"
      provides: "schema_version DDL prepended; prepareDatabase(db, storeDir) exported; orphan DDL/migrations removed"
  key_links:
    - from: "src/runtime/store/db.ts:prepareDatabase"
      to: "src/runtime/store/backup-v1.ts:writeV1Backup"
      via: "called BEFORE migrateDropOrphansV02 when schema_version < 2 AND opt-out unset"
      pattern: "writeV1Backup\\("
    - from: "src/runtime/store/db.ts:applySchema"
      to: "src/runtime/store/migrate-v2-drop-orphans.ts:migrateDropOrphansV02"
      via: "called after migrateAuthTables(db) at db.ts:426"
      pattern: "migrateDropOrphansV02\\(db\\)"
    - from: "src/runtime/store/migrate-v2-drop-orphans.ts"
      to: "src/runtime/store/schema-version.ts"
      via: "early-return when readSchemaVersion(db) >= 2; writeSchemaVersion(db, 2, ...) end of txn"
      pattern: "readSchemaVersion|writeSchemaVersion"
    - from: "src/cli/cmd-doctor.ts"
      to: "src/runtime/store/schema-version.ts"
      via: "probe reads readSchemaVersion(db) read-only, compares EXPECTED_SCHEMA_VERSION"
      pattern: "EXPECTED_SCHEMA_VERSION"
---

<objective>
Drop 11 orphan tables behind a versioned v2 migration gated by a new `schema_version` table, with `.v1-backup` written via better-sqlite3 online backup BEFORE the destructive step. Re-runs are no-ops; `relay doctor` surfaces a `schema_version` check; v0.1.2→v0.2 upgrade proven by a checked-in fixture DB (CC.1 enforcement gate per PITFALLS.md:233-239).

Purpose: clear schema debt blocking Phases 2-7 (SUMMARY.md §5 — Phase 1 is prerequisite for every downstream phase).
Output: clean v0.2 schema; recoverable `.v1-backup`; doctor-visible version; fixture-based upgrade test inherited by future schema work.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/REQUIREMENTS.md
@.planning/ROADMAP.md
@.planning/research/SUMMARY.md
@.planning/research/PITFALLS.md
@.planning/v0.2-improvised-scrap/BUDGET-CLI-SCHEMA-MAP.md
@src/runtime/store/db.ts
@src/memory/db-migrations.ts
@src/cli/cmd-doctor.ts

<interfaces>
**src/runtime/store/db.ts:406-427** — applySchema, insertion point at :426:
```typescript
function applySchema(db: Database.Database): void {
  for (const stmt of DDL_STATEMENTS) { db.prepare(stmt).run(); }
  purgeTaintedVerificationRecords(db);      // :410 DELETE with v2
  migrateIdempotencyExpiresAt(db);
  migrateTasksLeaseFields(db);              // :412 DELETE
  migrateRunsVerificationStatus(db);
  migrateVerificationsConfidenceScore(db);  // :414 DELETE
  migrateVerificationsSource(db);           // :415 DELETE
  migrateProxyRequestsFullBody(db);         // :416 DELETE
  // ... migrateCapabilityTables → migrateAuthTables ...
  migrateAuthTables(db);                    // :426 INSERT v2 hook AFTER
}
```

**Orphan DDL ranges in DDL_STATEMENTS (db.ts:15-252)** per BUDGET-CLI-SCHEMA-MAP.md §3:
- Tables: continuity_objects :71-86, recipes :87-95 (FK→continuity_objects), verifications :106-113,
  sign_offs :126-132, sign_off_amendments :134-142, sign_off triggers :143-153,
  proxy_requests :154-169, jobs :197-204, tasks :205-216, task_deps :217-222 (FK→jobs,tasks),
  job_events :223-229, operator_annotations :232-240
- Indexes: idx_sign_offs_run_id :133, idx_proxy_requests_created_at :170,
  idx_continuity_objects_kind/status :96-97, idx_recipes_object_id :98,
  idx_verifications_run_id :196, idx_tasks_job_id :230, idx_job_events_job_id :231,
  idx_operator_annotations_* :241-242
- Orphan migration fns to DELETE: migrateTasksLeaseFields :284-299, migrateVerificationsConfidenceScore :316-322,
  migrateVerificationsSource :329-338, migrateProxyRequestsFullBody :340-349, purgeTaintedVerificationRecords :402-404

**src/cli/cmd-doctor.ts** probe pattern (441 lines):
```typescript
import type { ProviderProbe } from './probes.js';  // :8
// ProviderProbe = { name: string, status: 'ok'|'missing'|'failed', detail: string }
// Existing probes: checkCcGlobalHook :31, checkHookRoundtrip :70, probeCodex/probeLmStudio/probeEnvKey
// Aggregation site inside executeDoctorCommand — executor must Read full file to locate Promise.all
```

**better-sqlite3 online backup** (in package.json):
```typescript
db.backup(destinationPath: string, opts?: { progress?: (p) => number })
  : Promise<{ totalPages: number; remainingPages: number }>;
// Atomic file write via SQLite VFS. Safe while DB open.
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: RED — v0.1.2 fixture + upgrade-path test scaffold (CC.1 gate)</name>
  <files>src/memory/__fixtures__/v0.1.2-baseline.db, src/memory/__fixtures__/README.md, src/memory/__fixtures__/_generate-v0.1.2.mjs, src/runtime/store/migrate-v2-drop-orphans.test.ts</files>
  <behavior>
    CC.1 enforcement gate (PITFALLS.md:233-239, 332). Fixture MANDATORY before any other task may proceed.

    **Fixture construction (deterministic):**
    - `_generate-v0.1.2.mjs` instantiates v0.1.2-shape DB by inlining a snapshot of DDL_STATEMENTS from git tag v0.1.2 (commit 7c7afc2) — avoids build-time git ops
    - INSERT ≥3 memory rows: one pinned (trust_level='confirmed'), one with embedding_blob=NULL, one with realistic tags_json+sources_json
    - INSERT ≥1 row into each FK-permissive orphan: continuity_objects, recipes (valid FK), proxy_requests, sign_offs, sign_off_amendments (valid FK), operator_annotations, verifications
    - tasks/jobs/job_events/task_deps left EMPTY (FK chains fragile to fabricate)
    - All content anonymized — no PII, no real tokens; README.md enforces this on future updates
    - Commit .db binary directly (~20-30KB)

    **Test cases (all MUST FAIL with import-missing errors):**
    - T1: copy fixture to tmpdir → applySchema → schema_version row exists version=2
    - T2: same → 11 orphan tables absent from sqlite_master
    - T3: same → memory row count unchanged, each row content readable
    - T4: same → applySchema twice → no error, no duplicate version=2 row (idempotency)
    - T5: empty DB → applySchema → schema_version=2, no orphans created
    (T6/T7 added in Task 3 for backup assertions)
  </behavior>
  <action>
    RED only — write fixture + tests, NO implementation. All 5 tests MUST fail citing missing exports (`migrateDropOrphansV02` from `./migrate-v2-drop-orphans`, `readSchemaVersion`/`EXPECTED_SCHEMA_VERSION` from `./schema-version`).

    Tests: `node:test` + `import assert from 'node:assert/strict'` per project convention. Open fixture via `fs.copyFileSync(fixture, tmpPath)` then `new Database(tmpPath)` — NEVER mutate the fixture itself.

    Generator script kept in tree (not gitignored) — reviewers regenerate. The .db is the committed artifact.

    Commit: `test(01): RED — v0.1.2 fixture + upgrade-path scaffold for v2 migration`
  </action>
  <verify>
    <automated>npm test -- migrate-v2-drop-orphans 2>&1 | grep -E "(FAIL|fail|error)" | head -20</automated>
    Expected: 5 failing tests each citing missing export. Fixture binary present. README.md documents provenance + regen.
  </verify>
  <done>Fixture .db committed (≤30KB), README.md + generator script present, 5 failing tests cite missing helpers. CC.1 gate satisfied.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: GREEN — schema_version helpers + v2 DROP migrator + applySchema rewire</name>
  <files>src/runtime/store/schema-version.ts, src/runtime/store/schema-version.test.ts, src/runtime/store/migrate-v2-drop-orphans.ts, src/runtime/store/db.ts, src/runtime/store/db.test.ts</files>
  <behavior>
    **schema-version.ts:** export `EXPECTED_SCHEMA_VERSION = 2`; `readSchemaVersion(db): number` returns MAX(version) (1 if table empty/post-bootstrap; 0 if table missing); `writeSchemaVersion(db, version, description)` does `INSERT OR IGNORE (version, applied_at=Date.now(), description)`.

    **schema_version DDL** prepended to DDL_STATEMENTS at db.ts:15:
    ```sql
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, description TEXT)
    ```

    **migrate-v2-drop-orphans.ts** — `migrateDropOrphansV02(db): void`:
    - Early-return if `readSchemaVersion(db) >= 2` (idempotency per SCHEMA-01)
    - Wrap in `db.transaction(() => { ... })()` (atomic rollback per PITFALLS.md CC.1)
    - DROP order (FK-safe per SCHEMA-02): (1) both sign_off triggers; (2) all orphan indexes IF EXISTS; (3) task_deps; (4) tasks; (5) jobs; (6) job_events; (7) sign_off_amendments; (8) sign_offs; (9) recipes; (10) continuity_objects; (11) proxy_requests; (12) operator_annotations; (13) verifications
    - End: `writeSchemaVersion(db, 2, 'drop 11 orphan tables per SCHEMA-02')`

    **db.ts edits (surgical — DO NOT rewrite):**
    1. Prepend schema_version DDL to DDL_STATEMENTS at :15
    2. DELETE orphan DDL strings from DDL_STATEMENTS (ranges in <interfaces>)
    3. DELETE orphan migration functions (:284-299, :316-322, :329-338, :340-349, :402-404)
    4. DELETE call sites in applySchema (:410, :412, :414, :415, :416)
    5. After DDL loop: `if (readSchemaVersion(db) === 0) writeSchemaVersion(db, 1, 'baseline v0.1.x schema')`
    6. After `migrateAuthTables(db)` at :426: add `migrateDropOrphansV02(db)` (backup wiring added in Task 3)

    **schema-version.test.ts:** readSchemaVersion(no-table)=0; (post-bootstrap)=1; (post-write of 2)=2; writeSchemaVersion idempotent; EXPECTED_SCHEMA_VERSION===2.

    **db.test.ts:** Fresh DB→schema_version rows for version=1 AND =2; applySchema run twice→no duplicates/errors/re-DROP; sqlite_master contains none of the 11 orphans.

    **DO NOT touch:** src/workers/*, src/memory/memory-store.ts, src/contracts/continuity.ts, src/contracts/amend_sign_off.ts (orphan Zod schemas — out of scope, deferred).
  </behavior>
  <action>
    GREEN — implement until Task 1 tests pass.

    Edit order: schema-version.ts → schema-version.test.ts → migrate-v2-drop-orphans.ts → db.ts (surgical) → db.test.ts.

    Run `npm test 2>&1 | tail -30` after each db.ts edit. The 1003 baseline MUST stay green. If a pre-existing test breaks, the deletion was too aggressive (tests in src/runtime/store/db.test.ts may reference orphan tables for setup — update them, or delete if they only exercised orphan-table behavior).

    Atomic commits:
    - `feat(01): schema-version helpers + EXPECTED_SCHEMA_VERSION=2`
    - `feat(01): v2 DROP migrator (FK-safe order, transactional, idempotent)`
    - `refactor(01): remove orphan DDL + migrations from db.ts; wire v2 migrator into applySchema`
  </action>
  <verify>
    <automated>npm test 2>&1 | tail -40</automated>
    Expected: 1003 baseline + 5 fixture-upgrade + schema-version + db.test cases all pass.
  </verify>
  <done>All tests green. Orphan tables absent post-applySchema. schema_version=2 written. Idempotent re-runs verified.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: GREEN — `.v1-backup` via online backup API + RELAY_SKIP_V2_BACKUP opt-out</name>
  <files>src/runtime/store/backup-v1.ts, src/runtime/store/backup-v1.test.ts, src/runtime/store/db.ts, src/runtime/store/migrate-v2-drop-orphans.test.ts</files>
  <behavior>
    **backup-v1.ts:**
    - `shouldSkipBackup(env = process.env): boolean` → true iff `env.RELAY_SKIP_V2_BACKUP === '1'`
    - `writeV1Backup(db, storeDir, env?): Promise<{skipped: boolean, backupPath?: string, reason?: string}>`:
      - shouldSkipBackup → `{skipped:true, reason:'RELAY_SKIP_V2_BACKUP=1'}` (no file)
      - readSchemaVersion(db) >= 2 → `{skipped:true, reason:'already-migrated'}`
      - storeDir missing → `{skipped:true, reason:'no-store-dir'}` (defensive: in-memory/test DBs)
      - `.v1-backup` exists at `path.join(storeDir, '.v1-backup')` → `{skipped:true, reason:'backup-exists', backupPath}` (preserve existing)
      - Otherwise: `await db.backup(backupPath)` → `{skipped:false, backupPath}`

    **db.ts — new exported `prepareDatabase(db, storeDir): Promise<void>`:**
    ```
    1. Run bootstrap portion of applySchema synchronously (CREATE schema_version + bootstrap row)
    2. If readSchemaVersion(db) < 2 AND !shouldSkipBackup():
         r = await writeV1Backup(db, storeDir)
         if (!r.skipped && !r.backupPath) throw Error('backup failed — aborting migration')
       // Backup failure WITHOUT opt-out is FATAL (PITFALLS.md CC.1, risk R-01-04)
    3. Run full applySchema (includes migrateDropOrphansV02)
    ```
    `applySchema(db)` stays synchronous + exported for tests. Production callers (find via `grep -rn "applySchema(" src/runtime/store/ --include="*.ts"` excluding tests; ~1 site in openDatabase factory) migrate to `await prepareDatabase(db, storeDir)`.

    **backup-v1.test.ts (7 cases):**
    - T1: RELAY_SKIP_V2_BACKUP=1 → skipped, no file
    - T2: fixture in tmpdir, env clean → .v1-backup exists, valid SQLite (SELECT count(*) FROM memories succeeds)
    - T3: schema_version=2 already → skipped reason='already-migrated', no overwrite
    - T4: .v1-backup pre-existing → skipped reason='backup-exists', original mtime preserved
    - T5: storeDir missing → skipped reason='no-store-dir', no throw
    - T6: integration — prepareDatabase on fixture: .v1-backup exists AND contains orphans AND main DB doesn't
    - T7: backup write fails (chmod storeDir 0o555 read-only) AND opt-out unset → prepareDatabase THROWS

    **Add to migrate-v2-drop-orphans.test.ts:** T6 (prepareDatabase writes .v1-backup); T7 (opt-out skips it).
  </behavior>
  <action>
    GREEN. Order: backup-v1.ts → backup-v1.test.ts → db.ts (prepareDatabase + migrate one production caller) → extend migrate-v2-drop-orphans.test.ts.

    Tests use `fs.mkdtempSync(path.join(os.tmpdir(), 'relay-backup-'))` per case, copy fixture in, cleanup in finally.

    Commit: `feat(01): online .v1-backup before v2 DROP (RELAY_SKIP_V2_BACKUP=1 opt-out; fail-loud on backup error)`
  </action>
  <verify>
    <automated>npm test -- backup-v1 migrate-v2-drop-orphans 2>&1 | tail -30</automated>
    Expected: backup-v1 (7 cases) + migrate-v2-drop-orphans (7 cases) pass. Full suite green.
  </verify>
  <done>.v1-backup written via online API before DROP. Opt-out skips. Re-runs no-op. Production openDatabase routes through prepareDatabase. Backup failure without opt-out aborts.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 4: GREEN — relay doctor schema_version probe</name>
  <files>src/cli/cmd-doctor.ts, src/cli/cmd-doctor.test.ts</files>
  <behavior>
    **New exported `checkSchemaVersion(storeDir: string): Promise<ProviderProbe>`:**
    - Open `path.join(storeDir, 'relay.db')` read-only: `new Database(p, {readonly:true, fileMustExist:true})`
    - `applied = readSchemaVersion(db)`
    - applied === EXPECTED → `{name:'schema_version', status:'ok', detail:'applied=2 matches expected=2'}`
    - applied < EXPECTED → `{status:'missing', detail:'applied=${applied} expected=2 — restart relay to apply pending migrations'}`
    - applied > EXPECTED → `{status:'failed', detail:'applied=${applied} exceeds expected=2 — downgrade or future-DB detected'}`
    - DB missing/unreadable → `{status:'missing', detail:'...'}`
    - Close DB in finally

    **Wire into executeDoctorCommand:** Read cmd-doctor.ts fully first to locate probe-aggregation site (likely Promise.all near end). Insert `checkSchemaVersion(storeDir)` using whatever storeDir-resolution helper the file already uses for other probes.

    **cmd-doctor.test.ts cases:**
    - T1: storeDir with schema_version=2 → status='ok'
    - T2: storeDir with schema_version=1 only → status='missing' includes "applied=1 expected=2"
    - T3: storeDir with no relay.db → status='missing', no throw
    - T4: storeDir with schema_version=99 (manually INSERTed) → status='failed' includes "downgrade"
    - T5: integration — executeDoctorCommand({json:true},...) against fixture tmpdir → JSON contains probe entry name 'schema_version'
  </behavior>
  <action>
    GREEN. Read cmd-doctor.ts:1-441 FIRST to locate probe-aggregation site. Imports at :8 give the pattern.

    Add: `import { readSchemaVersion, EXPECTED_SCHEMA_VERSION } from '../runtime/store/schema-version.js'`; `import Database from 'better-sqlite3'`.

    Place `checkSchemaVersion` near other check functions (~:80-100, alongside `checkHookRoundtrip` at :70).

    Commit: `feat(01): relay doctor schema_version probe (ok | missing | failed)`
  </action>
  <verify>
    <automated>npm test -- cmd-doctor 2>&1 | tail -20 && npm run build 2>&1 | tail -5</automated>
    Expected: cmd-doctor tests pass (5 new + existing). Build succeeds.
  </verify>
  <done>Doctor reports schema_version status in JSON and human-readable output via existing `statusBadge` (cmd-doctor.ts:7).</done>
</task>

</tasks>

<verification>
**Phase-level gates (all blocking):**
1. Fixture committed: `git ls-files src/memory/__fixtures__/v0.1.2-baseline.db` returns path
2. Full suite green: `npm test` reports 1003+ passing
3. Orphan tables gone: copy fixture to tmp, run prepareDatabase, `sqlite3 <tmp> ".tables"` shows none of the 11
4. Backup written: `ls tmp/.v1-backup` exists, backup contains orphan tables
5. Opt-out: with RELAY_SKIP_V2_BACKUP=1, `.v1-backup` MUST NOT exist
6. Idempotency: prepareDatabase twice → no error, no duplicate version=2 row
7. Doctor surfaces version: `node dist/cli.js doctor --json | jq '.checks[] | select(.name=="schema_version")'` returns entry
8. CC.4 lint (PITFALLS.md:316): `grep -E "^import" src/memory/memory-engine.ts` shows ONLY `./types`/`./constants`
9. CC.7 stack lock: `git diff package.json` shows ZERO new deps
</verification>

<success_criteria>
| ROADMAP Phase 1 criterion (lines 36-40) | Satisfied by |
|---|---|
| #1 v0.1.2 DB → schema_version=2, memories intact | Task 1 fixture + Task 2 migrator + Task 4 doctor (gates 3, 7) |
| #2 11 orphan tables removed, FK order respected | Task 2 FK-safe transactional DROP (gate 3) |
| #3 .v1-backup present; RELAY_SKIP_V2_BACKUP=1 opts out | Task 3 (gates 4, 5) |
| #4 relay doctor schema_version check | Task 4 (gate 7) |
</success_criteria>

<threat_model>
**Trust Boundaries:** filesystem→DB (user's relay.db untrusted on first v0.2 launch); env→backup-gate (RELAY_SKIP_V2_BACKUP user-settable, no auth); script→fixture (committed binary, supply-chain risk if generator modified).

**STRIDE Threat Register:**
| ID | Cat | Component | Disposition | Mitigation |
|----|-----|-----------|-------------|------------|
| T-01-01 | T | v0.1.2 fixture | mitigate | README documents provenance + regen script; reviewer regenerates; ≤30KB cap |
| T-01-02 | I | fixture content | mitigate | Anonymized; README enforces re-verification on update |
| T-01-03 | D | re-run loop dropping tables | mitigate | Idempotency gate `readSchemaVersion >= 2` early-return; Task 2 T4 asserts no-op |
| T-01-04 | I | .v1-backup file perms | accept | Backup inherits storeDir perms; alternate path requires user config (out of scope) |
| T-01-05 | E | .v1-backup overwrite | mitigate | writeV1Backup refuses to overwrite (Task 3 T4); prevents recovery file corruption |
| T-01-06 | T | RELAY_SKIP_V2_BACKUP=1 bypass | accept | Local CLI, user owns process; opt-out by design per SCHEMA-03 |
| T-01-07 | R | audit "did migration run?" | mitigate | schema_version table preserves (version, applied_at, description); doctor surfaces |
</threat_model>

<runtime_validation>
**Smoke test (run before marking complete):**
```bash
npm run build
TMP=$(mktemp -d /tmp/relay-smoke.XXX); cp src/memory/__fixtures__/v0.1.2-baseline.db "$TMP/relay.db"
ORPHANS='^(continuity_objects|recipes|sign_offs|sign_off_amendments|jobs|tasks|task_deps|job_events|proxy_requests|verifications|operator_annotations)$'
sqlite3 "$TMP/relay.db" ".tables" | tr ' ' '\n' | grep -cE "$ORPHANS"  # expect 11
RELAY_STORE_DIR="$TMP" node dist/cli.js info > /dev/null
sqlite3 "$TMP/relay.db" ".tables" | tr ' ' '\n' | grep -cE "$ORPHANS"  # expect 0
sqlite3 "$TMP/relay.db" "SELECT MAX(version) FROM schema_version"  # expect 2
test -f "$TMP/.v1-backup" && echo "backup OK" || echo "FAIL"
sqlite3 "$TMP/.v1-backup" ".tables" | grep -c continuity_objects  # expect 1
node dist/cli.js doctor --json 2>/dev/null | grep -o '"schema_version"' | head -1  # expect match
TMP2=$(mktemp -d /tmp/relay-opt.XXX); cp src/memory/__fixtures__/v0.1.2-baseline.db "$TMP2/relay.db"
RELAY_STORE_DIR="$TMP2" RELAY_SKIP_V2_BACKUP=1 node dist/cli.js info > /dev/null
test -f "$TMP2/.v1-backup" && echo "FAIL — opt-out ignored" || echo "opt-out OK"
RELAY_STORE_DIR="$TMP" node dist/cli.js info > /dev/null  # 2nd run idempotency
sqlite3 "$TMP/relay.db" "SELECT COUNT(*) FROM schema_version WHERE version=2"  # expect 1
rm -rf "$TMP" "$TMP2"
```
Any failure blocks phase completion.
</runtime_validation>

<risk_register>
| ID | Risk | L | I | Mitigation | Residual |
|----|------|---|---|------------|----------|
| R-01-01 | Fixture drifts from real v0.1.2 schema | LOW | HIGH | Generator anchored to commit 7c7afc2; README documents regen; binary committed | Accepted (snapshot pattern) |
| R-01-02 | FK drop order wrong → txn rollback, DB stuck at v1 | MED | HIGH | Task 2 T1-3 assert post-migration state on populated fixture; smoke catches incomplete drops; txn wrapper ensures atomic rollback | LOW |
| **R-01-03 (R-rollback — DROP IRREVERSIBLE)** | DROP cannot be undone in SQLite. Only `.v1-backup` enables recovery. | MED | CATASTROPHIC | (1) .v1-backup via online backup BEFORE txn (SCHEMA-03); (2) opt-out defaults safe; (3) recovery documented (PITFALLS.md:368); (4) Orphans verified zero call sites (SCHEMA-MAP §4); (5) Fixture proves memories survive; (6) Task 3 T7: backup failure WITHOUT opt-out is FATAL | ACCEPTED with recovery path |
| R-01-04 | Backup write fails silently (disk full, perms) | LOW | HIGH | prepareDatabase checks `{skipped, backupPath}`; if !skipped && !backupPath → THROW (Task 3 T7) | LOW — fail-loud |
| R-01-05 | Removing migrateProxyRequestsFullBody etc breaks old DB | LOW | MED | All deleted migrations only ALTER tables we DROP in same run; order: bootstrap → existing migrations (no-op on orphans) → v2 drop | LOW |
| R-01-06 | Fixture binary balloons repo over time | LOW | LOW | One fixture per major version (≤30KB); cap <200KB across future versions | Accepted |
| R-01-07 | Doctor read-only lock conflicts with other relay invocations | LOW | LOW | SHARED lock allows concurrent readers; no new contention | Accepted |
</risk_register>

<rollback_plan>
**Pre-flight:** `.v1-backup` IS the rollback artifact (Task 3). Without it, rollback impossible (SQLite DROP irreversible).

1. **v0.2 not yet launched** → no rollback needed (DB untouched)
2. **v0.2 launched, migration succeeded, downstream issue** → `cp ~/.relay/.v1-backup ~/.relay/relay.db` + downgrade binary to v0.1.2. Memories written between launch and rollback are LOST — document in CHANGELOG
3. **Migration FAILED mid-transaction** → txn wrapper auto-rolls back; schema_version stays at 1/0; DROPs reverted. Next launch retries (must fix root cause first — error is non-silent)
4. **Engineering revert** → `git revert <phase-1-merge>` restores db.ts. Existing migrated user DBs stay v0.2 (only .v1-backup restore reverses their DROPs). schema_version table remains — harmless (CREATE IF NOT EXISTS idempotent)

**Recovery cost** per PITFALLS.md:368: HIGH for #2/#3 with intermediate writes; LOW for code revert pre-launch.

**Hotfix user comms template:** "v0.2.1: if v0.2.0 caused [symptom], restore `~/.relay/.v1-backup` → `~/.relay/relay.db`, then `npm install -g relay@0.1.2`. Memories written after v0.2.0 launch are lost — see CHANGELOG postmortem."
</rollback_plan>

<output>
After completion, create `.planning/phases/01-schema-cleanup/01-01-SUMMARY.md` capturing: files actually touched (diff vs files_modified); test count delta (baseline 1003 → final ?); fixture path + size + row count; smoke-test results; deviations from plan with justification; items deferred (orphan Zod schemas at src/contracts/continuity.ts + amend_sign_off.ts — explicitly out of scope; flag for later cleanup).
</output>
