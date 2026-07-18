---
phase: 09-mcp-server
plan: 01
subsystem: dispatch
tags: [provider-registry, env-discovery, generic-http-runner, usage-receipt, cli, sqlite]

# Dependency graph
requires:
  - phase: 08 (universal LLM control)
    provides: existing five-provider run path, GenericHttpRunner base, RunStore, lmstudio-agentic control wiring
provides:
  - "src/workers/provider-registry.ts — resolveProvider/listProviders: builtin table + RELAY_PROVIDER_<NAME>_URL|KEY|TYPE|HEADER_* env discovery"
  - "runnerFromProviderConfig — parameterized GenericHttpRunner for env-declared openai/anthropic endpoints, key resolved at request time"
  - "extractUsageReceipt — uniform token receipt (token_usage/prompt_tokens/completion_tokens) across both wire shapes, null when absent"
  - "runs.prompt_tokens + runs.completion_tokens columns (PRAGMA-guarded additive migration)"
  - "relay providers command (table + --json, keys masked by construction)"
  - "registry-resolved relay run — closed provider union deleted from the run path"
affects: [09-04 (mcp server assembly reuses cli dispatcher idiom), any future plan touching dispatch or run records]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Provider config = pure function of an injected env object; configs carry key env-var NAMES, never values"
    - "Builtin names win: env collision is PROVIDER_NAME_CONFLICT at resolve, never silent override"
    - "Usage receipt: raw provider numbers persisted; absent receipt is null, never invented; no cost math anywhere"

key-files:
  created:
    - src/workers/provider-registry.ts
    - src/workers/provider-registry.test.ts
    - src/cli/cmd-providers.ts
    - src/cli/cmd-providers.test.ts
  modified:
    - src/workers/generic-http-runner.ts
    - src/workers/generic-http-runner.test.ts
    - src/workers/anthropic.ts
    - src/runtime/store/run-store.ts
    - src/runtime/store/db.ts
    - src/cli/cmd-run.ts
    - src/cli.ts
    - src/errors.ts
    - src/workers/lmstudio-agentic.test.ts

key-decisions:
  - "ProviderWireType widened to openai|anthropic|subprocess — codex's listing row is truthful instead of faking an HTTP type; env _TYPE validation still only accepts openai|anthropic"
  - "Anthropic URL suffixing is /v1-aware (append /v1/messages, or /messages when base ends in /v1) per the plan text — deliberate deviation from relay-mcp's bare /messages append"
  - "anthropic.ts exports buildAnthropicBody/parseAnthropicResponse; GenericHttpRunner imports them (one-way dep, no cycle); AnthropicRunner keeps its ?? 0 usage fallback for byte-parity"
  - "openai token_usage prefers total_tokens, falls back to prompt+completion sum (plan Test 2); only manifests when a provider omits total"

patterns-established:
  - "Registry-resolved dispatch: cmd-run resolves --provider via resolveProvider before any run row exists; runner factory = builtin name map + runnerFromProviderConfig for env sources"
  - "Preflight seam on GenericHttpProviderConfig: RelayError returned before any network call (key-missing gate)"

requirements-completed: [DISPATCH-01, DISPATCH-02, DISPATCH-03, DISPATCH-04]

# Metrics
duration: ~25min
completed: 2026-06-09
---

# Phase 9 Plan 01: Agnostic Provider Dispatch Summary

**Any OpenAI-compatible or Anthropic-messages endpoint is now a `relay run` provider via `RELAY_PROVIDER_<NAME>_*` env vars alone — closed union dead, builtins byte-identical, uniform raw usage receipt persisted, `relay providers` key-safe inventory.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-06-09T19:11:05Z
- **Completed:** 2026-06-09T19:35:00Z
- **Tasks:** 3 (all TDD: RED + GREEN commits each)
- **Files modified:** 13 (9 from plan list + 4 documented additions)

## Accomplishments

