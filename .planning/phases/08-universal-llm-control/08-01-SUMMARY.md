---
phase: 08-universal-llm-control
plan: 01
subsystem: control
tags: [zod, better-sqlite3, schema-migration, capability-taxonomy, session-bus]

# Dependency graph
requires:
  - phase: 07 (and earlier store work)
    provides: SQLite store with schema_version gating, migration pattern, RelayError conventions
provides:
  - Closed ControlCapability taxonomy (11 capabilities from RESEARCH.md) with strict readonly Zod schemas
  - ControlSession/ControlEvent/ControlMessage/ControlGrant/DeliveryAttempt boundary contracts
  - ControlAdapter interface with per-instance capability declaration (D-01)
  - ControlSessionStore: synchronous SQLite registry/event/mailbox/grant/attempt store
  - v4 schema migration adding five control tables
affects: [08-02 broker, 08-03 adapters, 08-04 cli, 08-05 hooks, 08-07 tui]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Closed Zod enum value sets (capabilities, providers, states, statuses, event types) — adding a value is an explicit schema change"
    - "strict().readonly() Zod schemas: unknown keys rejected, parse output frozen"
    - "Store boundary: accept unknown, Zod-parse to INVALID_ARGS; re-validate rows on read to CONFIG_ERROR"
    - "Version-gated transactional migration registered inline in db.ts applySchema"
    - "Deterministic clocks via optional `now` parameter on mutating store methods"

key-files:
  created:
    - src/control/types.ts
    - src/control/types.test.ts
    - src/control/session-store.ts
    - src/control/session-store.test.ts
  modified:
    - src/runtime/store/db.ts
    - src/runtime/store/schema-version.ts
    - src/runtime/store/schema-version.test.ts
    - src/runtime/store/db.test.ts
    - src/cli/cmd-doctor.test.ts

key-decisions:
  - "ControlProvider is a closed 6-value enum (claude-code, codex, lmstudio, openrouter, anthropic, fake) matching CONTROL-01"
  - "Session states: active / idle / ended — idle covers registered-but-not-live transcript sessions (D-10)"
  - "Message status transition map enforced in store: queued→delivered|failed|expired, delivered→acknowledged, rest terminal"
  - "getGrant returns latest non-revoked grant without expiry/budget filtering — broker owns policy; incrementGrantUsage is the atomic budget gate"
  - "Reused existing error codes (INVALID_ARGS, CONFIG_ERROR, RUN_NOT_FOUND) — errors.ts is owned by plan 08-02"

patterns-established:
  - "Capability reporting: adapters declare capabilities per instance; supports() never derives from provider name (D-01)"
  - "JsonValueSchema: recursive Zod JSON gate rejecting Dates/functions/NaN at metadata/payload boundaries"
  - "Audit shape: control_events carries source/target; control_mailbox carries content_hash/status/redaction; control_delivery_attempts carries per-attempt outcomes (D-05)"

requirements-completed: [CONTROL-01, CONTROL-02]

# Metrics
duration: 18min
completed: 2026-06-07
---

# Phase 8 Plan 01: Universal Control Foundation Summary

**Closed 11-capability control taxonomy with strict readonly Zod boundary schemas, plus a synchronous better-sqlite3 ControlSessionStore over five new v4-migrated tables (sessions, events, mailbox, grants, delivery attempts)**

## Performance

- **Duration:** 18 min
- **Started:** 2026-06-07T20:10:07Z
- **Completed:** 2026-06-07T20:28:37Z
- **Tasks:** 2 (both TDD: RED commit + GREEN commit each)
- **Files modified:** 9 (4 created, 5 modified)

## Accomplishments

