---
phase: v0.2
plan: 7
type: tdd
wave: 1
depends_on: []
files_modified:
  - src/runtime/budget/db-migrations.ts
  - src/runtime/budget/budget-store.ts
  - src/cli/cmd-budget.ts
  - src/cli.ts
  - src/contracts/budget.ts
  - src/runtime/budget/budget-store.test.ts
  - src/cli/cmd-budget.test.ts
autonomous: true
requirements: [ROADMAP-7]
must_haves:
  truths:
    - "`relay budget show` sums cost across all providers/workdirs"
    - "`--provider <name>` filters sum by provider"
    - "`--workdir <path>` filters sum by workdir"
    - "`--provider` + `--workdir` combine as AND"
    - "`--json` emits stable envelope w/ schema_version"
    - "Existing `model|owner|global` scope writes still work (no regression)"
  artifacts:
    - path: src/cli/cmd-budget.ts
      provides: "executeBudgetShowCommand replacing stub"
    - path: src/runtime/budget/budget-store.ts
      provides: "getUsage(opts) sum query w/ provider+workdir filters"
      exports: ["BudgetStore"]
    - path: src/runtime/budget/db-migrations.ts
      provides: "expanded CHECK accepting 'provider'+'workdir'"
  key_links:
    - from: src/cli/cmd-budget.ts
      to: src/runtime/budget/budget-store.ts
      via: "BudgetStore.getUsage({provider, workdir})"
      pattern: "getUsage"
    - from: src/cli.ts
      to: src/cli/cmd-budget.ts
      via: "dispatchBudget → dynamic import"
      pattern: "executeBudgetShowCommand"
    - from: src/runtime/budget/budget-store.ts
      to: cost_events
      via: "SUM(cost_usd) WHERE provider=? AND workdir=?"
      pattern: "FROM cost_events"
---

<objective>
Replace `relay budget show` deferred stub (cmd-budget.ts:19-31) with real impl that sums `cost_events.cost_usd` scoped by `--provider` and/or `--workdir`. Expand `budget_limits.scope` + `budget_alerts.scope` CHECK constraints (db-migrations.ts:7,24) to admit `provider`+`workdir` so future `set` actions can persist these scopes.

Purpose: Finish v0.1-deferred work. Unblocks per-project / per-provider cost visibility.
Output: Working `relay budget show [--provider X] [--workdir Y] [--period P] [--json]`.
</objective>

<context>
@/Users/ghanavati/ai-stack/Projects/Relay/.planning/v0.2/BUDGET-CLI-SCHEMA-MAP.md
@/Users/ghanavati/ai-stack/Projects/Relay/.planning/v0.2/ROADMAP-DRIFT.md
@/Users/ghanavati/ai-stack/Projects/Relay/ROADMAP.md
@src/runtime/budget/db-migrations.ts
@src/runtime/budget/budget-store.ts
@src/cli/cmd-budget.ts
@src/cli.ts
@src/cli/cmd-memory-recent.ts

<interfaces>
<!-- Extracted via BUDGET-CLI-SCHEMA-MAP.md -->

From src/cli/commands.ts:8-12:
```typescript
export interface CliIO { cwd: string; stdout: (m: string) => void; stderr: (m: string) => void; }
```

cost_events columns (db.ts:114-125): provider TEXT, workdir TEXT (idx_cost_events_workdir at db.ts:190), cost_usd REAL, created_at INTEGER.

Existing CHECK (db-migrations.ts:7, 24): `scope IN ('model','owner','global')`.

CLI dispatch (cli.ts:640-656, 715): `if (cmd === 'budget') return dispatchBudget(rest);` — keep wiring; only args object grows.

--json pattern (cmd-memory-recent.ts:87-90): `JSON.stringify(payload) + '\n'` to stdout; errors to stderr.

