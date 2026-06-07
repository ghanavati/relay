---
phase: 08-universal-llm-control
plan: 03
subsystem: control
tags: [cli, session-commands, llm-tools, lmstudio-agentic, grants, mailbox, openai-tools]

# Dependency graph
requires:
  - phase: 08-01
    provides: ControlCapability taxonomy, Zod boundary schemas, ControlSessionStore over the five v4 tables
  - phase: 08-02
    provides: ControlBroker (policy-gated sendMessage, checkGrant, markDelivered/markFailed), ControlAdapterRegistry + deliverQueued drain, FakeControlAdapter, CONTROL_* error codes
provides:
  - "relay session list|inspect|tail|send|grant|revoke CLI over store + broker + registry (CONTROL-01..04)"
  - "Zod CLI arg boundary in cmd-session.ts: exit 2 usage, exit 1 RelayError with code on stderr, exit 0 success"
  - "Unsupported-capability truth at the CLI: CONTROL_DELIVERY_UNSUPPORTED exits 1, queued-without-adapter is honest (D-01)"
  - "grant/revoke append grant_issued/grant_revoked audit events atomically (D-05)"
  - "control/tools.ts: relay_session_list, relay_session_inspect, relay_session_send, relay_inbox_read, relay_inbox_ack as OpenAI-compatible ToolDefs + caller-bound handlers (CONTROL-05)"
  - "Caller scoping structural: source bound at registration, strict schemas reject spoofed source keys, inbox/ack are caller-only with information hiding (D-04/D-14)"
  - "Pull-based mailbox delivery: relay_inbox_read marks delivered + records a mailbox delivery attempt; ack transitions + audits in one txn"
  - "createControlSessionForRun/endControlSessionForRun: every relay run --provider lmstudio-agentic is a Relay-native control session, session_id == run_id (D-08, CONTROL-07)"
  - "LmStudioAgenticRunner wiring through the existing extraToolHandlers path; NamedToolHandler.pat now optional for credential-less tools"
affects: [08-04 claude-code adapter, 08-05, 08-06 command-central tui, 08-07, 08-08, 08-09]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Human CLI and LLM tools call the SAME broker methods — no parallel control implementation (D-03/D-13)"
    - "Tool denials return structured { ok:false, code, message } so the model sees visible denied states (D-14) instead of bare error strings"
    - "Caller session id is closure-bound at tool registration; model-controlled args can never carry a source identity"
    - "Run-scoped control sessions declare only wired capabilities (register/observe/tail/mailbox/tool_call) — no live_stdin/context_inject overclaims (D-01)"
    - "RED commits ship compile-stubs (throw 'not implemented') so the shared parallel-wave build stays compilable while tests fail behaviorally"

key-files:
  created:
    - src/cli/cmd-session.ts
    - src/cli/cmd-session.test.ts
    - src/control/tools.ts
    - src/control/tools.test.ts
  modified:
    - src/cli.ts
    - src/cli/cmd-run.ts
    - src/workers/lmstudio-agentic.ts
    - docs/commands.md

key-decisions:
  - "CLI sends are always sender_kind='human' with default source 'human:cli'; grants issued via relay session grant are the ONLY authorization path for LLM sends"
  - "Run control session id == run_id so control events join cleanly against the runs table"
  - "relay_inbox_read IS the delivery event for tool-loop sessions (pull model): delivered transition + mailbox delivery attempt recorded per message"
  - "Model-facing session projections exclude workdir/pid/metadata (least disclosure); foreign inbox messages are indistinguishable from missing ones"
  - "Grant defaults bounded by design: 15m TTL, 10-message budget; both overridable but never unlimited"
  - "NamedToolHandler.pat made optional rather than inventing a parallel handler type — Figma keeps passing pat, control tools omit it"

patterns-established:
  - "Tool handler guard: RelayException -> { ok:false, code, message }; non-Relay errors propagate to the worker dispatcher"
  - "CLI control errors print 'relay session: CODE: message' on stderr; exit 1 policy/runtime, exit 2 Zod usage"

requirements-completed: [CONTROL-01, CONTROL-02, CONTROL-03, CONTROL-04, CONTROL-05, CONTROL-07]

# Metrics
duration: 15min
completed: 2026-06-07
---

# Phase 8 Plan 03: Session CLI and LLM Control Tools Summary

**`relay session` CLI and five `relay_*` model tools now drive the same broker: humans send/grant/revoke from the terminal, LM Studio agentic runs register as control sessions and message peers under default-deny grants.**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-06-07T21:01:34Z
- **Completed:** 2026-06-07T21:16:48Z
- **Tasks:** 2 (both TDD)
- **Files modified:** 8

## Accomplishments

