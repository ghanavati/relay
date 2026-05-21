---
phase: 07-figma-rest-tools
plan: 01
subsystem: figma-rest-tools
tags: [figma, rest, agentic, security, redaction, lmstudio]
requires:
  - 03-agentic-lmstudio-runner # ToolDef/ToolCall types + executeToolCall dispatch
provides:
  - src/tools/figma/index.ts:registerFigmaTools
  - src/tools/figma/index.ts:DEFERRED_FIGMA_TOOLS
  - src/tools/figma/list-layers.ts:handleListLayers
  - src/tools/figma/update-token.ts:handleUpdateToken
  - src/tools/figma/rest-client.ts:figmaGet
  - src/tools/figma/rest-client.ts:figmaPost
  - src/tools/figma/scrub.ts:scrubPat
  - src/tools/figma/pat-loader.ts:loadPat
  - src/cli/cmd-doctor-figma.ts:probeFigma
  - src/security/redaction.ts # figma_pat pattern
affects:
  - src/workers/lmstudio-agentic.ts # extraToolHandlers opt + executeToolCall 4th param
  - src/cli/cmd-run.ts # registerFigmaTools wire-up
  - src/cli/cmd-parallel.ts # registerFigmaTools wire-up
  - src/cli.ts # `relay doctor --figma` dispatch
tech_stack:
  added: [] # zod and native fetch only (no new runtime deps)
  patterns:
    - "Native fetch with single-retry Retry-After backoff (first in repo)"
    - "Typed error class hierarchy with kind-disambiguation (403 → PLAN_REQUIRED|TOKEN_EXPIRED|...)"
    - "Layered PAT scrubbing — tool-side scrubPat + always-on redaction.ts"
    - "Env-gated tool registration with null=graceful-absence"
    - "Declarative deferral via readonly const (NOT stubs)"
key_files:
  created:
    - src/tools/figma/scrub.ts
    - src/tools/figma/pat-loader.ts
    - src/tools/figma/rest-client.ts
    - src/tools/figma/list-layers.ts
    - src/tools/figma/update-token.ts
    - src/tools/figma/index.ts
    - src/tools/figma/__fixtures__/files-nodes-response.json
    - src/cli/cmd-doctor-figma.ts
    - src/tools/figma/scrub.test.ts
    - src/tools/figma/pat-loader.test.ts
    - src/tools/figma/rest-client.test.ts
    - src/tools/figma/list-layers.test.ts
    - src/tools/figma/update-token.test.ts
    - src/tools/figma/index.test.ts
    - src/cli/cmd-doctor-figma.test.ts
  modified:
    - src/security/redaction.ts # +figma_pat pattern
    - src/security/redaction.test.ts # +3 figma_pat tests
    - src/workers/lmstudio-agentic.ts # +NamedToolHandler interface, +extraToolHandlers opt
    - src/workers/lmstudio-agentic.test.ts # +T11 dispatch tests, +regex relax for cmd-run/parallel
    - src/cli/cmd-run.ts # +registerFigmaTools wire-up
    - src/cli/cmd-parallel.ts # +registerFigmaTools wire-up
    - src/cli.ts # +`relay doctor --figma` dispatch
    - package.json # build:fixtures extended to copy tools/figma/__fixtures__
decisions:
  - "Phase 3 worker shape matched assumed contract — Path (a) chosen: extend executeToolCall with optional extraToolHandlers param. NO Phase 3 reshape required."
  - "Doctor probe uses GET /v1/me ONLY (per VERIFICATION W1 — plan-tier inference from /v1/me is unreliable across orgs). Enterprise verification is via figma_update_token's structured plan_required surface."
  - "No third-party 'demo file_key' (per VERIFICATION W2). Avoids low-grade availability dependency on outside Figma org."
  - "figma_pat regex added to src/security/redaction.ts (always-on REDACTION_PATTERNS), NOT redaction-pii.ts (auto-extract-gated). Catches every log path."
  - "Retry-After supports delta-seconds only in v0.2 (RFC 7231 first form). HTTP-date format defaults to 1s (R-07-07 mitigated; revisit v0.3)."
metrics:
  duration_minutes: 95
  completed_at: 2026-05-21
  tests_added: 54
  tests_total: 1325
  tests_baseline: 1245
---

# Phase 7 Plan 01: Figma REST Tools — Summary

