# Agentic Worker Pattern — Today (codex.ts) and Next (lmstudio-agentic.ts)

Source: `src/workers/codex.ts` (657 lines), `src/workers/codex.test.ts`, `src/workers/types.ts`,
`src/workers/runner.ts`, `src/workers/lmstudio.ts`, `src/workers/generic-http-runner.ts`,
`src/errors.ts`, `ROADMAP.md §2`.

Note: user prompt cites `src/workers/__tests__/codex*.test.ts`; actual file is
`src/workers/codex.test.ts` (no `__tests__` folder). Analysis uses that file.

---

## 1. How codex.ts structures subprocess execution

Codex is not an in-process tool loop — it shells out to `codex exec --json` and the loop runs
inside the Codex CLI. Relay observes via JSONL stdout.

**Pipeline:**

1. `runCodexWorker(task)` (line 397) — entrypoint.
2. `getCodexCliCapabilities(codexBin)` (line 149) — version-cached probe of `--help` and
   `exec --help` to discover flag positions (legacy fallback at line 74).
3. `buildCodexInvocation(task, env, capabilities, writer, pathBuilder)` (line 184) — **pure
   function**, fully injectable, returns `{ args, envAdditions, tempFiles }`. Throws on
   incompatible flag combinations (line 211).
4. Context prefix injection (line 300): writes `task.contextPrefix` to a unique tempfile
   (`pid-counter` collision guard, line 56) and passes via `-c model_instructions_file=<path>`
   using TOML-safe quoting (`JSON.stringify`, line 355). Tracked in `invocation.tempFiles`
   for `finally`-block cleanup (line 636).
5. `spawn(codexBin, args, { stdio: ['pipe','pipe','pipe'], env: {...process.env, ...envAdditions}, detached: true })`
   (line 435). `child.unref()` (line 443) so daemon parent can exit independently.
6. JSONL parsing per stdout line via `parseCodexLine(line)` (line 163) — extracts
   `item.completed → agent_message → text`. Buffered split-on-newline pattern at line 487.
7. Behavioral counters built inline (`countBlockType`, line 461): `thinking_blocks`,
   `tool_use_blocks`, `toolCallNames[]`, `fileReadsBeforeFirstWrite`, `toolRetryCount`. These
   score Codex behavior *post-hoc* — Relay does not steer the loop.

**Solo-Relay slim no-ops** (lines 14–25): `registerPid`, `injectCompressWrappers`, etc. —
stubs kept to preserve dispatch shape from parent `relay-mcp`. New workers ignore them.

---

## 2. Error handling pattern

Three failure sources, four exit paths, all return `WorkerResult` (never throw):

| Path | Trigger | Handler | Status | exit_code |
|------|---------|---------|--------|-----------|
| Build-args throw | `buildCodexInvocation` throws | try/catch at line 403 | `error` + `INVALID_ARGS` (non-retryable) | `null` |
| Spawn error | `child.on("error")` (binary missing, EACCES) | line 607 | `error` + `BINARY_NOT_FOUND` (non-retryable) | `null` |
| Non-zero exit | `child.on("close", code)` with `code !== 0` | line 585 | `error` + `CODEX_ERROR` (non-retryable) | propagated `code` |
| Timeout | `setTimeout(..., task.timeout_ms)` fires (line 520) | `timedOut=true`, SIGTERM process *group*, SIGKILL after 5s (line 523) | `timeout` + `TIMEOUT` (retryable) | `null` |
| Success | `code === 0`, no timeout | line 597 | `success` | `0` |

**stderr** (line 502): if `task.onStderr` set, forward; else write to `process.stderr`. Never
captured into `WorkerResult.output` — that field is reserved for parsed agent messages.

**Error factory:** `makeError(code, message, retryable, feature?)` from `src/errors.ts:49`.
Worker-relevant codes: `TIMEOUT`, `BINARY_NOT_FOUND`, `INVALID_ARGS`, `PROVIDER_ERROR`,
`CODEX_ERROR`, `UNSUPPORTED`. No `LMSTUDIO_ERROR` — reuse `PROVIDER_ERROR`.

**Cleanup** (`.finally`, line 632): runs regardless of resolve path. Removes wrapper injection
dir + every path in `invocation.tempFiles`. `unlink` failures log to stderr but do not abort.

---

## 3. Timeout / iteration pattern

Codex has **no iteration cap** — only wall-clock `task.timeout_ms`:

```
setTimeout → SIGTERM process group → wait 5s → SIGKILL if !processExited
```

Both handles cleared on `close` and `error` (lines 535, 609). `killGroup` (line 515) uses
`process.kill(-child.pid, signal)` — kills the entire group set up by `detached: true`.

**For a tool-loop worker, need BOTH** — wall-clock timeout (AbortController, see
`generic-http-runner.ts:72`) **and** iteration cap (default 20, ROADMAP §2), guarded per
iteration.

---

