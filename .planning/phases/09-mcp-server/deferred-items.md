# Phase 9 — Deferred Items

Out-of-scope discoveries logged during execution. Not fixed by the discovering executor (scope boundary: only auto-fix issues directly caused by the current plan's changes).

## [09-02] Pre-existing: control E2E time-bomb tests expired 2026-06-09T10:23:20Z

**Discovered during:** Plan 09-02 final full-suite verification (2026-06-09 ~19:10 UTC)
**File:** `src/control/control-e2e.test.ts` (Phase 8 artifact — in neither 09-01 nor 09-02 write set)
**Failing tests (2):**
- `LM Studio control-tool send reaches a fake target (with a grant)` — "granted llm send is allowed: false !== true"
- `repeated identical ping-pong is blocked as a loop` — "send 1 allowed: false !== true"

**Root cause (verified, deterministic — 3 identical isolated runs):**
- `control-e2e.test.ts:51` pins `const T0 = 1_781_000_000_000` = 2026-06-09T10:13:20Z (epoch ms).
- Both tests create grants AT `T0` with `ttl_ms: 600_000` → `expires_at` = 2026-06-09T10:23:20Z.
- The send path uses the real clock: `control/tools.ts:354` calls `broker.sendMessage` with no injected time; `broker.ts` `checkGrant(..., now = Date.now())` then `grant.expires_at <= now` → `{allowed:false, reason:'expired'}`.
- Tests were green at Phase 8 merge (2026-06-08) because real time was still before `T0 + 10min`. They detonated permanently at 10:23:20Z on 2026-06-09 and will fail for every run from now on, on every branch containing the Phase 8 test.

**Not caused by 09-02 / 09-01:** `git diff HEAD~1 HEAD -- package-lock.json` outside the `@modelcontextprotocol` tree is 0 lines; `src/control/` untouched by both executors; failure mechanism is pure wall-clock arithmetic.

**Suggested fix (for a follow-up fix plan, NOT this phase's scope):** derive the grant timestamps from `Date.now()` in the two grant-creating tests (or inject `now` through `registerControlTools` → `broker.sendMessage`), so grant validity is relative to test runtime, never a fixed epoch. The other 13 control-e2e tests pass; only the two grant-at-`T0` tests are affected.
