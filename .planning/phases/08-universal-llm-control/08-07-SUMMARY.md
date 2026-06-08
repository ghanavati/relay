---
phase: 08-universal-llm-control
plan: 07
subsystem: control
tags: [command-palette, approval-queue, grants, broker, tui, d-13, d-14]

# Dependency graph
requires:
  - phase: 08-02
    provides: ControlBroker (sendMessage policy path, blockSend audit conventions, checkGrant)
  - phase: 08-03
    provides: executeSessionCommand CLI surface, grant/revoke audit-event txn pattern, caller-bound tool scoping precedent
  - phase: 08-06
    provides: ControlSnapshot read model (pending_actions resolution on payload.request_id), buildCommandCentralView, Command Central Ink layout
provides:
  - Shared session action functions (inspectSession/tailSession/sendToSession/delegateToSession/issueGrant/revokeGrant) used by BOTH `relay session ...` and the Command Central palette (D-13, CONTROL-13)
  - Keyboard-first ':' command palette in `relay tui` (parsePaletteCommand/executePaletteCommand) with RelayError codes surfaced inline
  - Broker session-control actions: pauseSession (interrupt-gated), resumeSession (resume_send-gated), delegateTask (tool_call-gated framed send)
  - Grant approval queue: broker requestGrant/getControlRequest/approveGrantRequest/denyControlRequest over the D-14 control_requested → approved/denied lifecycle (CONTROL-14)
  - D-14 self-approval gate: a model can never approve a request where it is the requesting source (CONTROL-15)
  - store.listControlRequestEvents (json_extract request_id lookup, append order)
  - CLI actions delegate/pause/resume/approve/deny riding the generic session dispatch
affects: [08-08 docs, control/tools.ts future relay_grant_request tool, any Command Central consumer]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "One action implementation, two surfaces: CLI subcommands and palette both call the same exported action functions — equivalence pinned by a test comparing RelayError codes across both paths (D-13)"
    - "Capability-gated lifecycle transitions in the broker (SESSION_TRANSITIONS table): pause needs interrupt, resume needs resume_send, delegate needs tool_call on the target (D-01)"
    - "Approval lifecycle as events, not tables: control_requested payload carries request_id/ttl_ms/max_messages/expires_at; resolution events name the same request_id; json_extract finds them"
    - "Palette executor returns frozen { ok, message } | { ok:false, code, message } — UI renders results verbatim, store stays source of truth (post-action snapshot re-gather)"

key-files:
  created: []
  modified:
    - src/control/broker.ts
    - src/control/session-store.ts
    - src/cli/cmd-session.ts
    - src/cli/cmd-tui.ts
    - src/cli/cmd-tui.test.ts
    - src/control/broker.test.ts

key-decisions:
  - "Palette parse/execute live in cmd-session.ts next to the session command surface (re-exported from cmd-tui.ts) — keeps cmd-tui.ts at 733 lines, under the 800 cap"
  - "Self-approval denial reuses CONTROL_SELF_SEND_BLOCKED (the self-action-blocked code family) and audits the attempt as a source-anchored message_blocked event with reason self_approval_blocked — the closed CONTROL_EVENT_TYPES set (types.ts not in plan scope) has no dedicated type, and the blocked pane is exactly where self-escalation attempts belong"
  - "Blocked self-approval resolves NOTHING: the request stays pending for the human (message_blocked is not a control_* lifecycle type, so resolvePendingActions and listControlRequestEvents both ignore it)"
  - "Approving an expired request auto-denies it (control_denied, reason 'expired', denied_by 'system') then throws CONTROL_GRANT_EXPIRED — the pending queue self-cleans on operator action instead of accumulating stale rows"
  - "A model MAY approve a DIFFERENT session's request with visible attribution (approved_by = session id, approved_by_kind = llm) — D-14 prohibits self-approval, not third-party approval; the gate is self-scope"
  - "Palette and CLI approvals are hardcoded kind:'human' — the llm approver shape exists only for future caller-bound tool wiring, never argv/keyboard input"
  - "delegateTask requires tool_call on the target IN ADDITION to broker delivery policy: a session that cannot call tools cannot act on a delegated task; the task is visibly framed with '[delegated task] '"
  - "pause/resume are state transitions (active↔idle) with session_updated audit events, not process control — honest about what exists today (D-01), adapters add real interrupt later"

