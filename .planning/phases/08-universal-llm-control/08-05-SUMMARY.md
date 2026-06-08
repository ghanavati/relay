---
phase: 08-universal-llm-control
plan: 05
subsystem: infra
tags: [control, child_process, pty, cli, diagnostics, capabilities, broker]

# Dependency graph
requires:
  - phase: 08-03-PLAN
    provides: ControlBroker, executeSessionCommand (list/inspect/tail/send/grant/revoke/delegate), LLM control tools (registerControlTools)
  - phase: 08-04-PLAN
    provides: claude-code/codex/generic-http adapters with truthful capability sets
provides:
  - Relay-owned process sessions via child_process pipes (ProcessSession + relay session spawn)
  - live_stdin + interrupt strong control for non-full-TTY owned processes; full-TTY providers withhold live_stdin
  - mailbox -> live-stdin bridge (peer relay session send reaches a running owned process)
  - end-to-end control verification (fake A->B, LM Studio tool send, Claude queued context, blocked send, blocked loop)
  - control diagnostics in relay verify / doctor / info (session/queued/blocked health + truthful adapter capability catalog)
  - control-layer docs across README/commands/architecture/providers/configuration + CHANGELOG
affects: [08-08, command-central, future-control-phases]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Relay-owned process control via node child_process pipes only (no node-pty dependency in v1)"
    - "Output recorded as session_updated control events with typed payload (closed event taxonomy honored)"
    - "Non-persistent diagnostic smoke via rolled-back transaction (zero residue in production tables)"
    - "Truthful per-provider capability catalog mirrored from adapters (no live_stdin overclaim)"

key-files:
  created:
    - src/control/pty-session.ts
    - src/control/pty-session.test.ts
    - src/control/control-e2e.test.ts
  modified:
    - src/cli/cmd-session.ts
    - src/cli/cmd-verify.ts
    - src/cli/cmd-doctor.ts
    - src/cli/cmd-info.ts
    - src/cli/cmd-verify.test.ts
    - README.md
    - docs/commands.md
    - docs/architecture.md
    - docs/providers.md
    - docs/configuration.md
    - CHANGELOG.md

key-decisions:
  - "live_stdin = line-based child_process pipe I/O only; full-TTY CLIs (claude, codex) report live_stdin absent (v1 scope, no node-pty)"
  - "relay session spawn wired through the EXISTING cli.ts dispatchSession (--provider + positionals); no cli.ts edit needed"
  - "verify control smoke runs inside a rolled-back transaction so a healthy run leaves no control-table residue"
  - "process output recorded as session_updated events (closed CONTROL_EVENT_TYPES has no output type; typed payload is the honest fit)"

patterns-established:
  - "ProcessSession: spawn/sendLine/interrupt/waitForExit/waitForLine over child_process pipes, store-backed events"
  - "drainMailboxToProcess: audited mailbox -> live_stdin delivery (delivery attempt + message_delivered)"
  - "Diagnostics capability catalog (CONTROL_ADAPTER_CATALOG) as truthful runtime echo of adapter declarations"

requirements-completed: [CONTROL-01, CONTROL-02, CONTROL-03, CONTROL-10]

# Metrics
duration: ~45min
completed: 2026-06-08
---

# Phase 8 Plan 05: Relay-owned process sessions, E2E verification, and control diagnostics Summary

**Relay-owned CLI process sessions with live stdin + SIGINT interrupt over child_process pipes, end-to-end control verification across fake/LM Studio/Claude/blocked paths, and truthful control diagnostics in verify/doctor/info.**

## Performance

- **Duration:** ~45 min
- **Started:** 2026-06-08T15:35:00Z (approx, includes context load + design)
- **Completed:** 2026-06-08T16:19:20Z
- **Tasks:** 3 (all TDD: RED + GREEN)
- **Files modified:** 14 (3 created, 11 modified)

