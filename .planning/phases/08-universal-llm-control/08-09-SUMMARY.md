---
phase: 08-universal-llm-control
plan: 09
subsystem: control
tags: [command-central, tui, diagnostics, read-model, broker, docs, uat, verify, doctor, control-snapshot]

# Dependency graph
requires:
  - phase: 08-05-PLAN
    provides: control-layer docs reframe (README/commands/architecture/providers/configuration), runControlCheck (verify) + checkControlLayer (doctor), control-e2e docs-contract tests
  - phase: 08-08-PLAN
    provides: Option A Command Central layout (split rail + live stream), gatherControlSnapshot read model, relay_control_request_grant tool, actor_kind event stamping
provides:
  - relay verify command-central check — builds the bounded ControlSnapshot, asserts every pane honors its limit, reports pending grant-request queue depth
  - relay doctor command-central probe — same read-model health as probe #15 (snapshot bounded-ms + pending grant depth + session count)
  - Command Central operator docs — commands.md relay tui section (palette actions + UAT), architecture.md section 12.1, README relay tui row + shipped framing
  - terminal-native (no browser/web UI) guarantee asserted across README/commands/architecture by docs-contract tests
  - CHANGELOG Unreleased — Command Central + model-driven control entries appended to the Phase 8 block
affects: [phase-close, future-control-phases, command-central]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Read-only diagnostic check over the shared read model: build gatherControlSnapshot, assert pane bounds, report pending grant-request depth (no writes, no rollback)"
    - "Markdown docs-contract by section-slice: extract a doc's section by heading needle and assert palette/UAT/no-browser invariants inside it"
    - "Extend (not replace) the 08-05 control diagnostics — runControlCheck/checkControlLayer untouched; command-central added alongside"

key-files:
  created: []
  modified:
    - src/cli/cmd-verify.ts
    - src/cli/cmd-doctor.ts
    - src/cli/cmd-verify.test.ts
    - src/cli/cmd-doctor.test.ts
    - docs/commands.md
    - docs/architecture.md
    - README.md
    - CHANGELOG.md

key-decisions:
  - "Pending grant-request queue depth = gatherControlSnapshot().pending_actions.length; snapshot health = returns within declared pane bounds (DEFAULT_CONTROL_SNAPSHOT_LIMITS). Both reuse the read model the TUI consumes — no new SQL path (D-12)."
  - "command-central is an additive 7th verify check / 15th doctor probe; the 08-05 control checks (runControlCheck broker smoke, checkControlLayer table counts) are left intact (extend, not replace)."
  - "Doc-contract tests live in cmd-verify.test.ts (the only test file in scope alongside cmd-doctor.test.ts) — 08-05's control-e2e.test.ts is out of this plan's file scope, so its existing README/session-subcommand contract was NOT duplicated."
  - "Command Central documented as terminal-native Ink only; the words browser/web-dashboard are kept away from the term and an asserted doesNotMatch guard pins it (D-11, CONTEXT non-goal)."

patterns-established:
  - "Diagnostic-over-read-model: a verify/doctor check that proves the operator console's data source builds and is bounded, surfacing a stalled UI or model-request backlog without opening the TUI"
  - "Section-scoped markdown contract tests: slice by heading, assert invariants inside the slice (palette coverage, UAT lifecycle, terminal-native)"

requirements-completed: [CONTROL-11, CONTROL-12, CONTROL-13, CONTROL-14, CONTROL-15, CONTROL-16, CONTROL-17]

# Metrics
duration: ~20min
completed: 2026-06-08
---

# Phase 8 Plan 09: Command Central diagnostics, docs, and UAT Summary

**`relay verify` + `relay doctor` now prove the Command Central read model builds bounded and report the pending grant-request queue depth; docs (commands/architecture/README/CHANGELOG) describe Command Central as the terminal-native operator console over the broker, with a human-driven and model-requested UAT and no browser-UI claim — closing Phase 8.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-06-08T16:25:00+02:00 (approx, incl. context load of 08-05/08-08 + read-model/broker/palette)
- **Completed:** 2026-06-08T16:45:00+02:00 (after full suite + four CLI smokes)
- **Tasks:** 1 (TDD, run as two RED→GREEN cycles: diagnostics, then docs)
- **Files modified:** 8 (0 created, 8 modified)

