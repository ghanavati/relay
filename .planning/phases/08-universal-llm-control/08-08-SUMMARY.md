---
phase: 08-universal-llm-control
plan: 08
subsystem: control
tags: [command-central, ink, tui, read-model, broker, llm-tools, audit, zod, better-sqlite3]

# Dependency graph
requires:
  - phase: 08-07-PLAN
    provides: broker requestGrant/approveGrantRequest/denyControlRequest, command palette, pending_actions in the read model
  - phase: 08-06-PLAN
    provides: gatherControlSnapshot read model + buildCommandCentralView + Ink Command Central
  - phase: 08-03-PLAN
    provides: five LLM control tools, broker.sendMessage, run-scoped control sessions
provides:
  - Model-driven operations are first-class, badge-able audit/event entries (source + disposition)
  - relay_control_request_grant tool — models open visible, human-approved, non-self grant requests
  - actor_kind stamped on control_requested / message_delivered / message_acknowledged events
  - read-model classifyEventSource / classifyEventDisposition (pure, reusable)
  - Bounded, cancellable, dual-cadence Command Central refresh (provider-probe timeout, stale-drop)
  - Option A Command Central layout (split rail + Queue + live right-pane stream, single status strip)
  - command-central-view.ts — extracted pure view layer
affects: [command-central, control-tui, docs/commands, future control phases]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pure view layer (command-central-view.ts) extracted from the Ink orchestration layer; render shape is unit-tested without a TTY"
    - "Additive-only audit schema: new optional payload fields (actor_kind) never rename/remove existing event types/fields"
    - "Dual refresh cadence: cheap synchronous control snapshot (fast) vs network provider probes (slow), each stale-guarded"
    - "withTimeout degrade-not-block wrapper for any UI-path network call"

key-files:
  created:
    - src/cli/command-central-view.ts
  modified:
    - src/control/tools.ts
    - src/control/broker.ts
    - src/control/read-model.ts
    - src/cli/cmd-tui.ts
    - src/control/tools.test.ts
    - src/control/read-model.test.ts
    - src/cli/cmd-tui.test.ts

key-decisions:
  - "Added relay_control_request_grant as the 6th LLM tool: a model can request authority FOR ITSELF only (caller-bound source), default-deny, self-request blocked, no auto-approval (D-14)"
  - "Source/disposition are derived by pure read-model classifiers from event payloads — the ControlEvent schema is untouched (additive actor_kind payload field only)"
  - "Right-pane live stream stays chronological (newest at the bottom, like a transcript) per the maintainer mock; freshness comes from a 1s control cadence, not from reordering"
  - "Maintainer-directed Option A re-layout replaces the 3-column + audit-box shape; audit/blocked fold into the per-session stream"

patterns-established:
  - "Pure view-builder extraction keeps cmd-tui.ts under the line cap and render shape TTY-free testable"
  - "Model-op visibility via additive actor_kind + pure event classifiers"

requirements-completed: [CONTROL-14, CONTROL-15, CONTROL-16]

# Metrics
duration: 19min
completed: 2026-06-08
---

# Phase 8 Plan 08: Model-Driven Command Central Visibility + Option A Re-layout Summary

**Model operations (send, grant-request, inbox read/ack) are now first-class, source-badged audit events rendered in a live event stream; Command Central refreshes are bounded/cancellable with provider-probe timeouts; and the TUI is re-laid out to Option A (split Sessions/Queue rail + live right-pane stream + single status strip).**

## Performance

- **Duration:** ~19 min
- **Started:** 2026-06-08T16:00:57+02:00 (first RED commit)
- **Completed:** 2026-06-08T16:20:01+02:00 (last GREEN commit)
- **Tasks:** 2 planned (TDD) + 1 maintainer-directed re-layout (TDD)
- **Files modified:** 7 modified, 1 created

