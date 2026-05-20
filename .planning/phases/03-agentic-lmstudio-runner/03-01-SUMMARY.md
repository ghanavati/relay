---
phase: 03-agentic-lmstudio-runner
plan: 01
type: tdd
wave: 1
status: COMPLETE
date: 2026-05-20
duration_min: ~25
tasks_completed: 8
tests_added: 11
tests_total_after: 1189
tests_passing: 1189
requirements_satisfied: [AGENTIC-01, AGENTIC-02, AGENTIC-03, AGENTIC-04, AGENTIC-05, AGENTIC-06]
files_modified:
  - src/workers/lmstudio-agentic.ts
  - src/workers/lmstudio-agentic.test.ts
  - src/cli/cmd-run.ts
  - src/cli/cmd-parallel.ts
  - src/cli.ts
commits:
  - 600bfa3 test(workers): T9 RED — ERRATA E1/E2/E3 capability probe + reasoning_content + empty tool_call_id
  - 5a56fa1 feat(workers): T9 GREEN — ERRATA E1/E2/E3 wire-shape + Qwen safety + bug #830
  - fba61fa fix(workers): capability probe falls back to /api/v0/models when /v1/models omits capabilities
  - 31ce8b1 feat(cli): wire lmstudio-agentic into top-level dispatch with default shell_exec tool
  - 7ff9f03 test(workers): 4 new T7 cases for default-tools wiring + cli.ts validator
---

# Phase 3 Plan 01: Agentic LM Studio Runner Summary

## One-liner

Standalone in-process tool-calling loop against LM Studio `/v1/chat/completions` with
hash-based loop detector, 32KB shell sandbox, LFM2 nudge, capability probe with v1/v0 fallback,
Qwen reasoning_content round-trip, and LM Studio bug #830 defensive id handling — live-verified
against qwen3-coder-next (80B-A3B MLX).

## What Shipped (T1-T8 already landed at HEAD; T9 added per ERRATA)

| Task | Status | Notes |
|------|--------|-------|
| T1 — preconditions | GREEN at HEAD | ExecutionModel includes `tool_loop`; ToolDef/ToolCall types declared; provider literal in cmd-run/cmd-parallel |
| T2 — skeleton + pure helpers | GREEN at HEAD | LmStudioAgenticRunner class + buildInitialMessages + buildLfm2Nudge |
| T3 — tool execution sandbox | GREEN at HEAD | shell_exec/bash, cwd clamp, 32KB byte-safe truncation, byte-exact id echo |
| T4 — tool loop + cap + timeout + probe | GREEN at HEAD | 20-iter cap, AbortController, usage summing, tools[] re-sent every turn |
| T5 — hash-based loop detector | GREEN at HEAD | sha256 with canonical-JSON key sort, per-turn fingerprint, 3-consecutive trigger |
| T6 — LFM2 nudge integration | GREEN at HEAD | `/^liquid\/lfm2-/i` regex, system-message injection |
| T7 — dispatch wiring smoke | GREEN at HEAD + EXTENDED | cmd-run/cmd-parallel/cli.ts now wire DEFAULT_AGENTIC_TOOLS |
| T8 — integration (in-process http) | GREEN at HEAD | ephemeral http.createServer, numeric + UUID id round-trip |
| **T9 — ERRATA fixes (NEW)** | **GREEN** | E1 wire-shape, E2 reasoning_content, E3 empty id |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Capability probe wire shape was wrong (ERRATA E1)**
- **Found during:** Pre-execution context review (LMSTUDIO-ERRATA-2026.md)
- **Issue:** PLAN.md prescribed `GET /api/v0/models` with `capabilities` array, but LM Studio
  docs at lmstudio.ai/docs/developer/rest/endpoints confirm the v0 REST endpoint does NOT
  include a `capabilities` field. The OpenAI-compat `/v1/models` endpoint is the documented
  source for `capabilities: ["tool_use", ...]` arrays.