patterns-established:
  - "Palette verbs with optional [session] args fall back to the rail selection (sessionArgOrSelected)"
  - "Pending pane marks stale requests with 'exp!' from payload.expires_at vs snapshot generated_at"
  - "requireUnresolvedRequest: approve/deny share one existence + already-resolved gate (RUN_NOT_FOUND / INVALID_ARGS)"

requirements-completed: [CONTROL-13, CONTROL-14, CONTROL-15]

# Metrics
duration: 18min
completed: 2026-06-08
---

# Phase 8 Plan 07: Command Palette Actions, Inbox and Grant Approval Queue Summary

Keyboard-first ':' palette in Command Central executing send/inspect/tail/grant/revoke/delegate/pause/resume through the exact broker/session-command functions the CLI uses, plus a D-14 grant approval queue (requestGrant → human approve/deny with TTL, budget, and full audit) where models can never approve their own requests.

## Performance

- Duration: ~18 min (21:50–22:08 UTC, includes parallel-agent build-lock waits)
- Tasks: 2/2 (both TDD)
- Scoped tests: 146 pass / 0 fail (61 cmd-tui incl. 32 new palette/approval, 30 cmd-session regression, 55 broker incl. 18 new approval-queue)

## Accomplishments

- Refactored `relay session` subcommand bodies into exported shared action functions; the palette executor dispatches to the same functions, so human UI actions produce byte-identical broker events, audit trails, and RelayError codes as the CLI (pinned by an equivalence test).
- Broker grew capability-gated session control: `pauseSession` (interrupt, active→idle), `resumeSession` (resume_send, idle→active), `delegateTask` (tool_call gate + framed content through the full sendMessage policy path; refusals audited via the existing blockSend convention).
- Grant approval queue: models file `control_requested` events carrying requested TTL/budget/approval-window; humans approve (grant + grant_issued + control_approved in one transaction, TTL/budget overridable) or deny (control_denied with reason and attribution); expired requests read as 'expired' and auto-deny on an approve attempt.
- D-14 enforcement: an llm approver whose session id matches the requesting source is refused with CONTROL_SELF_SEND_BLOCKED, the attempt is audited source-anchored, no grant materializes, and the request stays pending for the human — tested explicitly, including the positive case (third-party model approval with visible attribution).
- Command Central: ':' opens the palette (Esc cancels, Enter executes), results render inline green/red with the RelayError code, pending pane marks stale requests `exp!`, hints line documents the palette key. After every palette action the snapshot is re-gathered — UI state is never the source of truth.
- CLI gained delegate/pause/resume/approve/deny for free via the generic session dispatch (verified: unknown-action usage line lists all 11).

## Task Commits

| Task | RED | GREEN |
| ---- | --- | ----- |
| 1. Command palette actions through the broker | b112dd0 | b544ebb |
| 2. Inbox and grant approval queue | 1aba678 | d1cb645 |

## Files Created/Modified

- `src/control/broker.ts` (985 lines) — DELEGATED_TASK_PREFIX + delegate schema; pause/resume via SESSION_TRANSITIONS; approval-queue schemas (RequestGrant/Approve/Deny inputs, ControlApprover discriminated union, GrantRequestPayloadSchema re-validated on read); requestGrant/getControlRequest/approveGrantRequest/denyControlRequest; requireUnresolvedRequest gate.
- `src/control/session-store.ts` (805 lines) — listControlRequestEvents (parameterized json_extract over control_* lifecycle types, append order, bounded).
- `src/cli/cmd-session.ts` (970 lines) — SessionActionDeps + six shared action functions; attemptDelivery/emitSendResult shared shaping; palette (PALETTE_ACTIONS/USAGE, parse, dispatch, execute); CLI runDelegate/runPauseResume/runApprove/runDeny; VALID_ACTIONS now 11 verbs.
- `src/cli/cmd-tui.ts` (733 lines) — palette import/re-export; Ink App palette state machine (':' open, buffer, Enter/Esc/Backspace, async execute + snapshot re-gather + selection apply); inline result line; 'exp!' marker in formatPendingLine; hints updated.
- `src/cli/cmd-tui.test.ts` — 32 new tests: parse (3), palette actions incl. capability failures and CLI equivalence (24), approval queue + expired markers (5); top-level `RELAY_DB_PATH=':memory:'` pin added; all 23 pre-existing tests untouched and passing.
- `src/control/broker.test.ts` — 18 new tests across requestGrant/approve/deny/listControlRequestEvents incl. the explicit self-approval denial and read-model pending visibility integration.