## 4. Capabilities declaration shape

```typescript
// src/workers/codex.ts:650-656
export class CodexRunner implements WorkerRunner {
  readonly capabilities = { agentic: true, execution_model: "subprocess" } as const;
  run(task: WorkerTask): Promise<WorkerResult> { return runCodexWorker(task); }
}
```

`WorkerCapabilities` (`runner.ts:7`):

```typescript
interface WorkerCapabilities {
  agentic: boolean;
  integrationLevel?: "callable" | "status" | "full";
  adapterType?: "openclaw" | "process" | "http";
  execution_model?: "relay-loop" | "subprocess";
}
```

**Discrepancy:** type union does **not** include `"tool_loop"` — extending it is a precondition.

---

## 5. WorkerResult fields populated

`WorkerResult` (`types.ts:23`):

| Field | Required | Codex populates | Notes |
|-------|----------|-----------------|-------|
| `status` | yes | `success` / `error` / `timeout` | always |
| `output` | yes | joined `agentMessages` (`\n` sep) | empty on spawn-error path |
| `duration_ms` | yes | `Date.now() - startTime` | always |
| `exit_code` | yes | child exit code or `null` | `null` on timeout / spawn-error / INVALID_ARGS |
| `error` | optional | `RelayError` | only on non-success |
| `thinking_blocks` | optional | counter from JSONL `content_block_start.thinking` | success+error+timeout |
| `tool_use_blocks` | optional | counter from JSONL `content_block_start.tool_use` | success+error+timeout |
| `file_reads_before_first_write` | optional | sentinel + tool-name match | only when tool_use blocks observed |
| `tool_retry_count` | optional | consecutive same-name counter | only when `> 0` |
| `token_usage` / `prompt_tokens` / `completion_tokens` / `cost_usd` | optional | **not populated** | Codex CLI does not expose usage in JSONL |

---

## 6. Tests — assertion style, fixtures, mocking

File: `src/workers/codex.test.ts` (186 lines). Only covers `buildCodexInvocation` — the pure
function. Async spawn path is integration-tested elsewhere.

**Style:** `node:test` + `node:assert/strict`. `describe(...)` groups; `test(...)` cases. No
vitest, no jest.

**Fixtures:** `baseTask(overrides)` helper (line 22) returns `Pick<WorkerTask, ...>` with
defaults `{ workdir: '/tmp/work', task: 'do something', run_id: 'test-run-1' }`.

**Mocking strategy:** Constructor/argument injection. Two seams:

```typescript
function makeWriter(): { writer: TempFileWriter; calls: WriteCall[] }  // line 36 — records writes
function fixedPathBuilder(path: string): TempPathBuilder               // line 44 — deterministic path
```

No `vi.mock`, no `sinon`, no `fs` patching. Pure function takes `writer` + `pathBuilder` as
last two args (defaults are `defaultTempFileWriter` / `defaultTempPathBuilder`).

**Assertion patterns:**
- Argument absence: `assert.ok(!result.args.some(a => a.startsWith('model_instructions_file=')))`
- Argument exact value: `assert.equal(miFlag, 'model_instructions_file="<path>"')`
- Argument pairing: find value index, check `args[idx - 1] === '-c'`
- Argument ordering: assert `valIdx < execIdx` (global vs exec args)
- Writer call count + payload: `assert.equal(calls.length, 1); assert.equal(calls[0].path, ...)`

---

## 7. Outline — `src/workers/lmstudio-agentic.ts`

### Shape

```typescript
export class LmStudioAgenticRunner implements WorkerRunner {
  readonly capabilities = { agentic: true, execution_model: "tool_loop" } as const;
  async run(task: WorkerTask): Promise<WorkerResult> { /* tool loop */ }
}
```

**Prereqs:** extend `ExecutionModel` (`runner.ts:5`) to include `"tool_loop"`. Extend
`WorkerResult` (`types.ts:23`) with `tool_call_count?: number` and `iterations?: number`.
Extend `WorkerTask` with optional `tools?: ToolDef[]` (OpenAI tool schema).

### Tool loop (in-process counterpart to Codex's JSONL drain)

```
messages = buildInitialMessages(task)         // system (contextPrefix) + user (task.task)
iterations = 0; tool_call_count = 0
while iterations < MAX_ITERATIONS (=20):
  iterations++
  resp = await POST /v1/chat/completions { model, messages, tools, stream:false }
  // shared AbortController scoped to remaining wall-clock budget
  msg = resp.choices[0].message
  messages.push(msg)                           // append assistant turn verbatim
  if !msg.tool_calls?.length: break            // terminal — final text in msg.content
  for tc of msg.tool_calls:
    tool_call_count++
    result = await executeToolCall(tc, task.workdir)
    messages.push({ role:'tool', tool_call_id: tc.id, content: stringify(result) })
return { status:'success', output: msg.content, iterations, tool_call_count, ... }
```