## Accomplishments
- `ProcessSession` + `relay session spawn`: Relay launches and owns a child through `child_process` pipes, tails its stdout/stderr as control events, writes to its stdin (`live_stdin`), interrupts it (SIGINT), and records stopped-state on exit. Full-TTY providers (claude, codex) truthfully withhold `live_stdin`; line-based processes get strong control.
- Mailbox → live-stdin bridge: a peer `relay session send <id>` is delivered onto a running owned process's stdin, audited like any other delivery.
- End-to-end control verification (`control-e2e.test.ts`): fake A→B reply, LM Studio control-tool send to a fake target (with grant), Claude queued-context rendering, unauthorized agent send blocked (`CONTROL_GRANT_REQUIRED`), and identical ping-pong blocked (`CONTROL_LOOP_DETECTED`) — all against current HEAD behavior.
- Control diagnostics: `relay verify` runs a rolled-back control smoke (broker send → delivered, zero residue), `relay doctor` reports session/active/queued/blocked counts, and `relay info` adds a control rollup plus a truthful per-provider adapter capability catalog (no adapter claims `live_stdin`).
- Control-layer docs reframed and extended: README (delegation/dispatch + live control, guardrails not headlined), commands.md (every session subcommand incl. spawn), providers.md (Relay-owned strong mode), architecture.md (control fabric section), configuration.md (control persistence + policy), CHANGELOG (Unreleased).

## Task Commits

Each task was TDD (RED → GREEN):

1. **Task 1: Relay-owned CLI session wrapper** — `0e2f084` (test, RED) → `77a859e` (feat, GREEN)
2. **Task 2: E2E verification and diagnostics** — `637b7a0` (test, RED) → `7ced339` (feat, GREEN)
3. **Task 3: Control-layer docs and changelog** — `f7c0095` (test, RED) → `f9aad26` (docs, GREEN)

_Scoped test result: 138 tests pass, 0 fail across pty-session, cmd-session, control-e2e, cmd-verify, cmd-doctor, cmd-info._

## Files Created/Modified
- `src/control/pty-session.ts` - ProcessSession (pipe-owned child), relayProcessCapabilities, drainMailboxToProcess, runSpawnSession driver
- `src/control/pty-session.test.ts` - ProcessSession spawn/stdin/stderr/SIGINT/stopped-state, bridge, capability policy, spawn dispatch
- `src/control/control-e2e.test.ts` - 5 E2E scenarios + 7 diagnostics-contract tests + 3 docs-contract tests
- `src/cli/cmd-session.ts` - thin `spawn` dispatch (delegates process logic to pty-session.ts)
- `src/cli/cmd-verify.ts` - runControlCheck (rolled-back control smoke) wired as 6th check
- `src/cli/cmd-doctor.ts` - checkControlLayer probe wired in
- `src/cli/cmd-info.ts` - ControlInfo rollup + CONTROL_ADAPTER_CATALOG + report wiring + render
- `src/cli/cmd-verify.test.ts` - updated pass-count assertions for the added 6th check
- `README.md`, `docs/commands.md`, `docs/architecture.md`, `docs/providers.md`, `docs/configuration.md`, `CHANGELOG.md` - control-layer documentation