- **Provider registry** (`src/workers/provider-registry.ts`, 261 lines): builtin table reproducing today's five providers exactly + `RELAY_PROVIDER_<NAME>_URL|KEY|TYPE|HEADER_*` env scan. Pure functions over an injected env object — tests never mutate process.env.
- **Parameterized GenericHttpRunner**: `runnerFromProviderConfig` serves both wire shapes; key resolved from `keyEnvVar` at request time; preflight errors (PROVIDER_NOT_CONFIGURED naming the env var) before any network call; keyless configs work.
- **Uniform usage receipt**: `extractUsageReceipt` normalizes openai (`prompt/completion/total_tokens`) and anthropic (`input/output_tokens`) usage into one shape; persisted to new nullable `runs.prompt_tokens`/`runs.completion_tokens` columns; absent usage stays null. No price map, no cost fields (grep-verified — only the pre-existing `cost_usd` field in `src/workers/types.ts` remains, untouched).
- **Registry-resolved run path**: unknown providers fail with the available-provider list before a run row exists; `relay run "hi" --provider demo` with only `RELAY_PROVIDER_DEMO_URL` set reaches the connection attempt (verified live).
- **`relay providers`**: table + `--json`; key column shows env-var name + set/unset only — masked by construction (live-verified with a synthetic secret: zero occurrences in both outputs).

## The ProviderConfig shape (per plan output spec)

```ts
interface ProviderConfig {
  name: string;
  source: 'builtin' | 'env';
  type: 'openai' | 'anthropic' | 'subprocess';  // subprocess = builtin codex only
  url: string | null;          // fully-derived request URL; null for subprocess
  keyEnvVar: string | null;    // env-var NAME — value resolved at request time
  headers: Record<string, string>;
  agentic: boolean;            // env providers always false in v1 (D-03)
}
```

## Builtin → runner factory mapping (cmd-run.ts)

| Resolved config | Runner |
|---|---|
| `source: 'env'` (any type) | `runnerFromProviderConfig(config)` → GenericHttpRunner (chat-completions or anthropic-messages format) |
| `codex` | `CodexRunner` (subprocess, RELAY_CODEX_PATH) |
| `lmstudio` | `LmStudioRunner` (LMSTUDIO_ENDPOINT/LMSTUDIO_API_KEY) |
| `openrouter` | `OpenRouterRunner` (OPENROUTER_API_KEY) |
| `anthropic` | `AnthropicRunner` (ANTHROPIC_API_KEY) |
| `lmstudio-agentic` | `LmStudioAgenticRunner` + control/figma tool wiring (block unchanged) |

`--model` gate: required when `config.type !== 'subprocess'` (identical messages to before for builtins).

## Receipt columns persisted

`runs.prompt_tokens INTEGER` (nullable) + `runs.completion_tokens INTEGER` (nullable), added via `migrateRunsUsageReceipt` in `src/runtime/store/db.ts` (established PRAGMA `table_info` guard idiom, additive). `RunStore.complete()` accepts and persists both; `cmd-run.ts` passes them on success AND error/timeout paths.

## Deviations from the relay-mcp pattern (per plan output spec)

1. **Anthropic URL suffixing is /v1-aware.** relay-mcp appended bare `/messages` to any base; this port appends `/v1/messages` (or `/messages` when the base already ends in `/v1`). Reason: the plan's Task 1 Test 7 text specifies the /v1-aware behavior, and it is the one that produces a working URL for a bare `https://api.anthropic.com` base. Deliberate divergence from the pattern source.
2. **No `/responses` passthrough.** relay-mcp left URLs ending in `/responses` untouched (its openai-responses type). v0.4's TYPE enum drops openai-responses (D-02), so openai-type suffixing only special-cases `/chat/completions`.
3. **Adapter zoo not ported** (per plan): `_ADAPTER_TYPE`, `_OPENCLAW_TOOL`, `_EXECUTABLE`, `_INTEGRATION_LEVEL` are absent. Name discovery seeds from `_URL` vars only.
4. **`subprocess` wire type added.** relay-mcp had no codex-in-the-registry concept with a printable type; the plan's enum was `openai|anthropic`. Widened so `relay providers` reports codex truthfully (`url: n/a`, type `subprocess`) instead of lying with `openai`. Env `_TYPE` validation still rejects anything but `openai|anthropic`.

## Task Commits

