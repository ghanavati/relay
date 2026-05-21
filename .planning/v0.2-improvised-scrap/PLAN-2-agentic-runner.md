---
phase: v0.2
plan: 2
type: tdd
wave: 1
depends_on: []
files_modified:
  - src/workers/runner.ts                 # type union extension only
  - src/workers/types.ts                  # WorkerTask.tools, WorkerResult counters
  - src/workers/lmstudio-agentic.ts       # NEW (runner + tool loop)
  - src/workers/lmstudio-agentic.test.ts  # NEW (pure-fn + injected-fetch tests)
  - src/cli/cmd-run.ts                    # dispatch branch (line 72-74 area)
  - src/cli/cmd-parallel.ts               # dispatch branch (line 42-45 area)
  - docs/v0.2/agentic-runner.md           # NEW (usage + tool-spec doc)
autonomous: true
requirements: [ROADMAP-2]
must_haves:
  truths:
    - "Setting RELAY_LMSTUDIO_AGENTIC=1 on `relay run` with provider=lmstudio invokes the tool-loop runner"
    - "Worker performs ≤20 POST iterations and terminates on finish_reason='stop' OR loop-detector (3 consecutive identical name+args)"
    - "Worker executes shell-command tools in task.workdir with bounded timeout, never escaping cwd"
    - "WorkerResult.iterations and WorkerResult.tool_call_count populated for every termination path"
    - "Single-shot LmStudioRunner (src/workers/lmstudio.ts) remains untouched and continues to pass its existing test path"
    - "Live `qwen3-coder-next` invocation with a shell `bash` tool drives at least one tool call and returns 'hello' in the tool result"
  artifacts:
    - path: "src/workers/lmstudio-agentic.ts"
      provides: "LmStudioAgenticRunner class + buildLmStudioAgenticRequest pure fn + executeShellTool pure-ish fn"
      contains: "class LmStudioAgenticRunner implements WorkerRunner"
    - path: "src/workers/lmstudio-agentic.test.ts"
      provides: "node:test coverage ≥80% — pure-fn + injected fetch + injected shell exec"
    - path: "src/workers/runner.ts"
      provides: "ExecutionModel union with 'tool_loop' added"
      contains: "tool_loop"
    - path: "src/workers/types.ts"
      provides: "WorkerTask.tools?: ToolDef[], WorkerResult.iterations?, .tool_call_count?"
    - path: "docs/v0.2/agentic-runner.md"
      provides: "Usage doc + shell tool schema + opt-in env flag"
  key_links:
    - from: "src/cli/cmd-run.ts:72"
      to: "src/workers/lmstudio-agentic.ts"
      via: "shouldUseAgenticLmStudio(args, process.env) branch (env RELAY_LMSTUDIO_AGENTIC=1)"
      pattern: "LmStudioAgenticRunner"
    - from: "src/cli/cmd-parallel.ts:42"
      to: "src/workers/lmstudio-agentic.ts"
      via: "same opt-in env check inside getRunner('lmstudio')"
      pattern: "LmStudioAgenticRunner"
    - from: "src/workers/lmstudio-agentic.ts"
      to: "src/config/providers.ts"
      via: "getLmStudioEndpoint() + getLmStudioApiKey()"
      pattern: "getLmStudioEndpoint"
---

<objective>
Ship a tool-calling agentic LM Studio worker: `src/workers/lmstudio-agentic.ts`.
Class `LmStudioAgenticRunner implements WorkerRunner` with
`capabilities = { agentic: true, execution_model: "tool_loop" } as const`.
In-process loop against `/v1/chat/completions` with the OpenAI tools schema.
Shell-command tools only in v0.2 (Phase 1). In-process tool handlers deferred.

