# Phase 3 PLAN.md — Verification

## Verdict: **PASS WITH 2 MINOR WARNINGS**

The plan is execution-ready. All 5 ROADMAP success criteria are traced to concrete tasks, all 6 AGENTIC REQ-IDs are mapped, preconditions verified against live source, risk register is comprehensive, and scope is bounded. Two non-blocking issues noted below.

## Coverage Matrix — ROADMAP Phase 3 Success Criteria

| # | ROADMAP Criterion | Plan Tasks | Status |
|---|---|---|---|
| 1 | Multi-iteration tool-call loop; `tool_call_count` + `iterations` populated | T2, T4 (case 1, 2, 6), T8 | COVERED |
| 2 | LOOP_DETECTED at 3 consecutive identical hashes (before iter 20) | T5 (cases 1-4); T5 case 2 explicitly asserts abort before 4th POST | COVERED |
| 3 | LFM2 JSON nudge via `liquid/lfm2-*` regex injection | T6 (cases 1-4); regex `/^liquid\/lfm2-/i` | COVERED |
| 4 | `shell_exec`/`bash` cwd-clamp + 32KB truncation | T3 (cases 3-6) + sandbox spec §"CWD clamp" + §"32KB truncation" | COVERED |
| 5 | `relay parallel` accepts `lmstudio-agentic`; `tool_loop` in ExecutionModel | T1 (literal), T7 (parallel smoke); runner.ts:6 verified present | COVERED |

## REQ-ID Coverage (AGENTIC-01..06)

| REQ-ID | Requirement | Plan Tasks | Status |
|---|---|---|---|
| AGENTIC-01 | tool_call → execute → append loop until final answer or max iter | T2, T4 (loop impl), T8 (integration) | COVERED |
| AGENTIC-02 | Max iter 20 + hash-based loop detector (3 consecutive) | T4 case 3 (cap), T5 (hash detector) | COVERED |
| AGENTIC-03 | `shell_exec`/`bash`; cwd clamp to workdir; 32KB truncation; never outside workdir | T3 cases 3-6 + sandbox spec | COVERED |
| AGENTIC-04 | Dispatch wired in cmd-run.ts + cmd-parallel.ts; `--provider lmstudio-agentic` | T1, T7 + frontmatter files_modified | COVERED |
| AGENTIC-05 | WorkerResult includes `tool_call_count` + `iterations`; `"tool_loop"` in runner.ts | T1 (verify-only), T4 (populates), runner.ts:6 confirmed | COVERED |
| AGENTIC-06 | LFM2 nudge when model matches `liquid/lfm2-*` | T6 (4 cases) | COVERED |

## Precondition Verification (planner's verify-only claims)

| Claim | Evidence (read against live source) | Status |
|---|---|---|
| `runner.ts:6` has `"tool_loop"` in ExecutionModel union | Confirmed line 6: `export type ExecutionModel = "relay-loop" \| "subprocess" \| "tool_loop";` | TRUE |
| `types.ts:7-47` declares ToolDef/ToolCall/ToolCallMessage/WorkerTask.tools | Confirmed lines 7-47 (incl. line 47: `tools?: ToolDef[]`) | TRUE |
| `types.ts:68-69` declares WorkerResult.iterations + tool_call_count | Confirmed lines 68-69 | TRUE |
| `cmd-run.ts:20,28` are correct edit sites (union + HTTP_PROVIDERS) | Confirmed: line 20 union present; line 28 `HTTP_PROVIDERS = new Set([...])` | TRUE |
| `cmd-run.ts:72-91` is correct dispatch insertion region | Confirmed: lmstudio branch at 72-74, exhaustive check at 82-83 | TRUE |
| `cmd-parallel.ts:20,37-55,105` are correct edit sites | Confirmed: SpecTask union at 20, getRunner at 37-55, validProviders at 105, httpProviders at 106 | TRUE |

## Risk Coverage (vs. user's mandatory list)