## Accomplishments
- `relay_control_request_grant` LLM tool: a running model can open a **visible, human-approved** grant request instead of silently hitting default-deny — caller-bound source, self-request blocked, stays pending until a human resolves it (D-14, CONTROL-14/15).
- Model-driven mailbox operations (`relay_inbox_read` delivery, `relay_inbox_ack`) and grant requests now stamp `actor_kind: 'llm'` so the event stream shows **who acted**.
- Read-model `classifyEventSource` (human/llm/system) and `classifyEventDisposition` (pending/approved/denied/executed) — pure, additive, reusable.
- Bounded, cancellable, **dual-cadence** refresh: fast synchronous control snapshot (1s) keeps the stream live; provider probes ride a 5s cadence and are timeout-bounded so an offline backend never blocks the UI (CONTROL-16).
- **Option A** Command Central layout: left column split into Sessions roster + merged Queue (inbox/grants/pending with `exp!` markers); right pane is the live event stream with human/llm source badges + lifecycle disposition; single bottom status+hints strip (no separate audit box).
- Extracted the pure view builder to `src/cli/command-central-view.ts` (cmd-tui.ts had exceeded the ~800-line cap; now 635 / view 306).

## Task Commits

TDD: each feature is a `test(08-08)` RED commit (compiling throw-stubs, verified failing) followed by a `feat(08-08)` GREEN commit (verified passing).

1. **Task 1 — model-op visibility (data layer)**
   - RED `a928f6c` (test) — tools/read-model failing tests + stubs
   - GREEN `9289e99` (feat) — tools.ts + broker.ts + read-model.ts
2. **Task 2 — keep Command Central fast under load**
   - RED `b5f80e0` (test) — withTimeout + createRefreshSequencer failing tests + stubs
   - GREEN `4df402e` (feat) — cmd-tui.ts resilience helpers, dual-cadence refresh, provider timeout
3. **Re-layout (maintainer-directed) — Option A + Task 1 TUI rendering**
   - RED `5b5ec19` (test) — new render-shape assertions + extracted view types + throw-stub builder
   - GREEN `0480469` (feat) — command-central-view.ts Option A builder implemented

## Files Created/Modified
- `src/cli/command-central-view.ts` (created) — pure Option A view builder: Sessions rail, merged Queue, live EventLine stream with source/disposition, status/hints rollup.
- `src/control/tools.ts` — added `relay_control_request_grant` (6th tool, caller-bound); `actor_kind: 'llm'` on inbox read delivery + ack.
- `src/control/broker.ts` — additive `actor_kind` on `requestGrant` payload and `markDelivered`/`markFailed` events.
- `src/control/read-model.ts` — `classifyEventSource` / `classifyEventDisposition` + their types.
- `src/cli/cmd-tui.ts` — `withTimeout`, `createRefreshSequencer`, dual-cadence stale-guarded refresh, provider-probe timeout, Option A Ink components (RailPane/QueuePane/MainPane/StatusStrip), re-export of the extracted view layer.
- `src/control/tools.test.ts`, `src/control/read-model.test.ts`, `src/cli/cmd-tui.test.ts` — RED/GREEN test coverage for all of the above.

## Decisions Made
- **6th tool, not a schema rename.** `relay_control_request_grant` wraps the existing `broker.requestGrant`; CONTROL_TOOL_DEFS grew from 5 → 6. It is additive and auto-wires through `cmd-run.ts` (which spreads `...CONTROL_TOOL_DEFS`).
- **Additive audit only.** New `actor_kind` is an optional payload field appended only on model-driven paths. Existing event types and fields are untouched, so the parallel 08-05 E2E (which asserts on current shapes) is unaffected. Verified: `broker.test.js` stays green (individual-field assertions, no full-payload deepEqual).
- **Stream stays chronological.** The maintainer's mock shows ascending timestamps (newest at the bottom); freshness is delivered by the 1s control cadence + "live Ns" indicator, not by reordering. Existing newest-at-bottom semantics preserved.
- **Disposition badges** map control_requested→pending, control_approved→approved, control_denied/message_blocked→denied, control_executed→executed.