Purpose: unblock ROADMAP §3 (Figma) and any future local-model tool workflow.
Output: new worker file, type extensions, dispatch wiring, opt-in env flag,
test suite (node:test), usage doc.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@/Users/ghanavati/ai-stack/Projects/Relay/ROADMAP.md
@/Users/ghanavati/ai-stack/Projects/Relay/.planning/v0.2/ROADMAP-DRIFT.md
@/Users/ghanavati/ai-stack/Projects/Relay/.planning/v0.2/WORKERS-MAP.md
@/Users/ghanavati/ai-stack/Projects/Relay/.planning/v0.2/AGENTIC-WORKER-PATTERN.md
@/Users/ghanavati/ai-stack/Projects/Relay/.planning/v0.2/LMSTUDIO-TOOL-API.md
@/Users/ghanavati/ai-stack/Projects/Relay/src/workers/runner.ts
@/Users/ghanavati/ai-stack/Projects/Relay/src/workers/types.ts
@/Users/ghanavati/ai-stack/Projects/Relay/src/workers/codex.ts
@/Users/ghanavati/ai-stack/Projects/Relay/src/workers/codex.test.ts
@/Users/ghanavati/ai-stack/Projects/Relay/src/workers/lmstudio.ts
@/Users/ghanavati/ai-stack/Projects/Relay/src/workers/generic-http-runner.ts
@/Users/ghanavati/ai-stack/Projects/Relay/src/cli/cmd-run.ts
@/Users/ghanavati/ai-stack/Projects/Relay/src/cli/cmd-parallel.ts
@/Users/ghanavati/ai-stack/Projects/Relay/src/config/providers.ts
@/Users/ghanavati/ai-stack/Projects/Relay/src/errors.ts
</context>

## Goal

Deliver a new in-process tool-loop worker for LM Studio. Standalone class
(does NOT extend `GenericHttpRunner` — see Inheritance Decision below).
Opt-in via env `RELAY_LMSTUDIO_AGENTIC=1` keyed off the existing
`'lmstudio'` provider — no new `args.provider` value, no changes to
`cli.ts` / `cmd-completion.ts` / `cmd-init.ts` / `BUILTIN_PROVIDERS`.

Existing `LmStudioRunner` (single-shot, `src/workers/lmstudio.ts:31`)
stays untouched and remains the default.

## Inheritance Decision

**Standalone, not GenericHttpRunner subclass.** Justification:

- `GenericHttpRunner.run` (`src/workers/generic-http-runner.ts:29-138`)
  is a single-shot pipeline: build messages → one `fetch` → parse →
  return. Overriding `run` would discard ~100% of the base class.
- The agentic loop owns its own AbortController budget across N
  fetches — `GenericHttpRunner` makes one controller per `run`.
- Body builder, message stack, response handler, error mapping all
  differ. The only reusable pieces are `getLmStudioEndpoint` +
  `getLmStudioApiKey`, which are config helpers (already standalone).
- Test injection (constructor-fed `fetchImpl`) is cleaner without an
  inherited constructor that takes a `GenericHttpProviderConfig`.

Mirrors `AnthropicRunner` (`src/workers/anthropic.ts:9`) — a standalone
single-shot class that also does not extend `GenericHttpRunner`.

## Files to touch

| File | Lines (approx) | Change |
|---|---|---|
| `src/workers/runner.ts:5` | 1 line edit | extend `ExecutionModel` union: add `\| "tool_loop"` |
| `src/workers/types.ts:7-21` | +5 lines | add `tools?: ToolDef[]` to `WorkerTask`; export `ToolDef` |
| `src/workers/types.ts:23-37` | +2 lines | add `iterations?: number; tool_call_count?: number` to `WorkerResult` |
| `src/workers/lmstudio-agentic.ts` | NEW (~280 lines) | runner + pure builders + shell executor |
| `src/workers/lmstudio-agentic.test.ts` | NEW (~320 lines) | node:test + node:assert/strict |
| `src/cli/cmd-run.ts:72-74` | ~6 lines added | env-flag branch loads agentic runner |
| `src/cli/cmd-parallel.ts:42-45` | ~6 lines added | identical env-flag branch |
| `docs/v0.2/agentic-runner.md` | NEW (~120 lines) | usage + tool schema + opt-in flag |

