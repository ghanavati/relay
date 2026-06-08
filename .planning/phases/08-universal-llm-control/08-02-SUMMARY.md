---
phase: 08-universal-llm-control
plan: 02
subsystem: control
tags: [broker, grants, loop-detection, redaction, adapter-registry, fake-adapter]

# Dependency graph
requires:
  - phase: 08-01
    provides: ControlCapability taxonomy, Zod boundary schemas, ControlAdapter/DeliveryOutcome interfaces, ControlSessionStore over the five v4 tables (incl. atomic incrementGrantUsage)
provides:
  - ControlBroker: policy-gated sendMessage (D-03/D-04), checkGrant, markDelivered/markFailed audit wrappers
  - Default-deny LLM sends behind grant TTL + budget with one-transaction decrement
  - Normalized-content loop detection (bidirectional pair counting, windowed)
  - Redaction-before-persistence with per-rule tracking (D-06)
  - ControlAdapterRegistry: provider-unique registration, capability-based delivery routing, deliverQueued drain with full attempt/event audit
  - FakeControlAdapter: deterministic in-memory harness proving A→B/B→A through the universal path
  - Eight CONTROL_* error codes in errors.ts
affects: [08-03 adapters, 08-04 cli, 08-05 hooks, 08-06 tools, 08-07 tui]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Policy lives in the broker; the 08-01 store stays mechanical — loop-detection aggregate is a read-only broker query"
    - "Deny path audits BEFORE throwing: message_blocked appended outside the send transaction so it survives the rollback"
    - "Allow path is ONE db.transaction: incrementGrantUsage gate → enqueue → message_enqueued event (store calls become savepoints)"
    - "Broker input schema is narrower than the store's: content_hash/redaction are computed, never accepted (strict() rejects spoofing)"
    - "Event anchoring convention: enqueued/delivered/failed → target session tail; blocked → source session tail"
    - "DELIVERY_CAPABILITY_PREFERENCE (live_stdin > resume_send > context_inject > mailbox) shared by broker policy, registry routing, and the fake adapter"

key-files:
  created:
    - src/control/broker.ts
    - src/control/broker.test.ts
    - src/control/adapter-registry.ts
    - src/control/adapters/fake.ts
    - src/control/adapter-registry.test.ts
  modified:
    - src/errors.ts

key-decisions:
  - "Loop detection scoped to llm sends per D-04 wording (human sends are user-initiated); counts persisted pair messages in BOTH directions over the normalized hash, threshold 3, 10-minute window"
  - "Normalized hash (trim/collapse-whitespace/lowercase, sha256) doubles as the persisted content_hash — audit and loop detection share one identity"
  - "Redaction runs BEFORE hashing and persistence; blocked sends persist no content, their audit events carry the hash only"
  - "Human sources need not be registered sessions (the human is not a session); llm sources must be registered"
  - "Eight granular CONTROL_* error codes added instead of reusing INVALID_ARGS/RUN_NOT_FOUND (08-01 follow-up); session-store.ts internals left untouched (out of plan scope)"
  - "Registry contains adapter exceptions: failed attempt recorded on the routed capability, message marked failed, drain continues"

patterns-established:
  - "GrantCheck discriminated union: {allowed:true, grant} | {allowed:false, reason: no_grant|expired|exhausted} — checkGrant is the readable policy probe, incrementGrantUsage the atomic enforcement"
  - "DeliveryReport per drained message: {message_id, ok, capability, detail?} frozen, oldest-first"
  - "Fake adapter failure injection is one-shot (failNext/throwNext) and fully deterministic — no fs, no network, no randomness"

requirements-completed: [CONTROL-03, CONTROL-04, CONTROL-10]

# Metrics
duration: 13min
completed: 2026-06-07
---

# Phase 8 Plan 02: Control Broker + Adapter Harness Summary

**Policy-aware ControlBroker (default-deny LLM sends behind grant TTL/budget in one transaction, bidirectional normalized-hash loop detection, redaction before persistence) plus a capability-routing adapter registry proven bidirectionally by a deterministic in-memory fake adapter**