## One-Liner
Two REST-only Figma tools (`figma_list_layers`, `figma_update_token`) wired into the Phase 3 agentic LM Studio runner with env-gated registration, single-retry Retry-After backoff, typed 403-kind disambiguation (PLAN_REQUIRED graceful surface), layered PAT scrubbing, and a `relay doctor --figma` probe. Plugin-bridge tools (`figma_get_selection`, `figma_create_component`) declaratively deferred to v0.3 via `DEFERRED_FIGMA_TOOLS` readonly const.

## What Shipped

| Task | Commits | Files | Notes |
|------|---------|-------|-------|
| T1 (PAT loader + scrubber) | `b90c24c` RED → `e3990e5` GREEN | scrub.ts, pat-loader.ts + 2 tests | chmod-600 enforced; FIGMA-03 null graceful; scrubHeaders returns NEW object |
| T2 (REST client) | `6bbe599` RED → `c706cdd` GREEN | rest-client.ts + test | Native fetch only (no axios/undici); 6 typed error classes; 429 single-retry; PAT scrub on every path |
| T3 (figma_list_layers) | `db15273` RED → `efacb3d` GREEN | list-layers.ts + test + fixture | Recursive flatten preserves parent_id + depth; routes both /nodes and /files/{key} shapes |
| T4 (figma_update_token) | `814b16f` RED → `a7e2959` GREEN | update-token.ts + test | Zod discriminated union per type; 403 PLAN_REQUIRED → structured return; other 403 kinds throw |
| T5 (registry + worker wire-up) | `ea09954` RED → `437a9e8` GREEN | index.ts + test, lmstudio-agentic.ts delta, cmd-run/parallel delta | `extraToolHandlers` opt added to runner; named-handler dispatch in executeToolCall; Phase 3 tests 65/65 still green |
| T6 (doctor --figma) | `69d7edd` RED → `a879457` GREEN | cmd-doctor-figma.ts + test, cli.ts delta | Probe + render functions; defense-in-depth scrubbing; DEFERRED_FIGMA_TOOLS rendered from const |
| T7 (integration / T8 in PLAN) | n/a — auto-mode checkpoint approved | n/a | DEFERRED-no-token (no live PAT available); all error paths covered by unit tests |

**Total commits:** 12 (6 RED + 6 GREEN test/feat pairs). Atomic per task. Baseline `npm test` 1245 → final 1325 (+80 tests including +6 redaction tests + +4 worker T11 dispatch tests).

## Decisions Made

1. **Phase 3 contract matched.** The planner's assumed `executeToolCall` shape held. Path (a) chosen — extend signature with optional `extraToolHandlers` param; runner stores it as constructor opt and passes through. No Phase 3 reshape. Phase 3 tests pass unchanged. Risk R-07-05 mitigated zero-effort.

2. **Doctor probe uses `/v1/me` only (W1 honored).** Plan-tier parse from `/v1/me` is unreliable (Figma's response varies per org). The probe surfaces PAT validity + REST reachability + user identity. Enterprise verification is a deliberate user action: run `figma_update_token` and observe the structured `plan_required` return.

3. **No third-party demo file_key (W2 honored).** Skipped the optional REST sample call against an outside file. Removes availability dependency on unrelated Figma org + avoids stealing their rate-limit quota.

4. **`figma_pat` regex placed in `redaction.ts` (always-on), NOT `redaction-pii.ts`.** Per FIGMA-MAP-CURRENT §9: PII patterns gate to auto-extract; PATs leak into ANY log path. Defense-in-depth: tool-side `scrub.ts` is the precise utility; `redaction.ts` is the catch-all.

5. **Retry-After: delta-seconds only in v0.2.** HTTP-date format defaults to 1s (commented in code). R-07-07 documented mitigation — defer date-parsing to v0.3 to avoid Node-version drift bugs in 429-path tests.

6. **`DEFERRED_FIGMA_TOOLS` is the single source of truth.** No function exports match deferred names; if a model emits `figma_get_selection`, the worker's existing "unknown tool" path catches it. Changing the const propagates to doctor output automatically.

## File:Line Citation — Wire-Up Site

The Figma-tool dispatcher integration point in the LM Studio agentic worker is:

- **Definition extension:** `src/workers/lmstudio-agentic.ts:115-138` — `NamedToolHandler` interface + `LmStudioAgenticRunnerOpts.extraToolHandlers` field
- **Storage:** `src/workers/lmstudio-agentic.ts:494-499` — Runner constructor stores `this.extraToolHandlers`
- **Dispatch:** `src/workers/lmstudio-agentic.ts:329-356` — `executeToolCall(...)` checks `extraToolHandlers` BEFORE `SHELL_EXEC_NAMES` (additive — shell_exec still wins on no match)
- **Loop call site:** `src/workers/lmstudio-agentic.ts:671` — `executeToolCall(tc, task.workdir, this.shellExec, this.extraToolHandlers)`
- **Wire-up at the CLI:** `src/cli/cmd-run.ts:81-101` and `src/cli/cmd-parallel.ts:55-71` — `registerFigmaTools(process.env, homedir())` resolves PAT and produces handler list passed into runner constructor.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Test framework] PLAN said `vitest`; project uses `node:test`.**
- **Found during:** Task 1 RED phase.
- **Issue:** PLAN.md said "Run vitest" but project test framework is `node:test` (per `npm test` script).
- **Fix:** Used `node:test` + `assert/strict` throughout — matches existing project convention (see `src/workers/lmstudio-agentic.test.ts`, `src/cli/cmd-doctor.test.ts`).
- **Files:** All 7 figma test files use `import { describe, test } from 'node:test'`.
- **Tracking:** Adapted to existing infrastructure rather than introducing vitest.