No edits to: `src/workers/lmstudio.ts`, `src/workers/generic-http-runner.ts`,
`src/workers/anthropic.ts`, `src/workers/openrouter.ts`, `src/workers/codex.ts`,
`src/config/providers.ts`, `src/cli.ts`, `src/cli/cmd-init.ts`,
`src/cli/cmd-setup-llm.ts`, `src/cli/cmd-completion.ts`,
`src/cli/cmd-memory-auto-extract.ts`, `src/contracts/delegate.ts`.

## Tool execution model

**Shell-command tools only (v0.2 Phase 1).** In-process handler map deferred to Phase 2.

### Tool definition schema (what the user/caller declares in `WorkerTask.tools`)

OpenAI tool schema, function-type only. Two reserved tool names get
shell-exec treatment when present in the array:

| Reserved name | Required arg fields | Optional arg fields | Action |
|---|---|---|---|
| `shell_exec` | `command: string` | `cwd_relative?: string` (default `"."`), `stdin?: string`, `timeout_ms?: number` | Run `/bin/sh -c <command>` with `cwd = resolve(task.workdir, cwd_relative)` clamped under `task.workdir` |
| `bash` | `command: string` | same as above | Alias of `shell_exec` (Anthropic/Cline convention) |

All other `tool.function.name` values are rejected at request-build time
with `INVALID_ARGS`. Phase 2 will add `registerToolHandler(name, fn)`.

### Sandboxing approach

- **cwd:** `path.resolve(task.workdir, args.cwd_relative ?? ".")`.
  Reject (return tool-error message, do NOT throw) if the resolved
  path does not start with `path.resolve(task.workdir) + path.sep`
  or equal `task.workdir`. Pattern matches Relay's existing workdir
  clamp upstream of dispatch.
- **stdin:** pipe `args.stdin ?? ""` via `child.stdin.end(stdin)`.
- **per-tool timeout:** `min(args.timeout_ms ?? 30_000, remaining wall-clock budget)`.
  On SIGTERM expiry, append tool result `"ERROR: tool timed out after Nms"`
  and continue loop (do NOT abort whole worker).
- **env:** inherit `process.env` minus `RELAY_*` opt-in flags (preserve
  user PATH / NODE_OPTIONS — same posture as `codex.ts:435`).
- **output:** combined `stdout + stderr`, truncated to 32KB per tool call
  with `…[truncated]` marker. Echoed verbatim as the `role:"tool"` content.
- **exit code:** appended as `\n[exit_code: N]` line in tool result.

### Pure-function seam for testing

```ts
export type ShellExecFn = (
  argv: string[],
  opts: { cwd: string; stdin: string; timeout_ms: number; env: NodeJS.ProcessEnv }
) => Promise<{ stdout: string; stderr: string; exit_code: number | null; timed_out: boolean }>;
```

Default impl wraps `node:child_process.execFile('/bin/sh', ['-c', cmd], opts)`;
test impl is injected via constructor. Mirrors codex.test.ts's `writer`/`pathBuilder` injection (`codex.test.ts:36-46`).

## Task breakdown (TDD strict — RED → GREEN → IMPROVE)

### T1: Type union extension (~5 min)

| | |
|---|---|
| Files | `src/workers/runner.ts:5`, `src/workers/types.ts:7-37` |
| Deps | none |
| RED test | `src/workers/lmstudio-agentic.test.ts` — `test('capabilities declares tool_loop execution_model')`: `import { LmStudioAgenticRunner }`; `assert.deepEqual(new LmStudioAgenticRunner().capabilities, { agentic: true, execution_model: 'tool_loop' })`. Compile fails: type union missing. |
| GREEN | Append `\| "tool_loop"` to `ExecutionModel` (`runner.ts:5`). Add `tools?: ToolDef[]` to `WorkerTask` (`types.ts:21`); define + export `ToolDef`, `ToolFunctionDef`, `ToolCall`, `ToolCallMessage` interfaces (OpenAI schema). Add `iterations?: number; tool_call_count?: number` to `WorkerResult` (`types.ts:36-37`). |
| IMPROVE | Document each new field with one-line `//` comment. |

