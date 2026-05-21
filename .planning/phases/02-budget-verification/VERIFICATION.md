---
phase: 02-budget-verification
verified: 2026-05-20T19:00:00Z
status: gaps_found
score: 3/4 success criteria verified
re_verification: null
gaps:
  - truth: "User can run `relay budget show --provider lmstudio --workdir /path` and see scoped usage rows without schema errors"
    status: failed
    reason: "CLI dispatcher silently drops --provider, --workdir, --period flags before invoking the v0.2 handler. The implementation in cmd-budget.ts is correct and unit-tested, but the dispatcher in src/cli.ts only forwards { json } — the three scoping flags never reach executeBudgetShowCommand."
    artifacts:
      - path: "src/cli.ts:649-652"
        issue: "dispatchBudget calls executeBudgetShowCommand({ json: isBool(flags, 'json') }, io) — omits lastOption(flags,'provider'), lastOption(flags,'workdir'), lastOption(flags,'period')"
    missing:
      - "Wire lastOption(flags, 'provider'), lastOption(flags, 'workdir'), lastOption(flags, 'period') into the BudgetShowArgs payload at src/cli.ts:651"
      - "Add a black-box CLI integration test that invokes `relay budget show --provider X --json` via the dispatcher and asserts scope_filters.provider === 'X' in the envelope (existing tests bypass the dispatcher)"
---

# Phase 2: Budget Verification — Report

**Phase Goal:** Confirm the already-shipped v0.2 budget store, scope CHECK, and `cmd-budget` flag surface chain correctly with the new `schema_version` table from Phase 1, and that all 972+ existing tests stay green after the schema migration applies.

**Verified:** 2026-05-20
**Status:** gaps_found
**Re-verification:** No — initial verification

## Verdict: BLOCK

One blocking integration gap: CLI dispatcher does not pass the `--provider`/`--workdir`/`--period` flags through to the v0.2 handler. The flags are silently swallowed, so SC#1 cannot be satisfied via the actual `relay budget show` command-line surface. The unit-tested implementation is correct; the wiring is not.

## Success criteria results

### SC#1 — `relay budget show --provider lmstudio --workdir /path` returns scoped rows — **FAIL**

Implementation correct: `src/cli/cmd-budget.ts:49-100` parses BudgetShowArgs (provider/workdir/period), validates period, resolves relative workdirs against `io.cwd`, calls `BudgetStore.getUsage`. `BudgetStore.getUsage` at `src/runtime/budget/budget-store.ts:150-187` binds every user value as `?` parameter and returns the documented envelope.

Dispatcher broken: `src/cli.ts:649-652` forwards only `{ json }`:

```
if (action === 'show') {
  const { executeBudgetShowCommand } = await import('./cli/cmd-budget.js');
  return executeBudgetShowCommand({ json: isBool(flags, 'json') }, io);
}
```

Live repro against v0.2-migrated DB:
- `relay budget show --provider lmstudio --workdir /tmp --json` → `scope_filters: {provider:null, workdir:null, period:null}` (flags dropped)
- `relay budget show --period bogus --json` → exits 0 instead of 2 (period validation never runs)

### SC#2 — Scope CHECK constraint survives migration — **PASS**

- `src/runtime/budget/db-migrations.ts:13`: `ALLOWED_SCOPES = ['model', 'owner', 'global', 'provider', 'workdir']`
- DDL emits `CHECK(scope IN ('model', 'owner', 'global', 'provider', 'workdir'))`
- Phase 2 upgrade path at `db-migrations.ts:98-121` transactionally recreates legacy tables to widen the CHECK
- Live DB after v0.2 launch confirms: `sqlite3 relay.db "SELECT sql FROM sqlite_master WHERE name='budget_limits'"` shows the 5-value CHECK
- Direct INSERT of `scope='provider'`/`scope='workdir'` rows succeeded against the migrated DB

### SC#3 — Previously-passing budget tests stay green after Phase 1 migration — **PASS**