## Performance

- **Duration:** 13 min
- **Started:** 2026-06-07T20:39:49Z
- **Completed:** 2026-06-07T20:52:43Z
- **Tasks:** 2 (both TDD: RED commit + GREEN commit each)
- **Files modified:** 6 (5 created, 1 modified)

## Accomplishments

- `src/control/broker.ts`: `ControlBroker.sendMessage` enforces the full D-04 policy — human sends to any registered, delivery-capable target; LLM sends default-deny requiring a registered source plus a usable grant; self-send blocking; loop detection over normalized content hashes counted bidirectionally per pair (threshold 3, 10-min window). Budget decrement (store's atomic `incrementGrantUsage`), enqueue, and the `message_enqueued` event run in ONE transaction — a failed enqueue burns no budget. `checkGrant` exposes the policy probe; `markDelivered`/`markFailed` pair store transitions with audit events. 45 tests.
- Redaction before persistence (D-06): shared `REDACTION_PATTERNS` applied with per-rule tracking; the normalized hash is computed over the REDACTED content; callers cannot supply `content_hash`/`redaction` (strict schema rejects spoofing); blocked sends persist no content and their `message_blocked` events carry the hash only.
- `src/errors.ts`: eight control-specific codes (CONTROL_SESSION_NOT_FOUND, CONTROL_DELIVERY_UNSUPPORTED, CONTROL_GRANT_REQUIRED, CONTROL_GRANT_EXPIRED, CONTROL_BUDGET_EXHAUSTED, CONTROL_SELF_SEND_BLOCKED, CONTROL_LOOP_DETECTED, CONTROL_ADAPTER_DUPLICATE) — closing the 08-01 follow-up.
- `src/control/adapter-registry.ts`: provider-unique registration with duplicate rejection; `deliverQueued` drains a target's queue through its adapter, routing on the strongest shared delivery capability and refusing unknown sessions (CONTROL_SESSION_NOT_FOUND), unconfigured providers (PROVIDER_NOT_CONFIGURED), and capability mismatches (CONTROL_DELIVERY_UNSUPPORTED). Every attempt lands in `control_delivery_attempts` plus a broker `message_delivered`/`message_failed` event; adapter throws are contained. 19 tests.
- `src/control/adapters/fake.ts`: deterministic in-memory adapter (per-instance capabilities per D-01, per-session inboxes, one-shot failNext/throwNext) proving A→B and B→A delivery through the exact broker + registry path real adapters will use.
- Full suite green: 1514 tests, 0 failures (baseline 1450 + 64 added).

## Task Commits

Each task was committed atomically (TDD: test commit then feat commit):

1. **Task 1: Build policy-aware broker with grants and loop detection**
   - RED `173779b` (test) — failing test, build fails with TS2307 missing `./broker.js` + TS2322 for each missing CONTROL_* code
   - GREEN `a1d24c8` (feat) — broker.ts + errors.ts codes; 45/45 pass
2. **Task 2: Add adapter registry and fake adapter harness**
   - RED `e3176db` (test) — failing test, build fails with TS2307 missing `./adapter-registry.js` and `./adapters/fake.js`
   - GREEN `ec31dab` (feat) — adapter-registry.ts + adapters/fake.ts; 19/19 pass

## Files Created/Modified

- `src/control/broker.ts` — ControlBroker, GrantCheck, DELIVERY_CAPABILITY_PREFERENCE, pickDeliveryCapability, normalizeContent/normalizedContentHash, redactControlContent, loop constants
- `src/control/broker.test.ts` — policy matrix (human/llm/self-send/grants/budgets/loops), redaction-before-persistence, one-transaction budget semantics, audit event anchoring
- `src/control/adapter-registry.ts` — ControlAdapterRegistry, DeliveryReport, deliverQueued drain with attempt/event audit
- `src/control/adapters/fake.ts` — FakeControlAdapter (in-memory, deterministic, no filesystem)
- `src/control/adapter-registry.test.ts` — registration/duplicate/routing/unsupported refusals, A→B/B→A bidirectional delivery, failure containment
- `src/errors.ts` — eight CONTROL_* codes in the ErrorCode union and RELAY_ERROR_CODES

## Decisions Made

- Loop detection applies to llm sends only — D-04 names loop detection as an agent-send requirement; human sends are user-initiated and may legitimately repeat (e.g. "continue"). Counting is bidirectional per pair to catch A→B→A ping-pong.
- The persisted `content_hash` IS the normalized hash (trim, collapse whitespace, lowercase, sha256 — computed after redaction), so audit identity and loop identity are one value and whitespace/case variants collide.
- `message_enqueued`/`message_delivered`/`message_failed` events anchor to the TARGET session (whose mailbox changed — what 08-05 hook polling will tail); `message_blocked` anchors to the SOURCE (the denied actor; the target may not exist).
- Broker performs its single policy aggregate (recent pair-message count) as a read-only SQL query rather than extending the 08-01 store — the store stays mechanical per its documented contract, and session-store.ts is outside this plan's file scope.
- Registry constructor takes (store, broker) with safe defaults sharing one cached DB connection; `createControlAdapterRegistry` mirrors the store/broker factory pattern.

## Deviations from Plan

None - plan executed exactly as written. All six files match the plan's `files_modified` list; no auto-fixes, no blocking issues, no architectural changes needed.

## TDD Gate Compliance

- Task 1: RED `173779b` (test commit, verified failing: TS2307 + TS2322) → GREEN `a1d24c8` (feat commit, 45 pass)
- Task 2: RED `e3176db` (test commit, verified failing: TS2307 ×2) → GREEN `ec31dab` (feat commit, 19 pass)
- No refactor commits needed.

## Verification Evidence

- Plan command: `npm run build && node --test dist/control/broker.test.js dist/control/adapter-registry.test.js` → 64/64 pass (45 broker + 19 registry), build clean
- Adjacent-suite regression check after the errors.ts change: types/session-store/db/cmd-doctor → 134/134 pass
- Full suite `npm test`: **1514 tests, 0 failures** (baseline 1450; +45 broker, +19 registry)
- Success criteria: (1) cross-session messages flow through broker policy only — sendMessage is the sole queueing path and rejects spoofed hashes/redaction ✓ (2) LLM sends require grants and are loop/budget bounded — default-deny, TTL, atomic budget, threshold-3 windowed loop detection all tested ✓ (3) fake adapters prove bidirectional delivery without provider dependencies — A→B and B→A through the same registry/broker path, pure in-memory ✓

## Security Posture Note

08-01 flagged plaintext mailbox content at rest (`threat_flag: data-at-rest`), noting redaction enforcement would land with this plan's broker. That enforcement now exists: every send path redacts via the shared `REDACTION_PATTERNS` before persistence, records which rules fired, and blocked sends never persist content. Residual: content that matches no redaction pattern still persists in plaintext in local relay.db (0600 perms) — same posture as memories, unchanged.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 08-03 (provider adapters) implements `ControlAdapter` against real surfaces and registers through `ControlAdapterRegistry`; capability-truthfulness (D-01/D-02) is enforced by `pickDeliveryCapability` routing.
- Plan 08-04 (CLI) can construct store → broker → registry via the factories and expose `relay session send` etc.; all policy/audit is already inside the broker, so the CLI stays thin (D-13).
- Loop threshold/window are exported constants (`LOOP_DETECTION_THRESHOLD`, `LOOP_DETECTION_WINDOW_MS`) — if later plans need per-grant tuning, extend grants rather than forking the policy.
- No blockers.

## Self-Check: PASSED

All 5 created source files, the modified errors.ts, the SUMMARY, and all 4 task commits (173779b, a1d24c8, e3176db, ec31dab) verified present.

---
*Phase: 08-universal-llm-control*
*Completed: 2026-06-07*