### T2: Worker class skeleton + initial-request builder (~25 min, ~25% context)

| | |
|---|---|
| Files | `src/workers/lmstudio-agentic.ts` (new) |
| Deps | T1 |
| RED test 1 | `test('buildInitialMessages with contextPrefix produces [system, user]')`: assert two-element array, system content equals contextPrefix. |
| RED test 2 | `test('buildInitialMessages without contextPrefix produces [user]')`: assert one-element array. |
| RED test 3 | `test('buildRequestBody includes model, messages, tools, stream:false, tool_choice:auto')`: assert exact body shape. |
| RED test 4 | `test('LmStudioAgenticRunner.run rejects missing model with INVALID_ARGS')`: stub fetchImpl, assert `result.status === 'error' && result.error.code === 'INVALID_ARGS'`, fetch never called. |
| GREEN | Implement: file header w/ LMSTUDIO-TOOL-API.md citation + `https://lmstudio.ai/docs/developer/openai-compat/tools`. Constructor `constructor(deps: { fetchImpl?, shellExec?, maxIterations?: number } = {})` with defaults `globalThis.fetch`, `defaultShellExec`, `20`. Export pure fns: `buildInitialMessages(task)`, `buildRequestBody(task, messages)`. Implement `run(task)` with model-check return-early. |
| IMPROVE | Extract `RESERVED_TOOL_NAMES = new Set(['shell_exec', 'bash'])`. Add JSDoc. |

### T3: Tool execution (pure-fn shell exec) (~30 min, ~25% context)

| | |
|---|---|
| Files | `src/workers/lmstudio-agentic.ts` (extend), `src/workers/lmstudio-agentic.test.ts` (extend) |
| Deps | T2 |
| RED test 1 | `test('executeShellTool runs command in workdir, returns stdout')`: inject mock shellExec returning `{stdout:'hello\n', stderr:'', exit_code:0, timed_out:false}`, assert tool-result string contains `hello`. |
| RED test 2 | `test('executeShellTool rejects cwd_relative escaping workdir')`: args `{command:'pwd', cwd_relative:'../../etc'}`, assert returns error-shaped tool result, shellExec never called. |
| RED test 3 | `test('executeShellTool truncates output >32KB with marker')`: mock 40KB stdout, assert returned string length ≤ 32_768 + marker length and ends with `…[truncated]`. |
| RED test 4 | `test('executeShellTool with timed_out:true returns timeout marker, does not throw')`. |
| RED test 5 | `test('executeShellTool rejects non-reserved tool name with structured error result')`: tool name `'fake_tool'` → result contains `ERROR: unsupported tool name`. |
| RED test 6 | `test('parseToolCallArguments returns ERROR result on malformed JSON, does not throw')`. |
| GREEN | Implement `parseToolCallArguments(tc)`, `executeShellTool(tc, task, shellExec)`, `defaultShellExec()` (wraps `execFile`). All return shaped `{ role:'tool', tool_call_id, content: string }` — never throw. |
| IMPROVE | Centralize 32KB truncation constant `MAX_TOOL_OUTPUT_BYTES`. |

### T4: Main loop + iteration cap + wall-clock timeout (~35 min, ~30% context)