- `src/control/types.ts`: closed ControlCapability set (register, observe, tail, context_inject, mailbox, resume_send, live_stdin, interrupt, fork, spawn, tool_call), closed provider/state/status/sender/event-type sets, strict+readonly Zod schemas for sessions, sends, events, grants, delivery attempts, and the ControlAdapter interface. 44 tests.
- `src/control/session-store.ts`: synchronous ControlSessionStore — upsertSession, getSession, listSessions, appendEvent, tailEvents (after_id cursor + limit), enqueueMessage (sha256 content hash, redaction metadata), getQueuedMessages (TTL-aware), markDelivered/markAcknowledged/markFailed/markExpired with a guarded transition map, grant/revoke/getGrant, incrementGrantUsage (atomic D-04 budget gate), recordDeliveryAttempt/listDeliveryAttempts. 35 tests.
- v4 schema migration in `db.ts` (version-gated, single transaction) creating `control_sessions`, `control_events`, `control_mailbox`, `control_grants`, `control_delivery_attempts` + indexes; `EXPECTED_SCHEMA_VERSION` 3 → 4.
- Full suite green: 1450 tests, 0 failures (baseline 1371 + 79 added).

## Task Commits

Each task was committed atomically (TDD: test commit then feat commit):

1. **Task 1: Define universal control types and capability taxonomy**
   - RED `c0cea5d` (test) — failing test, build fails with TS2307 missing `./types.js`
   - GREEN `6fd715c` (feat) — types.ts; 44/44 pass
2. **Task 2: Add synchronous SQLite control store**
   - RED `f63daca` (test) — failing test, build fails with TS2307 missing `./session-store.js`
   - GREEN `5436284` (feat) — session-store.ts + v4 migration + version bump + pinned-assertion updates; 35/35 pass

## Files Created/Modified

- `src/control/types.ts` — capability taxonomy, value sets, Zod boundary schemas, ControlAdapter/DeliveryOutcome interfaces
- `src/control/types.test.ts` — closed-set pins, malformed-session and malformed-send rejection, D-01 adapter capability reporting
- `src/control/session-store.ts` — ControlSessionStore over the five v4 tables; sync transactions only
- `src/control/session-store.test.ts` — registry/events/mailbox/transitions/grants/attempts against `RELAY_DB_PATH=':memory:'`
- `src/runtime/store/db.ts` — `migrateControlTablesV04` registered at the end of `applySchema`
- `src/runtime/store/schema-version.ts` — `EXPECTED_SCHEMA_VERSION = 4`, version semantics doc updated
- `src/runtime/store/schema-version.test.ts` — pinned assertion 3 → 4 (per plan)
- `src/runtime/store/db.test.ts` — fresh-DB version rows now `[1,2,3,4]`, v4 idempotency count (deviation, see below)
- `src/cli/cmd-doctor.test.ts` — schema-version probe regexes rebuilt from `EXPECTED_SCHEMA_VERSION` (deviation, see below)

## Decisions Made