## Accomplishments
- **Diagnostics (verify + doctor):** added a `command-central` check to `relay verify` (7th check) and a `command-central` probe to `relay doctor` (15th check). Both build the bounded `ControlSnapshot` the TUI consumes, assert every pane stayed within its declared limit (no unbounded SELECT slipped in, D-12), and report the pending grant-request queue depth (D-14 model-driven requests awaiting a human). Read-only — no writes, nothing to roll back. They extend the 08-05 control checks rather than replacing them.
- **Command Central docs (commands.md):** a new `## relay tui` section names it the terminal-native Ink operator console, documents the layout, every `:` palette action (send, delegate, inspect, tail, grant, revoke, pause, resume, approve, deny), the `relay session spawn` entry for owned-process sessions, and a "Verifying Command Central" UAT covering both human-driven control and model-requested control (request → approve/deny → deliver, self-approval blocked at the broker). Added a `## relay verify` section (previously undocumented) and extended `relay doctor` with the control + Command Central checks.
- **Architecture (section 12.1):** frames Command Central as the operator console over the same broker — shared `ControlSnapshot` (D-12), human palette actions and model tool calls on one broker/policy/audit path (D-13), broker-mediated visible model requests with no self-escalation (D-14), keyboard-first operator surface (D-15), plus the snapshot/pending-grant probe.
- **README:** the `relay tui` row now presents Command Central (not the old passive dashboard); the stale "Next: Command Central" paragraph is replaced by a "shipped" description with the model-request-then-human-approve boundary stated; "Next" now points at full-TTY PTY + cost rollups.
- **CHANGELOG:** Command Central, model-driven-control, and Command Central diagnostics bullets appended to the single Phase 8 Unreleased block; the stale "v0.3.0 TUI" planned line updated.

## Task Commits

The single TDD task ran as two RED→GREEN cycles:

1. **Cycle A — diagnostics** — `ec3d647` (test, RED: command-central absent from verify/doctor, unwired throw-stubs) → `b4e2ed1` (feat, GREEN: runCommandCentralCheck + checkCommandCentral implemented and wired; passingDeps + pass-counts updated)
2. **Cycle B — docs** — `6e17c90` (test, RED: Command Central docs-contract fails) → `b38a659` (docs, GREEN: commands/architecture/README/CHANGELOG written)

**Plan metadata:** committed separately with this SUMMARY.

## Files Created/Modified
- `src/cli/cmd-verify.ts` - `runCommandCentralCheck` (bounded-snapshot + pending-grant verify check); added to `VerifyDeps`; wired as the 7th check.
- `src/cli/cmd-doctor.ts` - `checkCommandCentral` (same read-model health probe); wired as check #15 after `checkControlLayer`.
- `src/cli/cmd-verify.test.ts` - integration + unit tests for the verify check; `passingDeps` stub + two pass-count assertions bumped for the 7th check; the Command Central docs-contract describe block.
- `src/cli/cmd-doctor.test.ts` - integration + unit tests for the doctor probe.
- `docs/commands.md` - `## relay tui` Command Central section (palette + UAT), `## relay verify` section, extended `relay doctor` description.
- `docs/architecture.md` - section 12.1 "Command Central — the terminal operator console".
- `README.md` - `relay tui` row reworked; Command Central moved from "Next" to shipped.
- `CHANGELOG.md` - Command Central + model-driven control entries appended to the Phase 8 Unreleased block.

## Decisions Made
- **Reuse the read model, add no SQL.** Both new checks call `gatherControlSnapshot()` and compare against `DEFAULT_CONTROL_SNAPSHOT_LIMITS`. The pending-grant depth is `pending_actions.length`. This keeps D-12 intact (UI/diagnostics share one bounded read path).
- **Additive, not a rewrite.** `command-central` sits alongside the 08-05 `control` check/probe. The 08-05 `control-e2e.test.ts` (which asserts `checkControlLayer` and the README/session-subcommand docs contract) is out of this plan's file scope and was deliberately left untouched and still passes.
- **Palette documented from the source of truth.** The 10 palette verbs come from `cmd-session.ts` `PALETTE_USAGE`; `spawn` is documented as the CLI command that creates owned-process sessions, not as a palette verb — no overclaim.
- **Terminal-native, asserted.** A `doesNotMatch` guard across README/commands/architecture pins that no doc frames Command Central as a browser/web UI, matching the Phase 8 non-goal.

## Deviations from Plan

### Method / placement notes (no Rule 1-4 auto-fixes)

**1. [Rule 3 - Blocking] Doc-contract tests placed in cmd-verify.test.ts**
- **Found during:** Cycle B
- **Issue:** The plan's only in-scope test files are `cmd-verify.test.ts` and `cmd-doctor.test.ts`. The Command Central docs-contract needs a home, and 08-05's `control-e2e.test.ts` (where the prior docs contract lives) is outside this plan's file scope.
- **Fix:** Added a `describe('Command Central docs contract (08-09)')` block to `cmd-verify.test.ts` with its own section-slice helper. It asserts only the NEW operator coverage (palette, UAT, terminal-native, snapshot/pending-grant), not 08-05's already-pinned README/session-subcommand contract.
- **Files modified:** src/cli/cmd-verify.test.ts
- **Verification:** RED `6e17c90` (6 contract tests fail) → GREEN `b38a659` (all pass)
- **Committed in:** 6e17c90 / b38a659