## Deviations from Plan

### Maintainer-directed scope addition (not an auto-fix)

**1. Option A TUI re-layout**
- **Origin:** The original 08-08 plan text scoped Task 1 (model-op visibility) and Task 2 (keep it fast). The maintainer rejected the existing 3-column + audit-box layout and directed a specific Option A re-layout as part of this execution.
- **What changed:** Left column split into a Sessions roster + a merged Queue (inbox/grants/pending); the right pane became the live event stream (the Part 1 visibility events render here with human/llm source badges + pending/approved/denied/executed state); the separate audit box was removed and folds into the per-session stream; the bottom became a single status+hints strip. Narrow-terminal stacked fallback, Ink + `React.createElement` (no JSX), and the `:` palette / j-k nav are preserved.
- **Files:** `src/cli/cmd-tui.ts`, `src/cli/cmd-tui.test.ts`, new `src/cli/command-central-view.ts`.
- **Verification:** RED `5b5ec19` (render-shape tests fail against throw-stub) → GREEN `0480469` (all pass). Render-shape tests make no provider network calls.
- **Committed in:** `5b5ec19`, `0480469`.

**2. Co-delivery of Task 1's TUI rendering with the re-layout**
- The original plan put "add source badges + pending/executed/denied to the read model AND TUI" in Task 1. The read-model half landed in Task 1 GREEN (`9289e99`); the **TUI rendering** half (structured `EventLine` with colored source/disposition badges) landed in the re-layout GREEN (`0480469`), because it shares the exact surface being re-laid out. Net deliverable is unchanged; only the commit boundary differs.

---

**Total deviations:** 1 maintainer-directed scope addition (re-layout) + 1 commit-boundary note. No Rule 1-4 auto-fixes were required. No scope creep beyond the maintainer's explicit instruction.

## Issues Encountered
None. The shared build stayed green at every RED and GREEN commit (verified `npm run build` exit 0 each time under the build lock), so the parallel 08-05 agent was never blocked. Build-lock contention and the parallel agent's dirty/interleaved files were handled per protocol (explicit per-file staging, no `git add -A`).

## TDD Gate Compliance
Each of the three features shows a `test(08-08)` commit immediately before its `feat(08-08)` commit, with verified RED (failing for the right reason) → GREEN (passing) transitions. RED stubs compiled (throw-stubs / missing additive fields) so the shared build never broke.

## Verification
- Final scoped suite (under build lock): `npm run build && node --test dist/control/tools.test.js dist/control/read-model.test.js dist/cli/cmd-tui.test.js dist/control/broker.test.js` → **172 pass, 0 fail**.
- Smoke: `relay tui --json` → exit 0; the `control` snapshot still carries `sessions / selected_session / events / inbox / grants / pending_actions / blocked / audit / providers / generated_at`, and legacy top-level fields (`version`, `status.binary_version`, 4 providers, `recent_activity`, `recall_preview`) are intact.

## Known Stubs
None. The RED throw-stubs were all replaced by their GREEN implementations; no `not implemented` / TODO / placeholder strings remain in the source files.

## Self-Check: PASSED
- `src/cli/command-central-view.ts` exists (306 lines).
- Commits present on branch `phase-8-control`: `a928f6c`, `9289e99`, `b5f80e0`, `4df402e`, `5b5ec19`, `0480469`.

## Next Phase Readiness
- Model-op visibility + responsive, re-laid-out Command Central are in place; CONTROL-14/15/16 satisfied.
- Per the parallel-execution protocol, STATE.md / ROADMAP.md / REQUIREMENTS.md were intentionally NOT touched — the orchestrator reconciles them after the wave.
- Docs (`docs/commands.md`, `README.md`) describing the new tool and layout are owned by the parallel 08-05 agent / a later docs pass, not this plan.

---
*Phase: 08-universal-llm-control*
*Completed: 2026-06-08*