| Required Risk | Covered? | Where |
|---|---|---|
| model-not-loaded | YES | R1 (capability pre-check T4 case 7) |
| malformed tool_calls | YES | R2 (LFM2 nudge + acknowledged drift Tier-2 deferral) |
| infinite loop | YES | R3 (iter cap T4 case 3 + hash detector T5) |
| stream drops | YES | R4 (stream:false hard-coded; no SSE) |
| LFM2 Pythonic | YES | R5 (nudge regex `/^liquid\/lfm2-/i`) |
| GLM hidden preset | PARTIAL | R6 (acknowledged out-of-scope; deferred to debug-dump follow-up) |
| tool_call_id mismatch | YES | R7 (T3 case 7 + T8 byte-exact assertion on numeric + UUID) |
| cwd escape | YES | R10 (T3 case 5; passthrough zod schema; explicit drop) |

All 8 mandatory risks addressed. R6 deferred with documented mitigation (recommend qwen3-coder-next as default) — accepted scope cut.

## Other Verified Constraints

- `stream: false` hard-coded for v0.2 → T4 GREEN step 6 body literal, R4
- No `GenericHttpRunner` subclass → standalone justified in plan §Goal (line 65) with concrete reuse-vs-override tradeoff
- No touch on `src/memory/*` or `src/cli/cmd-budget.ts` → frontmatter files_modified excludes both; §Out-of-scope (line 91) explicit
- Hash spec: `sha256(name + '\x00' + canonicalJsonStringify(args))` with key-order independence → T5 RED case 1 + GREEN canonical helper
- Shell exec sandbox: cwd clamp (always `task.workdir`) + 32KB byte-safe truncation + workdir-only → T3 cases 4-6 + sandbox spec §369-417
- Test pattern (fetchImpl + shellExec constructor seams mirroring codex.test.ts) → T2 GREEN constructor opts `{ fetchImpl?, shellExec?, maxIterations? }`; T3-T8 inject both
- Integration test uses `qwen/qwen3-coder-next` → T8 case 1 fixture
- Dispatch wired in cmd-run.ts AND cmd-parallel.ts → T1 + T7
- WorkerResult populates `iterations` + `tool_call_count` → T4 cases 1, 2, 6

## Gaps (warnings — non-blocking)

### W1 — Integration test does NOT use `lms load` per user prompt
User prompt requires: "Integration test uses qwen3-coder-next via `lms load`". Plan T8 uses an **ephemeral in-process http.createServer** with mocked responses — does NOT invoke `lms load` or hit real LM Studio. The §Runtime Validation block (line 318) mentions `lms load` only as a manual pre-step for the smoke command, not in any automated test. **Impact:** lower confidence that the runner survives real LM Studio quirks. **Mitigation already in plan:** §Runtime Validation manual smoke commands cover this path. **Recommendation:** Either (a) accept as-is (manual smoke is sufficient for v0.2 since automated `lms load` would couple CI to a 14GB model), or (b) add an OPT-IN integration test gated on `RELAY_LMSTUDIO_LIVE=1` env that runs `lms load qwen/qwen3-coder-next` then hits real `localhost:1234`.

### W2 — Hash detector spec uses combined-turn fingerprint, not per-call hash
REQ AGENTIC-02 reads "hash of `name+args`, abort on 3 consecutive matches". Plan T5 case 4 reframes this as a **combined-turn fingerprint** (sorted concat of all tool-call hashes per turn) to handle parallel tool_calls. This is a defensible interpretation (parallel calls within one assistant turn should count as one signature), but it's a spec extension not literally in REQ AGENTIC-02. **Recommendation:** Acceptable; the per-turn fingerprint subsumes single-call behavior (1 call per turn → fingerprint == single hash). Document this interpretation explicitly in the plan's §"Hash detector" section to avoid reviewer ambiguity.

## Recommendations

1. **Proceed to execute.** Plan is structurally sound, all REQ-IDs covered, preconditions verified, scope bounded (8 tasks, ~830 LoC across 2 new files + 4 line-level edits in 2 existing files — within budget).
2. **Address W1 before merge:** add a one-line note to T8 clarifying why automated test mocks the HTTP server rather than invoking `lms load` (CI portability).
3. **Address W2 in code:** add an inline comment in the T5 GREEN implementation explaining the parallel-tool-call fingerprint design, citing REQ AGENTIC-02.
4. **Honor the SUMMARY.md output (line 430)** — must list the 5 follow-up items (debug-dump, BUILTIN_PROVIDERS, cli.ts/cmd-completion.ts, token watchdog R12, drift detector R2) so they reach the v0.2.x backlog.

