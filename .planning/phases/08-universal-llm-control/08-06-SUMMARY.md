---
phase: 08-universal-llm-control
plan: 06
subsystem: control
tags: [read-model, ink, react, tui, command-central, bounded-reads]

# Dependency graph
requires:
  - phase: 08-01
    provides: ControlSessionStore (sessions/events/mailbox/grants), Zod boundary contracts, v4 tables
  - phase: 08-02
    provides: ControlBroker audit-event conventions (message_blocked source-anchoring, D-14 lifecycle event types)
provides:
  - ControlSnapshot read model (gatherControlSnapshot / emptyControlSnapshot) shared by `relay tui` and `relay tui --json` (D-12, CONTROL-11)
  - Bounded store reads: listSessions limit, listRecentEvents, listQueuedMessages, listGrants, countSessionsByProviderState
  - `relay tui --json` Command Central state contract (control key + preserved legacy health fields)
  - Herdr-inspired terminal Command Central layout with pure buildCommandCentralView view model (D-11, D-15, CONTROL-12, CONTROL-17)
affects: [08-07 docs, any consumer of relay tui --json]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Read model reads ONLY through store helpers with explicit clamped limits — no UI-owned SQL, no unbounded SELECTs (D-12)"
    - "Provider rollups via bounded GROUP BY aggregate (countSessionsByProviderState) so counts stay correct when the roster read is truncated"
    - "Pure view-model builder (buildCommandCentralView): Ink components only map strings to Text, so render shape is testable without TTY/network"
    - "RED commits ship compiling throw-stubs so parallel agents sharing dist/ never see a broken tsc build"

key-files:
  created:
    - src/control/read-model.ts
    - src/control/read-model.test.ts
  modified:
    - src/control/session-store.ts
    - src/cli/cmd-tui.ts
    - src/cli/cmd-tui.test.ts

key-decisions:
  - "ControlSnapshot nests under a `control` key in the tui Snapshot — flattening would collide generated_at and providers with the legacy health fields"
  - "Inbox is the GLOBAL queued backlog (oldest first); per-session queue counts derive from it for rail rollups"
  - "Pending actions = control_requested events with no control_approved/denied/executed naming the same payload.request_id inside a bounded scan window; requested events without request_id stay visible until they age out"
  - "listGrants(active_at) filters revoked/expired only — budget-exhausted grants stay visible so operators can revoke or re-issue"
  - "Event tail uses listRecentEvents DESC + reverse, not tailEvents(after_id=0), which would return the OLDEST N for long-lived sessions"
  - "Selected session resolves outside the bounded roster via direct getSession so selection never vanishes when newer sessions push it past the limit"

patterns-established:
  - "View model display caps (PANE_ROWS) on top of snapshot limits keep panes scannable: events 12, inbox 6, grants 4, pending 4, audit 4"
  - "State badges ACT/IDL/END + compact capability codes (reg obs tail inj mbx res stdin int fork spawn tool) instead of verbose text (D-15)"
  - "NARROW_WIDTH=110 flips the three-pane row to a stacked column layout"

requirements-completed: [CONTROL-11, CONTROL-12, CONTROL-17]

# Metrics
duration: 18min
completed: 2026-06-07
---

# Phase 8 Plan 06: Command Central Read Model and Terminal Layout Summary

Broker-backed immutable ControlSnapshot read model shared by `relay tui` and `relay tui --json`, plus a Herdr-inspired Ink Command Central (session rail, selected-session pane, inbox/grants queue, audit/status strip) rendered from a pure, TTY-free-testable view model.

## Performance

- Duration: ~18 min (21:01–21:20 UTC)
- Tasks: 3/3 (all TDD)
- Scoped tests: 71 pass / 0 fail (18 read-model + 18 cmd-tui + 35 session-store regression)

## Accomplishments

- `gatherControlSnapshot`: session roster (last_seen DESC), selected session, chronological newest-N event tail, global queued inbox, active grants, D-14 pending actions, blocked events, audit items, provider rollups — every read bounded, every collection frozen.
- Five bounded reads added to ControlSessionStore in its existing style (clamped limits [1,1000], enum-validated rows, parameterized SQL).
- `relay tui --json` now emits the Command Central state contract: `control` key with all panes, single line, no refresh loop; legacy top-level health fields (`version`, `recent_activity`, `recall_preview`, `status.*`) byte-compatible for scripts — all pre-existing tests untouched and passing.
- Interactive `relay tui` opens directly into Command Central: left rail with ACT/IDL/END badges, blocked `!` flags and queue rollups; main pane with capability badges and event tail; right inbox/grants/pending queue; bottom audit/status/budget strip; `j/k`/arrows re-select sessions, `r` refresh, `q` quit; 5s bounded auto-refresh kept; narrow terminals stack panes.