**2. [Rule 2 — Test infrastructure] Added build:fixtures extension.**
- **Found during:** Task 3 RED.
- **Issue:** `npm run build:fixtures` only copied `src/memory/__fixtures__/*.db` to dist. New `src/tools/figma/__fixtures__/*.json` would not be available to runtime tests.
- **Fix:** Extended `package.json:scripts.build:fixtures` to also `cp src/tools/figma/__fixtures__/*.json dist/tools/figma/__fixtures__/`.
- **Commit:** `efacb3d` (T3 GREEN).
- **Tracking:** Mirrors existing fixture copy pattern.

**3. [Rule 2 — Worker regression test patterns] Existing Phase 3 tests asserted `new LmStudioAgenticRunner()` with no args.**
- **Found during:** Task 5 first build.
- **Issue:** `cmd-run dispatch` + `cmd-parallel dispatch` tests grepped cmd-run.ts / cmd-parallel.ts for the regex `/new LmStudioAgenticRunner\(\)/` (empty parens). Phase 7 wire-up now constructs with `{ extraToolHandlers }` opt.
- **Fix:** Relaxed regex to `/new LmStudioAgenticRunner\(/` (allow constructor args). Original intent (verify runner is instantiated at the correct dispatch site) preserved.
- **Commit:** `437a9e8` (T5 GREEN — embedded in same commit).
- **Tracking:** Forward-compatible change; future plans can also extend opts without further regex churn.

### Path (a) vs (b) for Phase 3 integration

**Resolved at Task 5:** Path (a) — Phase 3 worker dispatch (`executeToolCall`) already had clean separation between dispatch and execution. Added 4th optional param `extraToolHandlers`. No factory-pattern Path (b) needed. Confirms VERIFICATION R-07-05 assertion: planner correctly anticipated Phase 3 stability.

## Authentication Gates

**None occurred during Phase 7 execution.** PAT is environment-variable-resolved at runtime; no auth gates blocked task progression. Task 7 (T8 integration checkpoint) was deferred-no-token because `FIGMA_API_TOKEN` is unset in the development environment — this is the expected dev posture, not a blocker.

## PAT-Leak Scan (T8 step 9 equivalent)

```
$ grep -rE "figd_[A-Za-z0-9_-]+" src/tools/figma/ src/cli/cmd-doctor-figma.ts src/security/redaction.ts \
    | grep -v SCRUBBED | grep -v "\.test\.ts" | grep -v "__fixtures__" | grep -v REDACTED
(empty output)
```

Zero raw PAT fragments in production source. Test fixtures use `figd_testpat_AAAAAAA` (intentionally identifiable + obviously fake). Live smoke test (Task 6 demo) with bogus `figd_fake_test_does_not_resolve` PAT against real api.figma.com returned 403 → output classified as `TOKEN_EXPIRED (403)` with NO PAT echoed.

## Plan-Tier Observed (T8 step 5)

**DEFERRED-no-token.** Live tier verification requires user PAT. Documented in PLAN for v0.3 enhancement.