1. **Task 1: Provider registry** — `c1609b3` (test, RED) + `2f5d326` (feat, GREEN)
2. **Task 2: Parameterized runner + receipt** — `2362411` (test, RED) + `7d74f68` (feat, GREEN)
3. **Task 3: Registry-resolved run + providers cmd** — `15e1bfd` (test, RED) + `5e6a7d2` (feat, GREEN)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added UNKNOWN_PROVIDER / PROVIDER_NAME_CONFLICT error codes to src/errors.ts**
- **Found during:** Task 1 (registry implementation)
- **Issue:** Plan's read_first references "RelayError shape for UNKNOWN_PROVIDER / PROVIDER_NAME_CONFLICT errors" but the ErrorCode union did not contain them; errors.ts is not in files_modified
- **Fix:** Added both codes to the union + RELAY_ERROR_CODES array (additive, 4 lines)
- **Files modified:** src/errors.ts
- **Verification:** typecheck clean; registry tests assert both codes
- **Committed in:** 2f5d326

**2. [Rule 3 - Blocking] Receipt migration lives in src/runtime/store/db.ts (not in files_modified)**
- **Found during:** Task 2 (receipt persistence)
- **Issue:** The plan mandates "the established PRAGMA-guarded ALTER migration idiom" — that idiom lives in db.ts's applySchema, not run-store.ts
- **Fix:** `migrateRunsUsageReceipt` added to db.ts following the exact pattern of the neighboring migrations
- **Files modified:** src/runtime/store/db.ts
- **Verification:** receipt persistence test green on :memory: DB (fresh) — migration covers fresh and legacy DBs identically
- **Committed in:** 7d74f68

**3. [Rule 3 - Blocking] src/workers/anthropic.ts refactored to export wire helpers (not in files_modified)**
- **Found during:** Task 2 (anthropic-type support, "do not duplicate the shaping")
- **Issue:** Task 2's action explicitly authorizes this ("refactor src/workers/anthropic.ts only as far as needed to share its wire code") but the frontmatter list omits the file
- **Fix:** Extracted `buildAnthropicBody` + `parseAnthropicResponse` (+ `AnthropicResponseData` type); AnthropicRunner now calls them with byte-identical request/response behavior (its `?? 0` usage fallback intentionally preserved); GenericHttpRunner imports them one-way (no runtime cycle)
- **Files modified:** src/workers/anthropic.ts
- **Verification:** anthropic.test.ts untouched and green (3/3)
- **Committed in:** 7d74f68

**4. [Rule 3 - Blocking] Two stale source-grep guard tests updated in src/workers/lmstudio-agentic.test.ts**
- **Found during:** Task 3 full-suite verification (2 new failures vs baseline)
- **Issue:** Phase 8 guard tests assert the literal closed-union text in cmd-run.ts and the closed validator array in cli.ts — exactly the code this plan is required to delete ("the closed-union TypeScript type is gone from cmd-run.ts" is an acceptance criterion). The guards' INTENT (lmstudio-agentic stays dispatchable) is preserved
- **Fix:** Both tests now assert the new mechanism: cmd-run contains `resolveProvider` + the lmstudio-agentic runner branch; the registry lists lmstudio-agentic as builtin/agentic; cli.ts no longer contains the closed validator array. No runner-behavior test expectations were changed
- **Files modified:** src/workers/lmstudio-agentic.test.ts (2 tests)
- **Verification:** full suite back to baseline failure set (only the 2 pre-existing control E2E time-bomb tests)
- **Committed in:** 5e6a7d2

---