- **Live discovery:** Probing actual LM Studio 0.4.13+ (2026-05) revealed that `/v1/models`
  on this version OMITS `capabilities` for non-loaded models, while `/api/v0/models` reliably
  includes `capabilities: ["tool_use"]` for ALL listed models. ERRATA was partially wrong.
- **Fix:** Probe both endpoints in order:
  1. Try `/v1/models` first (OpenAI-compat, primary per ERRATA E1)
  2. If entry missing OR `capabilities` key absent → probe `/api/v0/models`
  3. Aggregate: any endpoint reporting `"tool_use"` wins
- **Files modified:** src/workers/lmstudio-agentic.ts
- **Commits:** 5a56fa1 (initial v1/models switch), fba61fa (fallback to v0)

**2. [Rule 2 - Missing Critical Functionality] reasoning_content round-trip (ERRATA E2)**
- **Found during:** Pre-execution ERRATA review
- **Issue:** Qwen 3.5/3.6 models emit `reasoning_content` alongside `tool_calls`. Without
  echoing it back on the assistant message in `messages[]`, the next-turn output leaks
  `</think>` into `content` (QwenLM/Qwen3.6 issue #26). qwen3-coder-next ships without
  reasoning tags by default, but the defense is needed for the LFM2/Qwen3.6 path and is
  documented as "SHOULD" in ERRATA §9.
- **Fix:** Spread `reasoning_content` verbatim when present on the assistant-message push.
  Extended ChatMessage discriminated-union assistant variant to include the optional field.
- **Files modified:** src/workers/lmstudio-agentic.ts (ChatMessage type + main loop assistant push)
- **Commit:** 5a56fa1

**3. [Rule 2 - Missing Critical Functionality] Empty tool_call_id defensive handling (ERRATA E3)**
- **Found during:** Pre-execution ERRATA review (LM Studio bug #830)
- **Issue:** LM Studio can emit `{id: "", type: "function", ...}` on rare paths. Without
  validation, the next POST body's tool message has an empty `tool_call_id`, and LM Studio's
  message validator rejects with "Invalid 'messages' in payload" — crashing the loop.
- **Fix:** When iterating `msg.tool_calls`, validate `tc.id` is non-empty before dispatching
  the tool. On empty, append synthetic `{role:'tool', tool_call_id:'__missing__', content:'ERROR: tool_call_id was empty ...'}` so the model self-corrects without crashing.
- **Files modified:** src/workers/lmstudio-agentic.ts (main loop tool dispatch + EMPTY_ID_SENTINEL constant)
- **Commit:** 5a56fa1

**4. [Rule 2 - Missing Critical Functionality] DEFAULT_AGENTIC_TOOLS export + cli.ts wiring**
- **Found during:** Live smoke test
- **Issue:** PLAN §T7 wired the runner-dispatch (cmd-run.ts:81 + cmd-parallel.ts:54) but
  did NOT wire `task.tools` — the worker's first guard rejects with `INVALID_ARGS:
  lmstudio-agentic requires task.tools[] (non-empty)`. The `must_haves.truths` user flow
  (`relay run --provider lmstudio-agentic ...`) was non-functional. Additionally,
  src/cli.ts:259-261 top-level `--provider` validator was scoped as "follow-up" but blocks
  the user flow.
- **Fix:** Export `DEFAULT_AGENTIC_TOOLS` constant from lmstudio-agentic.ts with the
  `shell_exec` function definition per PLAN §"Tool Execution Sandbox Spec". Wire it into
  cmd-run.ts + cmd-parallel.ts to inject when `provider==='lmstudio-agentic'`. Add
  `'lmstudio-agentic'` to the cli.ts top-level validator array.
- **Files modified:** src/workers/lmstudio-agentic.ts, src/cli/cmd-run.ts, src/cli/cmd-parallel.ts, src/cli.ts
- **Commits:** 31ce8b1 (wiring), 7ff9f03 (4 new T7 tests for the wiring)

**5. [Rule 2 - Missing Critical Functionality] iterations + tool_call_count in JSON envelope**
- **Found during:** Live smoke test verification
- **Issue:** PLAN required WorkerResult to populate `iterations` + `tool_call_count` (achieved
  in T4 GREEN), but the `cmd-run.ts:165-174 --json` output envelope did not surface those
  fields. Without them, users can't observe the loop metrics that are the contract.
- **Fix:** Conditional spread of `iterations` + `tool_call_count` into JSON output when
  present in WorkerResult.
- **Files modified:** src/cli/cmd-run.ts
- **Commit:** 31ce8b1

## Authentication Gates

None. LM Studio runs locally on `http://localhost:1234` with optional `LMSTUDIO_API_KEY`
env. No external API auth required.

## Live Runtime Validation

```bash
# Pre-step: confirmed qwen3-coder-next loaded
$ lms ls | grep qwen3-coder-next
qwen/qwen3-coder-next (1 variant)    80B        qwen3_next       64.76 GB     Local     ✓ LOADED

# Capability probe — actual response shape from this LM Studio:
$ curl -sS http://localhost:1234/api/v0/models | jq '.data[] | select(.id=="qwen/qwen3-coder-next") | .capabilities'
[
  "tool_use"
]

# Smoke run — single iteration with tool call
$ relay run --provider lmstudio-agentic --model qwen/qwen3-coder-next \
            --workdir /tmp/relay-phase3-live --timeout-ms 90000 --json \
            "Run shell_exec with command 'echo hello' and tell me the result"
{
  "run_id": "a2e22375-...",
  "status": "success",
  "output": "The result is `hello` (with a trailing newline), and the exit code was `0`, indicating success.",
  "duration_ms": 2294,
  "exit_code": 0,
  "token_usage": 1308,
  "iterations": 2,
  "tool_call_count": 1,
  "error": null
}

# Multi-file inspection
$ relay run --provider lmstudio-agentic --model qwen/qwen3-coder-next \
            --workdir /tmp/relay-phase3-live --timeout-ms 90000 --json \
            "List files in the current directory and tell me how many TypeScript files there are"
{
  "run_id": "8089104d-...",
  "status": "success",
  "output": "The current directory contains the following files:\n\n- `a.ts`\n- `b.ts`\n- `c.ts`\n- `spec.json`\n\nThere are **3 TypeScript files** ...",
  "iterations": 2,
  "tool_call_count": 1,
  ...
}

# Parallel mode
$ relay parallel /tmp/relay-phase3-live/spec.json --max-concurrency 1 --json
{
  "runs": [{
    "run_id": "8ab0a61a-...",
    "status": "success",
    "duration_ms": 2144,
    "output": "The current working directory (cwd) is `/private/tmp/relay-phase3-live`.",
    ...
  }],
  "summary": {"success": 1, "error": 0, "timeout": 0, "total": 1}
}
```

All 3 LIVE PASS.

## Test Suite

Final count: **1189 tests pass / 0 fail / 1189 total** (was 1178 at baseline, +11 net new).

Lmstudio-agentic test breakdown (61 tests across 12 suites):
- T1 preconditions: 6 tests
- T2 skeleton + pure helpers: 9 tests
- T3 tool execution sandbox: 9 tests
- T4 tool loop + cap + timeout + probe: 8 tests
- T4 continuation — tools[] re-sent: 1 test
- T5 hash-based loop detector: 7 tests
- T6 LFM2 nudge integration: 4 tests
- T7 dispatch wiring smoke: 8 tests (was 4, +4 new for DEFAULT_AGENTIC_TOOLS + cli.ts)
- T8 integration ephemeral http: 2 tests
- **T9 ERRATA E1 capability probe wire shape: 3 tests (NEW)**
- **T9 ERRATA E2 reasoning_content round-trip: 2 tests (NEW)**
- **T9 ERRATA E3 empty tool_call_id defensive: 2 tests (NEW)**

## Acceptance Criteria

| # | ROADMAP Criterion | Status |
|---|---|---|
| 1 | Multi-iteration tool-call loop returns with `tool_call_count`/`iterations` populated | ✓ LIVE PASS |
| 2 | LOOP_DETECTED at 3 consecutive identical hashes (does NOT reach iter 20) | ✓ T5 case 2 |
| 3 | LFM2 model receives JSON nudge in system prompt | ✓ T6 cases 1, 3 |
| 4 | `shell_exec`/`bash` clamped to `task.workdir`; 32KB truncation enforced | ✓ T3 cases 4-6 |
| 5 | `relay parallel` accepts `--provider lmstudio-agentic`; `"tool_loop"` in ExecutionModel union | ✓ T1 + LIVE parallel test |

## REQ-ID Coverage (AGENTIC-01..06)

All 6 satisfied: see VERIFICATION.md coverage matrix; T9 ERRATA fixes do not reduce coverage,
they strengthen mitigations for known LM Studio quirks (R1, R2, R7).

## Self-Check Status

- [x] src/workers/lmstudio-agentic.ts exports LmStudioAgenticRunner with correct capabilities
- [x] DEFAULT_AGENTIC_TOOLS exported with shell_exec function def
- [x] npm test passes 1189/1189
- [x] npx tsc --noEmit clean
- [x] cmd-run.ts + cmd-parallel.ts dispatch lmstudio-agentic + inject tools
- [x] cli.ts top-level validator accepts lmstudio-agentic
- [x] LIVE smoke against qwen3-coder-next: status=success, iter=2, tool_calls=1, contains "hello"
- [x] LIVE parallel test: success
- [x] No console.log/warn/error/info in production code
- [x] No new deps added (uses node:crypto + node:child_process + existing zod)
- [x] src/memory/* and src/cli/cmd-budget.ts untouched

## Follow-up Items (deferred — not blocking v0.2)

1. **Debug-dump helper** (pitfall 1.3) — `RELAY_LMSTUDIO_DEBUG_DUMP=1` flag to write request/response pairs to `~/.relay/debug/lmstudio-*.json`. Needed for LFM2 nudge validation.
2. **Full BUILTIN_PROVIDERS registration** in `src/config/providers.ts:8-15` — adds `lmstudio-agentic` to the provider-info registry surfaced by `relay providers list`.
3. **cmd-completion.ts:38** — shell completion for `--provider lmstudio-agentic`.
4. **cmd-init.ts:316,337** — `relay init` should suggest `lmstudio-agentic` when LM Studio is detected.
5. **contracts/delegate.ts:19** — extend delegate-protocol contract to mention `lmstudio-agentic` provider.
6. **Token watchdog (R12)** — cumulative token-budget cap across iterations to avoid context overflow when usage approaches model limit.
7. **Tool-call drift detector (R2 Tier-2)** — detect content-shaped tool calls in `content` field (Pythonic leak) and self-recover.
8. **Per-iteration timeout** — only relevant when tools beyond shell_exec (network fetch, MCP) ship in v0.3+.
9. **Stale doc cleanup** — `cmd-run.ts:11-12` header docstring still says "v0.1.0: codex, openrouter, lmstudio"; update to mention lmstudio-agentic.

## Known Stubs

None. All wired data flows are functional.

## Threat Flags

None. The new `--provider lmstudio-agentic` value enters the existing trust boundary
(workdir clamp + shell sandbox already in place). `shell_exec` is documented as accepting
the user's `task.workdir` shell-injection risk per PLAN §Tool Execution Sandbox Spec.

## Self-Check: PASSED

All claimed files exist, all commits exist in branch `worktree-agent-a4fcf22fd7bd25dd0`,
all 1189 tests pass on the final build.