## Task Commits

| Task | RED | GREEN |
| ---- | --- | ----- |
| 1. ControlSnapshot read model + bounded store reads | 0492fba | 4b98f99 |
| 2. relay tui --json Command Central contract | 15986db | 133ce33 |
| 3. Herdr-inspired Command Central Ink layout | b18d0e9 | 60d2469 |

## Files Created/Modified

- `src/control/read-model.ts` (new) — ControlSnapshot/ProviderStatusSummary/limits types, gatherControlSnapshot, emptyControlSnapshot.
- `src/control/read-model.test.ts` (new) — 18 tests: ordering, bounds, selection, pending resolution, rollups, immutability.
- `src/control/session-store.ts` — added listSessions limit, countSessionsByProviderState, listRecentEvents, listQueuedMessages, listGrants, clampLimit. No existing method changed; 08-01 suite passes unmodified.
- `src/cli/cmd-tui.ts` — Snapshot gains `control`; gatherSnapshot routes through gatherControlSnapshot with emptyControlSnapshot fallback; three-panel dashboard replaced by Command Central; pure buildCommandCentralView + formatters exported for tests. 656 lines (cap ~800).
- `src/cli/cmd-tui.test.ts` — 13 new tests (3 control snapshot, 1 --json contract, 6 render shape via frozen fixtures, plus legacy-preservation assertions); 5 pre-existing tests untouched.

## Decisions Made

See frontmatter key-decisions. Notable: `control_approved` resolves the PENDING state (operator already acted; execution tracking is the lifecycle's job, not the attention queue's).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] RED commits include compiling throw-stubs**
- **Found during:** Task 1 RED (applies to all three tasks)
- **Issue:** A test-only RED commit referencing not-yet-existing exports breaks `tsc` for the whole src tree — and two parallel agents share this worktree's build. A non-compiling committed state would block their verification runs.
- **Fix:** Each RED commit ships the contract types plus functions throwing `not implemented (RED)`, so the build compiles and all new tests fail for the right reason (verified: 18/18, 4/4, 6/6 failures on the stub throw before each GREEN).
- **Files modified:** src/control/read-model.ts, src/cli/cmd-tui.ts
- **Commits:** 0492fba, 15986db, b18d0e9

No other deviations — plan executed as written. Store additions were explicitly sanctioned by Task 1 ("ADD it to session-store.ts").

## TDD Gate Compliance

All three tasks: test() commit → verified failing for the right reason → feat() commit → verified passing. No REFACTOR commits needed. Gate sequence present in git log (see Task Commits table).

## Verification Evidence

- Final: `npm run build && node --test dist/control/read-model.test.js dist/cli/cmd-tui.test.js dist/control/session-store.test.js` → 71 pass, 0 fail, exit 0.
- Smoke: `RELAY_DB_PATH=':memory:' node dist/cli.js tui --json` → top keys `version,generated_at,recent_activity,recall_preview,control,status`; control keys `generated_at,sessions,selected_session,events,inbox,grants,pending_actions,blocked,audit,providers`.
- Success criteria: (1) shared read model, zero UI-owned SQL — all SQL in session-store.ts; (2) --json exposes the contract; (3) terminal-native operator console shape pinned by 6 render-shape tests.

## Known Stubs

None. Empty-state strings ("no sessions registered…", "(no id)") are intentional renderings of genuinely empty data, not placeholders for unwired sources.

## Threat Flags

None — no new network endpoints, auth paths, file access patterns, or schema changes. All new SQL is parameterized bounded reads over existing v4 tables.

## Issues Encountered

- Build lock contention with parallel agents (plans 08-03/08-04 committing interleaved) — handled by the mkdir-lock protocol; no lock waits exceeded a few cycles, no foreign compile errors surfaced during my builds.

## User Setup Required

None.

## Next Phase Readiness

- `relay tui --json | jq .control` is now the scriptable Command Central surface for docs (08-07) and external tooling.
- buildCommandCentralView accepts any ControlSnapshot — future panes (e.g., delivery attempts) extend the read model first, view second.
- Pending-action resolution matches on `payload.request_id`; whichever plan emits the D-14 lifecycle events must include that key for requests to clear from the pending pane.

## Self-Check: PASSED

All 5 plan files and the SUMMARY exist on disk; all 6 task commits (0492fba, 4b98f99, 15986db, 133ce33, b18d0e9, 60d2469) present in git log.