| | |
|---|---|
| Files | `src/workers/lmstudio-agentic.ts` (extend), `src/workers/lmstudio-agentic.test.ts` (extend) |
| Deps | T2, T3 |
| RED test 1 | `test('terminal response (finish_reason:stop) → 1 POST, iterations===1, output is content')`: fetchImpl returns finalResponse('done'); assert. |
| RED test 2 | `test('one tool call then final → 2 POSTs, tool_call_count===1, second messages[] includes role:tool with matching tool_call_id')`: capture both `fetch` calls; inspect second-call body. |
| RED test 3 | `test('iteration cap fires at maxIterations=3 when fetchImpl always returns tool_calls')`: pass `maxIterations:3`; assert `status:'error'`, `error.code === 'UNSUPPORTED'`, `iterations===3`. |
| RED test 4 | `test('wall-clock timeout returns status:timeout with TIMEOUT (retryable)')`: fetchImpl rejects with AbortError after small delay; pass `timeout_ms:50`; assert `status:'timeout'`, `error.code==='TIMEOUT'`, `error.retryable===true`. |
| RED test 5 | `test('HTTP 500 from LM Studio → PROVIDER_ERROR retryable')`. |
| RED test 6 | `test('usage tokens summed across iterations')`: two responses with usage `{prompt_tokens:10,completion_tokens:5}` and `{prompt_tokens:12,completion_tokens:8}`; assert `result.prompt_tokens===22`, `completion_tokens===13`, `token_usage===13`. |
| RED test 7 | `test('parallel tool_calls in one turn → all executed before next POST')`: assistant msg with two tool_calls; assert shellExec called twice; assert next request body has 2 role:tool messages. |
| RED test 8 | `test('tool exec throw appended as ERROR tool result; loop continues')`: shellExec throws on first call; assert next request body includes `{role:'tool', content:'ERROR: ...'}`; assert loop terminates on subsequent final response. |
| GREEN | Implement loop: shared `AbortController` keyed off `task.timeout_ms`; per-iteration: build body, `fetch(url, {signal})`, parse, branch on `tool_calls`, execute all in `Promise.all`, append, increment counters. Mirror error-code mapping from `codex.ts:573-603` (status enum + `makeError` calls). |
| IMPROVE | Extract `executeToolCalls(tcs, task, shellExec)` helper. Add inline comment citing LMSTUDIO-TOOL-API.md §"Tool result message — required fields". |

### T5: Loop detector (~15 min, ~10% context)

| | |
|---|---|
| Files | `src/workers/lmstudio-agentic.ts` (extend), `src/workers/lmstudio-agentic.test.ts` (extend) |
| Deps | T4 |
| RED test 1 | `test('loop detector: 3 consecutive identical (name+args) tool calls → status:error UNSUPPORTED with stuck-in-loop message')`: fetchImpl returns the same tool_call payload 3 times; assert `status:'error'`, `error.message.includes('loop')`, `iterations===3`. |
| RED test 2 | `test('loop detector resets when args differ')`: identical name but different args twice; assert loop continues past 2 calls (does NOT trip). |
| RED test 3 | `test('loop detector hashes name+args, ignoring tool_call_id')`: same payload with different `id` values 3 times → still trips. |
| GREEN | Maintain `recentCallHashes: string[]` (length 3) across iterations. Hash = `name + ':' + canonicalStringify(parsedArgs)`. On 3 consecutive matches → `makeError('UNSUPPORTED', 'stuck in loop: repeated tool call', false)`, return. Use `canonicalStringify` (recursive key-sort) to defeat JSON key-order noise. |
| IMPROVE | Constant `LOOP_DETECTOR_WINDOW = 3`. JSDoc cites LMSTUDIO-TOOL-API.md §"Model loops". |

### T6: Dispatch wiring + opt-in env flag (~10 min, ~10% context)

| | |
|---|---|
| Files | `src/cli/cmd-run.ts:72-74`, `src/cli/cmd-parallel.ts:42-45`, `src/workers/lmstudio-agentic.ts` (export helper) |
| Deps | T2 |
| RED test 1 | New unit test in `src/workers/lmstudio-agentic.test.ts`: `test('shouldUseAgenticLmStudio returns true when env.RELAY_LMSTUDIO_AGENTIC===\"1\"')` — and false for `''`, `'0'`, `'false'`, undefined. |
| RED test 2 | (manual integration acceptance — covered by Runtime validation block) |
| GREEN | Export `shouldUseAgenticLmStudio(env: NodeJS.ProcessEnv): boolean` from `lmstudio-agentic.ts`. Edit `cmd-run.ts:72-74`: wrap existing branch with `if (shouldUseAgenticLmStudio(process.env)) { const {LmStudioAgenticRunner}=await import('../workers/lmstudio-agentic.js'); runner=new LmStudioAgenticRunner(); } else { ...existing... }`. Mirror in `cmd-parallel.ts:42-45`. |
| IMPROVE | Single shared import path. No duplication of branch logic — only the helper. |