**Total deviations:** 4 auto-fixed (all Rule 3 - blocking; deviations #1-#3 are file-list additions explicitly implied/authorized by the plan text)
**Impact on plan:** No scope creep. All four were required to satisfy the plan's own acceptance criteria.

## Issues Encountered

- **Baseline was not fully green:** 2 pre-existing failures in `src/control/control-e2e.test.ts` (Phase 8 grant-expiry time bombs, root-caused independently by executor 09-02 — see `deferred-items.md`). Verified failing BEFORE any 09-01 change; identical failure set after. Out of scope per the deviation boundary.
- **lmstudio-agentic parity test initially mis-modeled the runner:** the agentic runner probes `/v1/models` for `tool_use` capability before the chat POST. Fixed the test stub to answer the probe (test-correctness fix during Task 3; runner untouched).

## Verification Results (acceptance criteria)

| Criterion | Result |
|---|---|
| All 7 Task-1 behaviors pass; `RELAY_PROVIDER_` scan present; no `process.env[config` in registry | PASS (15 tests; grep counts 12 / 0) |
| All 6 Task-2 behaviors pass; full suite green; cost grep finds nothing new | PASS (12 tests; only pre-existing `cost_usd` in types.ts) |
| All 5 Task-3 behaviors pass; union gone (`grep -c` = 0); `resolveProvider` in cmd-run | PASS (12 tests) |
| `npm run typecheck` clean | PASS (after each task) |
| `node dist/cli.js providers \| grep -q builtin` | PASS |
| Demo provider: listed + run fails at connection (not resolution) | PASS (`demo fetch failed: TypeError: fetch failed`) |
| Synthetic key never printed (table + JSON) | PASS (0 occurrences) |
| Builtin parity: five names route to existing runner classes | PASS (parity tests 3a-3e) |
| Full suite | 1858 tests / 1856 pass — baseline was 1819 / 1817 with the same 2 pre-existing failures; +39 new tests, all green |

## Known Stubs

None — no placeholder values, no TODO/FIXME, all surfaces wired (grep-verified across plan files).

## Threat Flags

None beyond the plan's threat model. T-09-01 (key disclosure) mitigated by construction and asserted in tests; T-09-02 (builtin spoofing) mitigated via PROVIDER_NAME_CONFLICT; T-09-03 (typo'd URL) accepted per plan — `relay providers` makes the resolved URL visible for self-audit.

## Next Phase Readiness

- Wave-1 dispatch deliverable complete; plans 09-03+ (MCP tools/server) have no dependency on this plan and 09-02 (SDK pin + result helpers) landed in parallel.
- Deferred (logged in deferred-items.md): cmd-parallel still has its own closed union; `relay completion` static provider list; the 2 control E2E time-bomb tests need a follow-up fix plan.

## Self-Check: PASSED

All 5 claimed artifacts exist on disk; all 6 task commits (c1609b3, 2f5d326, 2362411, 7d74f68, 15e1bfd, 5e6a7d2) present in git history.

## Follow-up: cmd-parallel

BACKLOG item closed (2026-06-09): `relay parallel` now rides the registry too.

- `SpecTask.provider` closed union → `string`; spec validation resolves each provider via `resolveProvider` before any run row exists. Unknown names exit 2 with the available-provider list; the model gate keys on `config.type !== 'subprocess'` (codex exempt) instead of the hardcoded `httpProviders` set.
- Private `getRunner` deleted. The 09-01 factory was inline in cmd-run.ts (not exported), so per the follow-up's fallback it now lives in a new shared module `src/cli/runner-factory.ts` (`runnerForProvider`): builtin map + `runnerFromProviderConfig` for env sources. Agentic extra tool handlers are caller-supplied — parallel wires Figma only; the run-bound relay_* control tools stay cmd-run-only. cmd-run.ts itself untouched (owned by parallel executors); adopting the shared factory there is a later mechanical swap.
- Behavior preserved byte-identically: figma tool injection + DEFAULT_AGENTIC_TOOLS on lmstudio-agentic, AGENTIC_SANDBOX_ENV marker (still name-keyed, NOT `config.agentic` — codex is agentic:true in the registry and must not set the marker), run-store record fields, output formatting, exit codes, model-required message text.
- Tests: `src/cli/cmd-parallel.test.ts` (12, new) — env-provider dispatch through the factory seam, registry-driven unknown-provider error, four builtin wire-parity guards, type-driven model gate, agentic tools + sandbox marker guard (incl. no-control-tools divergence), factory instanceof parity + drift guard.
- Deviation (mirrors this plan's deviation #4): two stale source-grep guards in `src/workers/lmstudio-agentic.test.ts` asserted the deleted union/`validProviders`/`getRunner` literals; updated to assert the registry + factory mechanism, intent unchanged.
- Commits: `ff2b91f` (test, RED — 6 fail / 6 parity guards green) + `5600c6e` (refactor, GREEN — 12/12, typecheck clean, full suite adds no failures beyond the 2 pre-existing control-e2e time bombs).

---
*Phase: 09-mcp-server*
*Completed: 2026-06-09*