## Decisions Made

See frontmatter key-decisions. The load-bearing one: self-approval attempts must NOT resolve the request — auditing them as `message_blocked` (not `control_denied`) keeps the request pending for the human while still flagging the actor on the blocked pane.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] RED commits include compiling throw-stubs**
- **Found during:** Both tasks (pattern inherited from 08-03/08-06)
- **Issue:** Test-only RED commits referencing missing exports would break `tsc` for the parallel agent sharing this worktree's build.
- **Fix:** RED commits ship contract types + functions throwing `not implemented`; verified each RED fails for the right reason (27 then 21 failures, all in new suites) before GREEN.
- **Files modified:** src/control/broker.ts, src/control/session-store.ts, src/cli/cmd-session.ts
- **Commits:** b112dd0, 1aba678

### Known Cap Exceedances (documented, not fixed)

- `cmd-session.ts` (970) and `broker.ts` (985) exceed the 800-line soft cap. The parallel-execution protocol prohibited new files beyond the plan list, and the orchestrator directed palette extraction INTO cmd-session.ts to keep cmd-tui.ts under the cap (733 — achieved). Splitting (e.g., `control/approval.ts`, `cli/palette.ts`) deferred to a follow-up plan that may create files.

## TDD Gate Compliance

Both tasks: test() commit → verified failing for the right reason → feat() commit → verified passing. Gate sequence present in git log (b112dd0 → b544ebb, 1aba678 → d1cb645). No REFACTOR commits needed.

## Verification Evidence

- Final: `npm run build && node --test dist/cli/cmd-tui.test.js dist/cli/cmd-session.test.js dist/control/broker.test.js` → 146 pass, 0 fail, 33 suites, exit 0 (under build lock).
- Smoke: `relay tui --json` control contract intact (all ten pane keys); `relay session frobnicate` usage line lists all 11 actions.
- Success criteria: (1) TUI commands route through the same broker as CLI — shared functions + equivalence test; (2) pending requests visible (read-model integration test) and approvable/deniable from palette and CLI; (3) self-approval blocked, request stays pending, attempt audited, no authority raised.

## Known Stubs

None. All RED stubs were replaced in GREEN commits. `control_executed` remains an emitted-by-nobody lifecycle event type — getControlRequest already resolves it (latest-resolution-wins) for whichever future plan wires execution tracking; this is intentional forward surface, not a stub.

## Threat Flags

None — no new network endpoints, auth paths, file access, or schema changes. New SQL is one parameterized bounded json_extract read. The palette parses keyboard input with bounded tokenization into Zod-validated action calls (no shell-out, no eval). The self-approval gate REDUCES escalation surface; llm approver identity is caller-bound by design, never model- or argv-supplied.

## Issues Encountered

- None beyond routine build-lock acquisition alongside the 08-04 agent; no foreign compile errors surfaced during my builds.

## User Setup Required

None.

## Next Phase Readiness

- The broker approval API is ready for an LLM-facing `relay_grant_request` tool (tools.ts, future plan): bind callerSessionId as source, and pass `{ kind:'llm', session_id }` approvers so the broker's self-scope gate enforces D-14 structurally.
- Palette verbs are table-driven (PALETTE_ACTIONS/PALETTE_USAGE + one switch case per verb) — new operator actions are one case each.
- docs/commands.md and cli.ts help text do not yet mention delegate/pause/resume/approve/deny (both files outside this plan's scope) — the docs plan should pick these up.

## Self-Check: PASSED

All 6 modified files exist on disk; all 4 task commits (b112dd0, b544ebb, 1aba678, d1cb645) present in git log.