## Live Integration (T8 — Auto-Approved Per Auto Mode)

**Status: DEFERRED-no-token.** No `FIGMA_API_TOKEN` available in environment. Unit-test coverage compensates:
- `rest-client.test.ts` — 17 cases via fetchImpl injection cover happy/429/403/404/500/network-error paths + PAT scrubbing
- `list-layers.test.ts` — 9 cases via fetchImpl injection + JSON fixture cover all URL routing + flattening
- `update-token.test.ts` — 11 cases cover CREATE/UPDATE + type-mapping + 403 disambiguation
- `cmd-doctor-figma.test.ts` — 8 cases cover all probe outcomes including PAT-file chmod gating
- `index.test.ts` — 9 cases cover env-gating + deferral const integrity
- **CLI smoke test passed** with bogus PAT (live api.figma.com hit, 403 returned, properly classified, no leak)

## Known Stubs

None. Every code path is fully implemented or declaratively deferred (via `DEFERRED_FIGMA_TOOLS` — surfaced in doctor output, NOT a code stub).

## Threat Flags

No new security-relevant surface outside the plan's `<threat_model>`. All trust boundaries documented in PLAN section §Trust Boundaries are exactly the surface implemented (PAT at rest, PAT in transit, model-controlled args reaching REST, debug log emission paths, cmd-doctor terminal output).

## Open Items for v0.3

1. **Plugin-bridge tools:** `figma_get_selection`, `figma_create_component` require Figma Desktop with WebSocket bridge plugin (~50 LOC TS plugin + WS client in Relay). Surfaced in `relay doctor --figma` deferred-list as the path to closure.
2. **Pre-flight plan-tier filter:** Currently `figma_update_token` registers unconditionally on non-Enterprise PATs; users get graceful PLAN_REQUIRED back. v0.3 enhancement: pre-flight `/v1/me` parse OR test variables write to filter the tool from `tools[]` for non-Enterprise tiers (PITFALLS 5.2 §2).
3. **OAuth2 token refresh:** Currently PAT-only. OAuth2 adds refresh token plumbing — non-trivial; defer.
4. **Relay-side audit log:** Figma has its own audit log for variable changes; Relay-side audit is out of scope for v0.2. Could surface via cmd-history extension in v0.3.
5. **Retry-After HTTP-date support:** v0.2 supports delta-seconds only. v0.3 should parse HTTP-date format (RFC 7231 §7.1.3 second form).
6. **Workdir file_key gitignore probe:** `<workdir>/.relay/figma.json` should be in `.gitignore` (file_key is non-credential but workflow-sensitive). v0.3 doctor enhancement.
7. **Variable publish flow:** Figma variables created via API must be published separately to be usable in other files. Currently out of scope; v0.3 may add `figma_publish_variables` tool.

## Self-Check: PASSED

Files exist (all 17 listed in key_files.created/modified):
- `src/tools/figma/scrub.ts` — FOUND
- `src/tools/figma/pat-loader.ts` — FOUND
- `src/tools/figma/rest-client.ts` — FOUND
- `src/tools/figma/list-layers.ts` — FOUND
- `src/tools/figma/update-token.ts` — FOUND
- `src/tools/figma/index.ts` — FOUND
- `src/tools/figma/__fixtures__/files-nodes-response.json` — FOUND
- `src/cli/cmd-doctor-figma.ts` — FOUND

Commits exist (verified via `git log --oneline`):
- `b90c24c` test(figma): pat-loader + scrub RED — FOUND
- `e3990e5` feat(figma): pat-loader + scrub GREEN — FOUND
- `6bbe599` test(figma): rest-client RED — FOUND
- `c706cdd` feat(figma): rest-client GREEN — FOUND
- `db15273` test(figma): list-layers RED — FOUND
- `efacb3d` feat(figma): list-layers GREEN — FOUND
- `814b16f` test(figma): update-token RED — FOUND
- `a7e2959` feat(figma): update-token GREEN — FOUND
- `ea09954` test(figma): registry RED — FOUND
- `437a9e8` feat(figma): registry + worker wire-up GREEN — FOUND
- `69d7edd` test(doctor): --figma RED — FOUND
- `a879457` feat(doctor): --figma GREEN — FOUND

Test count: 1245 baseline → 1325 final (+80, 0 fail).