- Closed `ControlProvider` enum with the six CONTROL-01 surfaces; future providers are explicit additions, consistent with the closed-capability philosophy.
- Event types are also a closed 16-value set covering session/message/grant/delivery lifecycles plus the D-14 control request→approve/deny→execute lifecycle, so Plan 02+ can audit model-driven operations without schema churn.
- Store methods accept an optional `now` epoch-ms argument (default `Date.now()`) for deterministic tests — no global clock mocking.
- `getGrant` deliberately returns expired/exhausted (but non-revoked) grants; expiry/budget are broker policy (D-04), with `incrementGrantUsage` as the single atomic gate the broker calls inside its send transaction.
- Upsert is full-replace of mutable fields (input is the session's current truth); `registered_at` preserved, `last_seen_at` bumped.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] db.test.ts pinned fresh-DB schema versions to [1,2,3]**
- **Found during:** Task 2 (v4 migration)
- **Issue:** `db.test.ts` asserted `versions === [1,2,3]` and per-version row counts only up to v3; the mandated v4 migration makes a fresh DB stamp [1,2,3,4], failing two tests
- **Fix:** Updated the assertion to `[1,2,3,4]` and added the v4 idempotency count check
- **Files modified:** src/runtime/store/db.test.ts
- **Verification:** `node --test dist/runtime/store/db.test.js` — all pass
- **Committed in:** 5436284 (Task 2 commit)

**2. [Rule 3 - Blocking] cmd-doctor.test.ts hardcoded `expected=3` in probe regexes**
- **Found during:** Task 2 (full verification after version bump)
- **Issue:** T1/T2/T4 of the `checkSchemaVersion` suite matched literal `expected=3`; production code uses the constant, so the bump broke 3 tests
- **Fix:** Regexes now built from `EXPECTED_SCHEMA_VERSION` so future bumps cannot re-break them
- **Files modified:** src/cli/cmd-doctor.test.ts
- **Verification:** `node --test dist/cli/cmd-doctor.test.js` — all pass
- **Committed in:** 5436284 (Task 2 commit)

**3. [Rule 2 - Missing Critical] Store methods beyond the plan's named list**
- **Found during:** Task 2 (API design against Plan 02's stated needs)
- **Issue:** The plan mandates the `control_delivery_attempts` table and D-04 budget semantics but its method list omits the operations that make them usable; Plan 02 cannot add them (only broker/registry files in its scope)
- **Fix:** Added `getMessage`, `markExpired` (queued→expired transition implied by message TTLs), `incrementGrantUsage` (atomic budget decrement for D-04), `recordDeliveryAttempt`/`listDeliveryAttempts` (D-05 audit) — all tested
- **Files modified:** src/control/session-store.ts, src/control/session-store.test.ts
- **Verification:** dedicated tests for each (budget exhaustion, expired/revoked refusal, attempt numbering)
- **Committed in:** 5436284 (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (2 blocking, 1 missing critical)
**Impact on plan:** Deviations 1-2 are mechanical consequences of the mandated version bump. Deviation 3 completes the D-04/D-05 contracts this plan's own tables exist for. No scope creep beyond the control foundation.

## TDD Gate Compliance

- Task 1: RED `c0cea5d` (test commit, verified failing: TS2307) → GREEN `6fd715c` (feat commit, 44 pass)
- Task 2: RED `f63daca` (test commit, verified failing: TS2307) → GREEN `5436284` (feat commit, 35 pass)
- No refactor commits needed.

## Verification Evidence

- Plan command: `npm run build && node --test dist/control/types.test.js dist/control/session-store.test.js` → 79/79 pass
- Orchestrator command (+ schema-version): 87/87 pass
- Full suite `npm test`: **1450 tests, 0 failures** (baseline 1371; +44 types, +35 store)
- Success criteria: (1) typed + boundary-validated schemas ✓ (2) five tables back registry/event/mailbox/grant/attempt flows ✓ (3) zero async/await on better-sqlite3 calls — all store methods synchronous, asserted by the "never Promises" test ✓

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: data-at-rest | src/runtime/store/db.ts (control_mailbox) | Cross-session message content persists in plaintext in local relay.db (0600 perms, same posture as memories). Redaction metadata is recorded but redaction enforcement lands with the Plan 02 broker — until then no delivery path exists, so no live exposure. |

## Issues Encountered

None beyond the documented deviations.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 08-02 (broker + adapter registry) can build directly on `ControlSessionStore` and the `ControlAdapter` interface; the atomic `incrementGrantUsage` gate and transition map are ready for its policy layer.
- Plan 08-02 should introduce control-specific error codes in `errors.ts` (this plan reused INVALID_ARGS/CONFIG_ERROR/RUN_NOT_FOUND; RUN_NOT_FOUND for control resources is a naming misfit worth replacing).
- No blockers.

## Self-Check: PASSED

All 4 created source files, the SUMMARY, and all 4 task commits (c0cea5d, 6fd715c, f63daca, 5436284) verified present.

---
*Phase: 08-universal-llm-control*
*Completed: 2026-06-07*