**2. [Rule 2 - Missing critical] Added a `## relay verify` section to commands.md**
- **Found during:** Cycle B
- **Issue:** `relay verify` had no section in commands.md, yet the plan requires documenting the verify/doctor snapshot-health + pending-grant checks.
- **Fix:** Added a concise `## relay verify` section describing the full smoke including the new `command-central` check; extended the `relay doctor` description with the control + Command Central checks.
- **Files modified:** docs/commands.md
- **Committed in:** b38a659

**3. [Rule 1 - Coherence] Updated the stale "Beyond v0.2 (planned)" TUI line + README "Next"**
- **Found during:** Cycle B
- **Issue:** README framed Command Central as "Next" and CHANGELOG listed "v0.3.0 TUI visual layer" as planned — both stale now that 08-08 shipped Command Central.
- **Fix:** README "Next" rewritten to shipped + a genuine next (full-TTY PTY, cost rollups); CHANGELOG planned line updated to match. No removal of shipped facts.
- **Files modified:** README.md, CHANGELOG.md
- **Committed in:** b38a659

---

**Total deviations:** 3 (1 test-placement, 1 docs-completeness add, 1 doc-coherence fix). **Impact:** No scope creep beyond the plan's file list; no behavior changes outside the two additive read-only checks. The 08-05 and 08-08 work was built on, not duplicated or rewritten.

## TDD Gate Compliance
The plan is `type: tdd`. Each cycle shows a `test(08-09)` commit immediately before its implementation commit, with verified RED → GREEN:
- Cycle A: `ec3d647` test (6 leaf failures, all command-central; 63 others green) → `b4e2ed1` feat (69/69 green).
- Cycle B: `6e17c90` test (6 docs-contract leaf failures; 16 others green) → `b38a659` docs (75/75 green).
RED stubs compiled (unwired throw-stubs) so the shared build never broke.

## Issues Encountered
- `requestGrant` is a `.strict()` Zod schema requiring `ttl_ms` + `max_messages`; the first draft of the pending-depth unit tests omitted them. Fixed before the RED commit so RED failed for the intended reason (check absent), not a malformed test input.

## Known Stubs
None. The RED throw-stubs (`runCommandCentralCheck`, `checkCommandCentral`) were both replaced by real implementations in their GREEN commits; no `not implemented` / TODO / placeholder strings remain in the source.

## Threat Flags
None. The two new checks are read-only over the existing control read model (no new endpoints, auth paths, file access, or schema changes). Docs-only changes otherwise.

## Verification
- **Full suite (phase-closing gate, under build lock):** `npm run build && node --test --test-concurrency=1 $(find dist -type f -name "*.test.js")` → **1775 pass, 0 fail, 0 skipped** (349 suites, ~17s). Baseline 1763 + 12 new tests (6 diagnostics + 6 docs-contract) = 1775.
- **Smokes (all exit 0):**
  - `node dist/cli.js session list --json` → `[]`
  - `node dist/cli.js tui --json` → control snapshot keys all present (`sessions … pending_actions … providers`)
  - `node dist/cli.js verify --json` → `ok: true`, 7/7 checks pass incl. `command-central`
  - `node dist/cli.js doctor --json` → `failed: 0`; `control` ok + `command-central` ok (`snapshot bounded, 0 pending grant request(s)`)

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 8 closes: 9/9 plans complete. Command Central is documented, diagnosed, and UAT-covered; CONTROL-11..17 addressed (11/12/13/17 by this plan's docs + diagnostics + UAT; 14/15/16 implemented in 08-08 and now documented/verified here).
- Per the parallel-execution / orchestrator protocol, `STATE.md`, `ROADMAP.md`, and `REQUIREMENTS.md` were intentionally NOT touched — the orchestrator reconciles them after this plan.
- Carry-forward (not blockers): `cmd-session.ts` (~1040 lines) and `broker.ts` (~985 lines) exceed the 800-line cap — flagged for a future refactor plan. Full-TTY live control (opt-in PTY) and per-session cost rollups remain the documented "Next".

## Self-Check: PASSED

- Files verified on disk: `src/cli/cmd-verify.ts`, `src/cli/cmd-doctor.ts`, `src/cli/cmd-verify.test.ts`, `src/cli/cmd-doctor.test.ts`, `docs/commands.md`, `docs/architecture.md`, `README.md`, `CHANGELOG.md`, and this SUMMARY.
- Commits verified in git history: `ec3d647`, `b4e2ed1`, `6e17c90`, `b38a659`.
- Full suite: 1775 pass / 0 fail. Four CLI smokes: all exit 0, `command-central` present and healthy in both verify and doctor.

---
*Phase: 08-universal-llm-control*
*Completed: 2026-06-08*