- Full suite: 1126/1126 pass, 0 fail, 13.79s
- Targeted budget tests (`budget-store.test.js`, `db-migrations.test.js`, `cmd-budget.test.js`, `contracts/budget.test.js`): 54/54 pass
- Key subtests verified by name: `migrateBudgetTables — fresh DB`, `BudgetStore.getUsage — scoping by provider/workdir/period`, `executeBudgetShowCommand — --json envelope`, `executeBudgetShowCommand — schema_version stability guard`, `accepts scope=provider and scope=workdir for budget_limits`, `accepts scope=provider and scope=workdir for budget_alerts`

### SC#4 — `relay doctor` reports no budget-related schema drift; schema_version probe present — **PASS**

- `src/cli/cmd-doctor.ts:111-152`: `checkSchemaVersion` opens read-only, compares `readSchemaVersion(db)` against `EXPECTED_SCHEMA_VERSION`
- `src/cli/cmd-doctor.ts:455-462`: probe wired into the doctor pipeline, uses `dirname(RELAY_DB_PATH) || ~/.relay`
- Live: `relay doctor --json` against a freshly v0.2-migrated DB returns `{name:'schema_version', status:'ok', detail:'applied=2 matches expected=2'}`
- No budget-specific probe exists, but the question is "no drift reported" — and none is, because `applySchema` always calls `migrateBudgetTables` (idempotent) before doctor reads

## Test results

- Full suite: **1126 pass / 0 fail / 0 skip / 13.79s** (after `unset RELAY_MEMORY_ALLOWED_WORKDIRS RELAY_ALLOWED_ROOTS`)
- Budget-scoped tests (4 files, 54 subtests): **54 pass / 0 fail**

## Schema CHECK constraint values verified

Live `sqlite_master` SQL from `/tmp/relay-verify-p2/test.db` after first launch:

```
CREATE TABLE budget_limits (
  ...
  scope TEXT NOT NULL CHECK(scope IN ('model', 'owner', 'global', 'provider', 'workdir')),
  ...
)
```

INSERTs with `scope='provider'` and `scope='workdir'` succeed; existing legacy values (`model`, `owner`, `global`) still admitted.

## Doctor schema_version surfaces

`src/cli/cmd-doctor.ts:111` (function `checkSchemaVersion`) and `:462` (pipeline call site). Live JSON output:

```
{"name":"schema_version","status":"ok","detail":"applied=2 matches expected=2"}
```

## Budget tables survived Phase 1 v2 migration

`src/runtime/store/migrate-v2-drop-orphans.ts:32-48` — `DROP_TABLES` list contains: `task_deps, tasks, jobs, job_events, sign_off_amendments, sign_offs, recipes, continuity_objects, proxy_requests, operator_annotations, verifications`. Zero matches for `budget_limits` / `budget_alerts` / `cost_events`. Live `sqlite3 .tables` on migrated DB shows `budget_limits`, `budget_alerts`, `cost_events` all present.

## Issues found

**BLOCKER #1 — Dispatcher drops scoping flags (`src/cli.ts:649-652`)**

The v0.2 `cmd-budget.ts` accepts `provider`, `workdir`, `period` on its `BudgetShowArgs` type, and the BudgetStore correctly scopes its SQL when those values are present. But the CLI dispatcher only constructs `{ json }` — it never extracts the three scoping flags from `parseFlags(rest)`. Net effect: end users running `relay budget show --provider lmstudio` get an unscoped total and silently lose the v0.2 feature surface that this phase was meant to verify. Unit tests pass because they call `executeBudgetShowCommand` directly, bypassing the dispatcher.

Fix is one block at `src/cli.ts:651`:

```typescript
return executeBudgetShowCommand({
  json: isBool(flags, 'json'),
  provider: lastOption(flags, 'provider'),
  workdir: lastOption(flags, 'workdir'),
  period: lastOption(flags, 'period'),
}, io);
```

Plus a black-box CLI test that invokes the dispatcher with these flags and asserts the JSON envelope's `scope_filters` carries them through. The existing 4 test files do not cover the dispatcher path.

---

_Verified: 2026-05-20_
_Verifier: Claude (gsd-verifier)_