## Decisions Made
- **live_stdin scope (v1):** line-based subprocess I/O through pipes only. Full-TTY interactive CLIs detect non-TTY stdio and change behavior, so claude-code/codex report `live_stdin` absent. No `node-pty` dependency added (would need explicit human approval; out of scope).
- **spawn wiring:** routed through the existing `cli.ts dispatchSession` — provider forwarded via `--provider`, command from trailing positionals. Working CLI form: `relay session spawn --provider <name> <command...>` (smoke-verified, exit-code propagation correct). For a child command that has its own flags, wrap it in a shell (`sh -c '...'`).
- **verify smoke non-persistence:** the control smoke registers a session, brokers a send, and confirms the delivered transition inside a transaction that is then rolled back via a sentinel throw — a healthy `relay verify` leaves zero control-table residue (the memory smoke, by contrast, persists a tagged entry).
- **output events:** the closed `CONTROL_EVENT_TYPES` set has no dedicated output type, so process output/input is recorded as `session_updated` with a typed payload (`kind: process_output | process_input`). Stopped-state is `session_ended` + state `ended` + exit metadata.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] spawn tests placed in pty-session.test.ts, not cmd-session.test.ts**
- **Found during:** Task 1
- **Issue:** Task 1's `<files>` lists `cmd-session.ts` but not `cmd-session.test.ts`, while the Task 1 verify runs `dist/cli/cmd-session.test.js`. cmd-session.test.ts is owned by neither this plan nor the parallel 08-08 plan.
- **Fix:** Placed the `relay session spawn` dispatch tests in `pty-session.test.ts` (in this plan's file list). cmd-session.test.ts is left unmodified and still passes — the Task 1 verify is satisfied.
- **Files modified:** src/control/pty-session.test.ts
- **Verification:** `node --test dist/control/pty-session.test.js dist/cli/cmd-session.test.js` both green
- **Committed in:** 0e2f084 / 77a859e

**2. [Rule 1 - Bug] cmd-verify.test.ts pass-count assertions updated for the added 6th check**
- **Found during:** Task 2 (GREEN)
- **Issue:** Adding the `control` check to `executeVerifyCommand` shifted two exact pass-count assertions in cmd-verify.test.ts (a file not in this plan's list, owned by neither plan). Without the update the orchestrator's scoped verify would fail.
- **Fix:** Added a passing `runControlCheck` stub to the test's `passingDeps()` and bumped `pass` counts (4→5, 3→4). No collision with 08-08 (which does not touch cmd-verify.test.ts).
- **Files modified:** src/cli/cmd-verify.test.ts
- **Verification:** `node --test dist/cli/cmd-verify.test.js` green (all 13 verify tests pass)
- **Committed in:** 7ced339

**3. [Rule 3 - Blocking] docs-contract tests placed in control-e2e.test.ts**
- **Found during:** Task 3
- **Issue:** Task 3 lists no test file, but its verify is `npm test` and requires doc-check tests. "Do not create files beyond your plan list" forbids a new docs.test.ts.
- **Fix:** Added the docs-contract `describe` block to `control-e2e.test.ts` (this plan's file) — README/commands/providers contract checks.
- **Files modified:** src/control/control-e2e.test.ts
- **Verification:** doc-contract tests RED before docs, GREEN after
- **Committed in:** f7c0095 / f9aad26

**4. [Rule 1 - Bug] runSpawn mirrorOutput in JSON mode**
- **Found during:** Task 1 (GREEN)
- **Issue:** The spawn driver mirrored child stdout to the CliIO unconditionally, polluting `--json` output (JSON parse failed on the leading child line).
- **Fix:** `runSpawn` passes `mirrorOutput: !options.json`; JSON mode keeps stdout clean (machine-readable result only), human mode mirrors live output.
- **Files modified:** src/cli/cmd-session.ts
- **Verification:** `relay session spawn --json ...` emits clean parseable JSON (smoke-verified)
- **Committed in:** 77a859e

---

**Total deviations:** 4 (2 test-placement/ownership, 1 test-count update, 1 bug fix). **Impact:** No scope creep. `cli.ts` was deliberately NOT modified — spawn works through the existing dispatch; the `--adapter <name> -- <command...>` exact spelling from the plan prose would need a small `cli.ts` glue (forward `--adapter`, split on `--`), intentionally deferred because cli.ts is outside this plan's file scope and the parallel-execution protocol forbids touching files outside scope. The `executeSessionCommand` surface already accepts `adapter`/`command` fields so that glue is a one-line forward later.

## Issues Encountered
- Initial spawn-dispatch test failed because child output leaked into the JSON result; fixed with the `mirrorOutput` flag (deviation 4).
- The parallel 08-08 agent committed interleaved on the same branch (Command Central work in tools.ts/broker.ts/read-model.ts/cmd-tui.ts); no file overlap, no build collisions under the shared build lock.

## Full-TTY live_stdin note
Full-TTY `live_stdin` did NOT surface as a real limitation in testing — tests use line-based node child processes, which work correctly through pipes (send, echo, interrupt, stopped-state all deterministic). The full-TTY caveat (claude/codex detecting non-TTY stdio and changing behavior) is a documented v1 design boundary enforced by `relayProcessCapabilities` (claude-code/codex withhold `live_stdin`), unit-tested at the capability-policy level, not an empirically observed failure. Adding real full-TTY live control would require `node-pty`, which is explicitly out of scope until human-approved.

## Next Phase Readiness
- Control layer is complete and smoke-verified through the real CLI (`relay session spawn`, `relay verify/doctor/info` control checks).
- 08-08 (Command Central) consumes the same broker/read-model and is additive; my E2E tests assert on allowed/blocked/delivered behavior, not internal event shapes 08-08 may extend.
- Remaining optional sugar: `cli.ts` glue for the `--adapter <name> -- <command...>` spelling (executeSessionCommand already supports it).

## Self-Check: PASSED

- Created files verified on disk: `src/control/pty-session.ts`, `src/control/pty-session.test.ts`, `src/control/control-e2e.test.ts`, `08-05-SUMMARY.md`.
- All six task commits verified in git history: `0e2f084`, `77a859e`, `637b7a0`, `7ced339`, `f7c0095`, `f9aad26`.
- Scoped suite: 138 tests pass, 0 fail. Real-CLI smoke: `relay session spawn` (human + JSON, exit-code propagation), `relay verify/doctor/info` control checks present and truthful.

---
*Phase: 08-universal-llm-control*
*Completed: 2026-06-08*