### T7: Integration test against ephemeral HTTP server (~20 min, ~15% context)

| | |
|---|---|
| Files | `src/workers/lmstudio-agentic.test.ts` (extend) |
| Deps | T1-T6 |
| RED test 1 | `test('integration: ephemeral server drives 2-turn shell tool loop')`: spin `http.createServer` on `:0`, point runner at it via env (override `LMSTUDIO_ENDPOINT`), serve scripted responses (turn 1: tool_call to `shell_exec` with `echo hello`; turn 2: final `"done"`). Inject real `defaultShellExec`. Assert `result.status==='success'`, `result.output==='done'`, `result.iterations===2`, `result.tool_call_count===1`. |
| RED test 2 | `test('integration: server returns 503 on first call → PROVIDER_ERROR retryable, no second call')`. |
| GREEN | (already implemented by T2-T5; T7 just exercises wiring) |
| IMPROVE | Wrap server `setup/teardown` in `before`/`after` hooks for clean shutdown; `unref()` listener so test process exits cleanly. |

### T8: Docs (~10 min, ~5% context)

| | |
|---|---|
| Files | `docs/v0.2/agentic-runner.md` (new) |
| Deps | T1-T7 |
| RED test | none (docs) |
| GREEN | Write: overview, opt-in env flag, tool schema with `shell_exec`/`bash` examples, sandboxing notes, known-issue callouts (LFM2 Pythonic, Gemma 4 MLX empty tool_calls, Qwen3-Coder loop on 30B variant — all cited from LMSTUDIO-TOOL-API.md), end-to-end `lms load` + `relay run` walkthrough. |
| IMPROVE | Link from `ROADMAP.md` §2 to this doc; add `## See also` cross-link to LMSTUDIO-TOOL-API.md research artifact. |

## Acceptance criteria

- [ ] `npm test` passes — existing 972+ test count rises by ~25 (T2-T7 cases), zero regressions
- [ ] `npm run typecheck` (or `tsc --noEmit`) passes — `ExecutionModel` union accepts `"tool_loop"`
- [ ] `npm run lint` passes — no `console.log` introduced; no `any`
- [ ] Coverage of `src/workers/lmstudio-agentic.ts` ≥80% (lines + branches) measured via `c8`/existing harness
- [ ] `src/workers/lmstudio.ts` is byte-identical to its current state (single-shot path untouched)
- [ ] `src/cli/cmd-run.ts` and `src/cli/cmd-parallel.ts` retain identical behavior when `RELAY_LMSTUDIO_AGENTIC` is unset
- [ ] **Concrete runtime test:** with `qwen/qwen3-coder-next` loaded in LM Studio, running the Runtime validation block below returns `result.iterations >= 2`, `result.tool_call_count >= 1`, tool result contains `hello`, final `result.output` is the model's natural-language acknowledgement (non-empty)
- [ ] Loop detector fires when fed the contrived three-identical-call fixture (T5 covers; manual reproduce optional)
- [ ] `WorkerResult.iterations` and `WorkerResult.tool_call_count` populated on every termination path (success, timeout, iteration-cap, loop-detector, HTTP-error)
- [ ] Docs at `docs/v0.2/agentic-runner.md` exist; walkthrough copy-pasteable

## Runtime validation