Exit codes: 0 success | 2 bad/unknown args. Today's stub returns 0 for deferred — fix to real-success-only.
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Expand budget_limits + budget_alerts CHECK to include 'provider'+'workdir'</name>
  <files>
    src/runtime/budget/db-migrations.ts,
    src/runtime/budget/db-migrations.test.ts (new if absent)
  </files>
  <behavior>
    - Fresh DB: scope='provider' INSERT into budget_limits SUCCEEDS
    - Fresh DB: scope='workdir' INSERT SUCCEEDS
    - Fresh DB: scope='model'/'owner'/'global' still SUCCEED (regression guard)
    - Fresh DB: scope='garbage' FAILS w/ CHECK violation
    - Pre-existing DB w/ old CHECK: migration idempotently upgrades, no data loss
    - Re-running migration on upgraded DB: no-op
  </behavior>
  <action>
    SQLite cannot ALTER CHECK in place. Implement:
    1. Detect "needs upgrade" via probe (try INSERT scope='provider' inside SAVEPOINT; rollback; if it threw → upgrade; else done). Or: bump PRAGMA user_version sentinel.
    2. If upgrade: BEGIN TRANSACTION → CREATE TABLE budget_limits_new w/ CHECK `('model','owner','global','provider','workdir')` → INSERT SELECT * → DROP old → RENAME _new → recreate UNIQUE INDEX (db-migrations.ts:17-19) → COMMIT.
    3. Repeat for budget_alerts (db-migrations.ts:22-32 + indexes :36-43).
    4. Scope strictly to budget tables — do NOT touch broader schema_version (ROADMAP #1 territory).
  </action>
  <verify>
    <automated>npm test -- src/runtime/budget/db-migrations.test.ts</automated>
  </verify>
  <done>
    All behavior cases pass. Existing BudgetStore tests stay green. Idempotent (run twice → identical state).
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Add BudgetStore.getUsage({provider?, workdir?, sincePeriod?}) → {total_usd, event_count, scope_filters}</name>
  <files>
    src/runtime/budget/budget-store.ts,
    src/runtime/budget/budget-store.test.ts,
    src/contracts/budget.ts
  </files>
  <behavior>
    Given 5 fixture cost_events mixing providers (lmstudio, openrouter, anthropic) and workdirs (/a, /b):
    - getUsage({}) → SUM all 5
    - getUsage({provider:'lmstudio'}) → SUM lmstudio-only
    - getUsage({workdir:'/a'}) → SUM /a-only
    - getUsage({provider:'openrouter', workdir:'/a'}) → SUM intersection (AND)
    - getUsage({provider:'nonexistent'}) → {total_usd:0, event_count:0}
    - getUsage({sincePeriod:'daily'}) → SUM where created_at >= now-24h (reuse periodSinceMs at :26-30)
    - Result shape stable: zod-validated GetUsageResult exported from contracts/budget.ts
  </behavior>
  <action>
    1. Add zod schemas `GetUsageOptsSchema`+`GetUsageResultSchema` to contracts/budget.ts; export inferred types.
    2. Add method on BudgetStore (budget-store.ts:67). Dynamic WHERE assembly w/ parameter binding (`?` placeholders; never string-concat).
    3. SQL: `SELECT COALESCE(SUM(cost_usd),0) AS total_usd, COUNT(*) AS event_count FROM cost_events WHERE 1=1 [AND provider=?] [AND workdir=?] [AND created_at >= ?]`. Leverages existing idx_cost_events_workdir.
    4. Return echoes scope_filters (null for unspecified) — needed for stable JSON.
    5. DO NOT modify existing `getCurrentCost` (:32-65) — used by checkBudgets; add getUsage as sibling. Future refactor can consolidate.
  </action>
  <verify>
    <automated>npm test -- src/runtime/budget/budget-store.test.ts</automated>
  </verify>
  <done>
    All 6 cases pass. Parameter binding verified (no injection). Existing tests green. Types exported.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Replace cmd-budget.ts stub w/ real `show` impl; wire flags through dispatchBudget</name>
  <files>
    src/cli/cmd-budget.ts,
    src/cli/cmd-budget.test.ts,
    src/cli.ts
  </files>
  <behavior>
    With fixture DB:
    - `relay budget show` → `Total: $X.XXXX across N events`, exit 0
    - `--provider lmstudio` → human line w/ provider in header, exit 0
    - `--workdir /path` → human line w/ workdir in header, exit 0
    - `--provider openrouter --workdir /a` → header w/ both, exit 0
    - `--json` → single JSON line `{schema_version:1, total_usd, event_count, scope_filters:{provider, workdir, period}}`, exit 0
    - `--provider lmstudio --json` → JSON.scope_filters.provider='lmstudio'
    - `--period daily --json` → JSON.scope_filters.period='daily'
    - `--period bogus` → stderr `"unknown --period value 'bogus'. Try: daily, monthly, alltime"`, exit 2
    - Empty DB: human → `Total: $0.0000 across 0 events`; JSON → zeros; exit 0
    - Test asserts `schema_version` field present (stability guard)
  </behavior>
  <action>
    1. Rewrite executeBudgetShowCommand(args, io) in cmd-budget.ts:
       - args: `{json: boolean, provider?: string, workdir?: string, period?: 'daily'|'monthly'|'alltime'}`
       - Validate period against allowlist → bad → stderr + return 2.
       - Open DB via existing util (look at cmd-memory-recent.ts:1-30 for openSharedDb / openMemoryStore pattern; budget shares same DB — verify exact import at execute time).
       - `new BudgetStore(db)` → `store.getUsage({provider, workdir, sincePeriod: period})`.
       - If args.json: `JSON.stringify({schema_version: 1, ...result}) + '\n'`.
       - Else: human-formatted header (applied filters) + body (total + event_count, $ to 4dp).
       - Return 0 on success.
       - Remove BUDGET_DEFERRED_* constants and deprecated `{status:'deferred'}` JSON.
    2. Update dispatchBudget (cli.ts:640-656):
       - Parse: `provider = lastOption(flags, 'provider')`, `workdir = lastOption(flags, 'workdir')`, `period = lastOption(flags, 'period')`, `json = isBool(flags, 'json')`.
       - Pass all into executeBudgetShowCommand.
       - Keep no-action (:644-647) and unknown-action (:654-655) branches returning 2.
    3. Update help text at cli.ts:244 — replace "deferred 0.2.0" w/ actual usage:
       `relay budget show [--provider <name>] [--workdir <path>] [--period daily|monthly|alltime] [--json]`
    4. Update cmd-budget.test.ts (currently :63 asserts deferred reason) — remove deferred-state tests, add the 9 behavior cases above. In-memory better-sqlite3 fixture.
    5. Edge: if `--workdir` is relative, resolve via `path.resolve(io.cwd, workdir)` before binding (cost_events.workdir stores absolute paths; verify at execute time or document as caller responsibility).
  </action>
  <verify>
    <automated>npm test -- src/cli/cmd-budget.test.ts && npm test -- src/cli.test.ts</automated>
  </verify>
  <done>
    All 9 cases pass. Help text reflects new usage. Stub-era constants gone. Exit codes: 0 happy, 2 bad args — deferred-returns-0 inconsistency resolved.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 4: Runtime integration test — 5 events, 4 CLI variants, assert sums match</name>
  <files>
    src/cli/cmd-budget.integration.test.ts (new)
  </files>
  <behavior>
    1. Temp DB via openSharedDb on tmpdir
    2. Insert 5 cost_events:
       - (lmstudio,   /a, 0.01)
       - (lmstudio,   /b, 0.02)
       - (openrouter, /a, 0.10)
       - (openrouter, /b, 0.20)
       - (anthropic,  /a, 1.00)
    3. Invoke executeBudgetShowCommand 4×, assert:
       - no flags → total=1.33, count=5
       - --provider lmstudio → total=0.03, count=2
       - --workdir /a → total=1.11, count=3
       - --provider openrouter --workdir /a --json → `{schema_version:1, total_usd:0.10, event_count:1, scope_filters:{provider:'openrouter', workdir:'/a', period:null}}`
    4. All return exit 0
  </behavior>
  <action>
    Mirror helper pattern in cmd-memory-recent.test.ts (capture stdout via io.stdout array push). One describe('cmd-budget integration'), four it() blocks. Share fixture DB in beforeAll for speed.
  </action>
  <verify>
    <automated>npm test -- src/cli/cmd-budget.integration.test.ts</automated>
  </verify>
  <done>
    All 4 assertions pass. Coverage for cmd-budget.ts + getUsage ≥ 80%.
  </done>
</task>

</tasks>

<verification>
After all 4 tasks:
1. `npm test` — full suite passes (catches regression in checkBudgets / getCurrentCost callers)
2. `npm run typecheck` (or `tsc --noEmit`) — no type errors from new zod schemas
3. Manual smoke on workdir w/ real cost_events:
   - `relay budget show`
   - `relay budget show --provider lmstudio`
   - `relay budget show --workdir "$PWD"`
   - `relay budget show --json | jq .schema_version` → 1
4. `relay budget` (no action) still prints help + returns 2 (cli.ts:644-647 regression guard)
5. `relay budget bogus` still returns 2 (cli.ts:654-655 regression guard)
</verification>

<success_criteria>
- All 6 must_haves.truths satisfied
- All existing tests green
- `schema_version: 1` present in `--json` output
- Exit-code consistency restored (0 only on real success)
- No new runtime deps (`git diff package.json` empty)
- files_modified matches actual diff (no scope creep into ROADMAP #1)
</success_criteria>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| user → CLI flags | --provider, --workdir, --period strings reach SQL |
| filesystem → DB | cost_events rows (relay-written, trusted) |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-v0.2.7-01 | Tampering | getUsage SQL WHERE clause | mitigate | All user values bound as `?` parameters (T2 step 3) |
| T-v0.2.7-02 | Tampering | CHECK migration on existing data | mitigate | Single TRANSACTION (T1 step 2); rollback leaves old schema intact |
| T-v0.2.7-03 | DoS | getUsage on huge cost_events | accept | Single aggregate w/ idx_cost_events_workdir; bounded by retention |
| T-v0.2.7-04 | Info Disclosure | --json shape changes silently | mitigate | Pin `schema_version: 1` (T3 step 1) |
| T-v0.2.7-05 | Repudiation | Migration rewrites budget_limits in place | accept | Local single-user DB; idempotency guard prevents re-runs |
| T-v0.2.7-06 | Tampering | --workdir relative path | mitigate | T3 step 5: `path.resolve(io.cwd, workdir)`; value still parameter-bound |
</threat_model>

<risk_register>
| # | Risk | Mitigation in plan |
|---|---|---|
| 1 | CHECK expansion corrupts existing data | T1: transactional recreate; idempotency guard; tested fresh+migrated |
| 2 | SQLite can't alter CHECK in place | T1: explicit drop+recreate pattern |
| 3 | --json shape breaks downstream | T3: schema_version:1 pinned + asserted |
| 4 | Scope creep into ROADMAP #1 | T1 strictly budget-table-scoped |
| 5 | getCurrentCost/checkBudgets regression | T2 keeps getCurrentCost untouched; full suite re-run |
| 6 | Relative --workdir vs absolute storage | T3 step 5 path.resolve guard |
</risk_register>

<output>
After completion, create `.planning/v0.2/PLAN-7-SUMMARY.md` with: files changed (line counts), test counts (added/total), coverage delta for affected files, deviations from plan w/ rationale, and the 4 manual smoke-command outputs.
</output>