### Termination conditions

| Condition | Status | error code | Codex analog |
|-----------|--------|------------|--------------|
| `tool_calls` absent | `success` | — | exit code 0 |
| `iterations === MAX_ITERATIONS` with tool_calls | `error` | `UNSUPPORTED` ("iteration cap hit") | non-zero exit |
| Wall-clock exhausted | `timeout` | `TIMEOUT` (retryable) | SIGTERM path |
| HTTP non-2xx | `error` | `PROVIDER_ERROR` (retryable) | non-zero exit |
| Fetch/network throw | `error` | `PROVIDER_ERROR` (retryable) | spawn `error` event |
| Build-args throw (invalid tool schema) | `error` | `INVALID_ARGS` | line 403 try/catch |
| Tool execution throw | append `{role:'tool', content: 'ERROR: <msg>'}`, continue | — | (no Codex analog) |

### Iteration cap + timeout interaction

One `AbortController` with `task.timeout_ms` total budget, passed into every `fetch`. The
iteration cap is defensive, not primary stop. Both checked at top of each iteration.

### Tool execution path (shell-first, per ROADMAP §2)

Phase 1: shell tools only. Schema includes `command: string`, executed via
`execFile('/bin/sh', ['-c', command], { cwd: task.workdir, timeout: per_tool_timeout })`.
Workdir clamp is upstream-of-worker concern (already enforced in dispatch).

Phase 2 (deferred): in-process handlers keyed by `tool.function.name` in
`Map<string, (args: unknown) => Promise<unknown>>`. Skip for v0.2.

### WorkerResult population

| Field | Value |
|-------|-------|
| `status` | per termination table |
| `output` | final assistant `content` (or accumulated text if none) |
| `duration_ms` | `Date.now() - startTime` |
| `exit_code` | `0` on success, `null` otherwise (no subprocess) |
| `token_usage` / `prompt_tokens` / `completion_tokens` | summed across iterations from each response's `usage` (LM Studio returns it) |
| `tool_call_count` | incremented per `tool_calls[]` entry across all iterations |
| `iterations` | total POST count |
| `tool_use_blocks` | mirror `tool_call_count` for parity with Codex behavioral signals |
| `thinking_blocks` | omit (LM Studio chat-completions has no equivalent) |

### Test fixtures (mirror codex.test.ts style)

`node:test` + `node:assert/strict`. **No real HTTP** — inject `fetch` via constructor exactly
like Codex injects `writer`/`pathBuilder`:

```typescript
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;
export class LmStudioAgenticRunner {
  constructor(private fetchImpl: FetchFn = globalThis.fetch) {}
}
```

**Canned response builders:**

```typescript
function toolCallResponse(toolName, args, id='call_1') { /* assistant msg with tool_calls[] */ }
function finalResponse(text) { /* assistant msg with content */ }
```

**Required cases:** (1) zero tool calls → 1 POST, `iterations===1`. (2) one tool call then
final → 2 POSTs, `tool_call_count===1`, `messages` contains `{role:'tool',tool_call_id:'call_1'}`.
(3) iteration cap → mock returns tool_call every time → status `error`, `iterations===20`.
(4) HTTP 500 → `PROVIDER_ERROR` retryable. (5) AbortError → status `timeout`. (6) Usage summed
across iterations. (7) Missing `tools` when required → `INVALID_ARGS`. (8) Tool exec throws →
loop continues with `{role:'tool', content:'ERROR: ...'}`.

Integration smoke: `http.createServer` on ephemeral port (per ROADMAP testing note, session
2026-05-07-11f4ce27 line 15750), assert live loop drains it.

### LM Studio tool-calling docs

Repo grep hit: `docs/sessions/2026-05-05-62993427.md:1305` → `https://lmstudio.ai/docs/developer`.
Tool-use spec page: `https://lmstudio.ai/docs/app/api/tools` — LM Studio's REST API mirrors
OpenAI's chat-completions `tools` / `tool_choice` / `tool_calls`. Not yet cited in `src/` —
include in new worker's header comment.

### What NOT to copy from codex.ts

- PID registry stubs (lines 12–25); `injectCompressWrappers`; `getCodexCliCapabilities` cache;
  `detached:true` + `process.kill(-pid,...)`; JSONL line buffering; `child.unref()` daemon detach.

### What MUST mirror codex.ts

- Pure inner function (`buildLmStudioRequest`) separate from `run()` — testable without fetch.
- Constructor injection of side-effect seams (`fetchImpl`, optional iteration cap override).
- `WorkerResult` factory pattern — every path returns, never throws past outer `try`.
- `makeError(code, message, retryable)` for every failure; `retryable:true` for transient
  network/timeout, `false` for invalid args / cap-hit.
- `contextPrefix` → system message (already in `generic-http-runner.ts:52`); reuse if extracted.
- `task.run_id` / `task.provider` forwarded into structured logs, never into LLM payload.