- Humans can inspect and steer any registered session from the CLI: `relay session list|inspect|tail|send|grant|revoke`, JSON and human modes, with capability truth enforced (capability-less targets refuse with `CONTROL_DELIVERY_UNSUPPORTED`, adapter-less providers queue honestly).
- Models get a complete bidirectional control surface — list/inspect peers, send under grant, pull and acknowledge their own mailbox — that cannot bypass policy: source identity is closure-bound, schemas are strict, and every deny comes back as a visible `{ ok:false, code }` result.
- Every `relay run --provider lmstudio-agentic` is now a Relay-native control session: registered (audited) before dispatch, offered the control tools through the existing `extraToolHandlers` path alongside `shell_exec` and Figma tools, and ended (audited) on every completion path including worker throws.

## Task Commits

1. **Task 1: Expose human CLI through relay session commands** — `ee8d5c4` (test, RED) → `4077c8e` (feat, GREEN)
2. **Task 2: Add LLM-facing Relay control tools and LM Studio wiring** — `1364d1c` (test, RED) → `e26d290` (feat, GREEN)

No refactor commits needed — implementations landed clean against the tests.

## Files Created/Modified

- `src/cli/cmd-session.ts` — executeSessionCommand: six subcommands, Zod CLI boundary, store/broker/registry routing, grant/revoke audit events in one transaction
- `src/cli/cmd-session.test.ts` — 35 tests: JSON-mode behavior per subcommand, exit-code matrix, fake-adapter delivery, redaction-before-persistence, cli.ts wiring smoke
- `src/cli.ts` — `session` dispatch branch + SESSION COMMANDS help section
- `src/control/tools.ts` — CONTROL_TOOL_DEFS + registerControlTools (caller-bound handlers), toNamedToolHandlers adapter, createControlSessionForRun/endControlSessionForRun lifecycle
- `src/control/tools.test.ts` — 24 tests: def shapes, scoping/spoof rejection, grant default-deny + budget exhaustion, inbox read/ack lifecycle + audit, executeToolCall end-to-end dispatch, cmd-run wiring smoke
- `src/cli/cmd-run.ts` — lmstudio-agentic branch: control session registration, control handler + def merge, session end on success/error/throw paths
- `src/workers/lmstudio-agentic.ts` — NamedToolHandler.pat optional; dispatch substitutes `''`
- `docs/commands.md` — `relay session` reference section + `relay run` lmstudio-agentic control-session note

## Verification

- Task 1: `node --test dist/cli/cmd-session.test.js` — 35/35 pass
- Task 2: `node --test dist/control/tools.test.js dist/workers/lmstudio-agentic.test.js` — 107/107 pass (24 new + 83 preexisting worker tests unaffected)
- Plan-level: `npm run build && node --test dist/cli/cmd-session.test.js dist/control/tools.test.js dist/workers/lmstudio-agentic.test.js` — 142/142 pass
- Full `npm test` deliberately NOT run (parallel wave: sibling plans hold RED states); orchestrator runs it post-wave.

## Deviations from Plan

### Auto-added (Rule 2 — audit completeness)

**1. grant/revoke CLI append `grant_issued`/`grant_revoked` audit events**
- **Found during:** Task 1
- **Issue:** Store grant/revoke are mechanical (no events); without CLI-side appends the D-05 audit trail would have a hole for authority changes.
- **Fix:** cmd-session wraps grant/revoke + appendEvent in one `db.transaction`.
- **Files modified:** src/cli/cmd-session.ts
- **Commit:** 4077c8e

**2. `tail`/`inspect` validate session existence**
- **Found during:** Task 1
- **Issue:** `store.tailEvents` on an unknown session silently returns `[]`; CLI users need `CONTROL_SESSION_NOT_FOUND` instead of an empty success.
- **Fix:** getSession check before tailing/inspecting.
- **Files modified:** src/cli/cmd-session.ts
- **Commit:** 4077c8e

### Process deviation

**3. RED commits include compile-stubs**
- **Reason:** Three agents share this worktree's `npm run build` (single tsc compile of all of src/). A missing-module RED would break the build for sibling plans 08-04/08-06 for the whole RED→GREEN window. Stubs (`throw new Error('not implemented')`) keep tsc green while every behavioral test fails for the right reason (Task 1 RED: 34/35 fail — the single pass was an `assert.throws` on malformed durations, trivially satisfied by the always-throwing stub and co-tested with a red positive-path test; Task 2 RED: 24/24 fail).

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: authority-escalation-via-shell | src/cli/cmd-session.ts | An agentic model with `shell_exec` can invoke the `relay` binary (not in the network-binary blocklist) and run `relay session grant`/`send` as the "human" surface, sidestepping LLM default-deny. Local-first trust model makes shell == user today, but a later phase should consider gating grant issuance (e.g. interactive confirm or env sentinel) when invoked from inside a Relay-owned tool loop. |

## Known Stubs

None — both files fully implemented; no placeholder values or unwired surfaces.

## Self-Check: PASSED

- src/cli/cmd-session.ts — FOUND
- src/cli/cmd-session.test.ts — FOUND
- src/control/tools.ts — FOUND
- src/control/tools.test.ts — FOUND
- Commits ee8d5c4, 4077c8e, 1364d1c, e26d290 — FOUND in git log
- Final verification 142/142 pass — confirmed