```bash
# 1. Confirm LM Studio is up and load the recommended driver
lms server start
lms load qwen/qwen3-coder-next   # 80B-A3B MoE, native tool training (LMSTUDIO-TOOL-API.md §Loaded Models)

# 2. Capability probe — verify "tool_use" in model capabilities
curl -s http://localhost:1234/api/v0/models | jq '.data[] | select(.id=="qwen/qwen3-coder-next") | .capabilities'

# 3. Smoke-test via the dispatch path (not the worker directly)
export RELAY_LMSTUDIO_AGENTIC=1
mkdir -p /tmp/relay-agentic-smoke
cd /tmp/relay-agentic-smoke

# Drive a tool call via a tiny inline harness (tools come from caller, not CLI yet).
# For v0.2 the canonical entry is programmatic — wire CLI tools arg in a follow-up.
node --input-type=module -e '
import { LmStudioAgenticRunner } from "/Users/ghanavati/ai-stack/Projects/Relay/dist/workers/lmstudio-agentic.js";
const r = new LmStudioAgenticRunner();
const result = await r.run({
  task: "Use the shell_exec tool to run `echo hello`, then report what it printed.",
  workdir: "/tmp/relay-agentic-smoke",
  timeout_ms: 60000,
  model: "qwen/qwen3-coder-next",
  run_id: "smoke-1",
  provider: "lmstudio",
  tools: [{
    type: "function",
    function: {
      name: "shell_exec",
      description: "Run a shell command in the workdir and return combined stdout+stderr.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"]
      }
    }
  }],
});
console.error(JSON.stringify({
  status: result.status,
  iterations: result.iterations,
  tool_call_count: result.tool_call_count,
  output: result.output,
}, null, 2));
'
# Expect:
#   status:           "success"
#   iterations:       2 (or 3 with a brief recap turn)
#   tool_call_count:  >=1
#   output:           model acknowledges "hello"
```

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| LM Studio model not loaded → 400/404 from `/v1/chat/completions` | HIGH | First-iteration HTTP error returns `PROVIDER_ERROR` (retryable). Doc tells user to `lms load <id>` first. Optional Phase-2 pre-flight `GET /api/v0/models` check. |
| Malformed `tool_calls` JSON (LFM2 Pythonic, Gemma 4 MLX bug) | MEDIUM (model-dependent) | Per LMSTUDIO-TOOL-API.md §Error Modes: detect `content` with `tool_calls`-shaped patterns but empty `tool_calls[]` → loop ends as "stop", surfaces in output. User can retry with stricter system prompt or different model. Doc warns. |
| Invalid `function.arguments` JSON (well-formed `tool_calls`, broken inner JSON) | MEDIUM | `parseToolCallArguments` catches; appends `role:'tool'` content = `"ERROR: arguments not valid JSON: <msg>"` with matching `tool_call_id`. Model self-corrects on next turn. Covered by T3 test #6. |
| Infinite loop (model repeats same tool with same args) | MEDIUM | Two-layer defense: 20-iteration cap (T4) + 3-consecutive-identical loop detector (T5). Both return `UNSUPPORTED` non-retryable. |
| Wall-clock timeout exhausts mid-iteration | HIGH | Shared `AbortController` keyed to `task.timeout_ms`; `fetch` honors signal. Returns `WorkerResult{status:'timeout', error:TIMEOUT(retryable)}` mirroring `codex.ts:573-583`. Per-tool timeout capped at `min(args.timeout_ms ?? 30s, remaining budget)`. |
| Streaming chunk drops (parallel tool-call accumulation bug pre-v0.3.18) | LOW (we use `stream:false`) | Deferred. v0.2 sets `stream: false` in request body (LMSTUDIO-TOOL-API.md §Streaming). Streaming work tracked for a future plan. |
| `shell_exec` escapes workdir via crafted `cwd_relative` | LOW | T3 test #2: `path.resolve` + prefix-check; rejected as tool error result, never executed. |
| `shell_exec` consumes whole context with multi-MB stdout (e.g. `find /`) | MEDIUM | 32KB truncation per tool result (T3 test #3). Marker `…[truncated]` documents the cut. Cumulative token usage tracked from response `.usage`. |
| `qwen3-coder-next` not loaded by user → smoke-test fails | HIGH (env-dependent) | Doc lists fallback models with `tool_use` capability (GLM-4.7, Qwen3-Coder-30B). Runtime block has explicit `lms load` step. |
| Existing single-shot LM Studio test suite regresses (auto-extract path) | LOW | Plan changes zero behavior of `lmstudio.ts` / `auto-extract-runner.ts`. CI catches regression. |
| Test stability — node:test concurrency races on ephemeral HTTP server | LOW | T7 uses `port: 0` + `before`/`after` cleanup with `server.close(done)`. Standard node:test pattern. |
| Dispatch env-flag opt-in misses parallel path | MEDIUM | T6 explicitly modifies both `cmd-run.ts:72-74` AND `cmd-parallel.ts:42-45`. Single helper `shouldUseAgenticLmStudio` exported from `lmstudio-agentic.ts` ensures parity. |

## What this plan deliberately omits

- Streaming (`stream:true`) — deferred (LMSTUDIO-TOOL-API.md §Streaming)
- In-process tool handler registry (`registerToolHandler(name, fn)`) — Phase 2
- Capability pre-flight (`GET /api/v0/models` filter on `"tool_use"`) — Phase 2, would couple to dispatch
- CLI flag `--tools <json>` to pass tools through `relay run` — follow-up plan; v0.2 entry is programmatic only
- Named-tool `tool_choice` (`{type:"function", function:{name:...}}`) — assumption A1 in LMSTUDIO-TOOL-API.md is untested on MLX; default `"auto"` only
- `thinking_blocks` counter — LM Studio chat-completions has no equivalent signal (AGENTIC-WORKER-PATTERN.md §5)
- Anthropic agentic runner (`src/workers/anthropic.ts`) — separate plan
- Figma tool set (ROADMAP §3) — depends on this plan; separate

## Constraints honored

- **NO Codex.** Pure CC plan; no `type="codex"` task.
- **TDD strict** (RED → GREEN → IMPROVE every task) — coverage target ≥80% on the new file.
- **Pure-function injection seam** for `fetchImpl` and `shellExec` (mirrors `codex.test.ts:36-46` writer/pathBuilder pattern).
- **Tests live at `src/workers/lmstudio-agentic.test.ts`** (NOT in `__tests__/` — repo convention per `src/workers/codex.test.ts`).
- **`node:test` + `node:assert/strict`** (no vitest, no jest).
- **`stream: false`** for v0.2.
- **Additive only** — `src/workers/lmstudio.ts` untouched; existing tests pass unchanged.

<verification>
Per-task `<verify>` lives in each T# row above. End-of-plan:
- `npm test` clean (972+ baseline holds, ~25 new tests added)
- `npm run typecheck` clean
- `npm run lint` clean
- Coverage report shows ≥80% on `src/workers/lmstudio-agentic.ts`
- Runtime validation block produces expected output against live `qwen3-coder-next`
</verification>

<success_criteria>
All acceptance-criteria boxes checked. Both single-shot LM Studio path (default)
and agentic path (`RELAY_LMSTUDIO_AGENTIC=1`) work end-to-end. Loop detector
demonstrably fires on contrived fixture. WorkerResult schema extension is
backward-compatible (new fields optional). ROADMAP §2 status changes from `[ ]`
to `[x]`; ROADMAP §3 (Figma) is now unblocked.
</success_criteria>

<output>
After completion, create `.planning/v0.2/v0.2-2-SUMMARY.md` capturing:
- Final file list with line deltas
- Test count added vs baseline
- Coverage percent on new worker file
- Live qwen3-coder-next smoke-test transcript (commands + redacted output)
- Any deferred items moved to follow-up plans (with file:line references)
- Lessons learned written to `tasks/lessons.md` per global CLAUDE.md rule
</output>
