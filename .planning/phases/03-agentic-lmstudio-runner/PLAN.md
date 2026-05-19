---
phase: 03-agentic-lmstudio-runner
plan: 01
type: tdd
wave: 1
depends_on: []
files_modified:
  - src/workers/lmstudio-agentic.ts             # NEW
  - src/workers/lmstudio-agentic.test.ts        # NEW
  - src/workers/runner.ts                       # verify only (line 6)
  - src/workers/types.ts                        # verify only (lines 7-47, 68-69)
  - src/cli/cmd-run.ts                          # lines 20, 28, 67-91 (type union + dispatch + HTTP set)
  - src/cli/cmd-parallel.ts                     # lines 20, 37-55, 105 (provider list + getRunner + validation)
autonomous: true
requirements:
  - AGENTIC-01
  - AGENTIC-02
  - AGENTIC-03
  - AGENTIC-04
  - AGENTIC-05
  - AGENTIC-06
must_haves:
  truths:
    - "User dispatches `relay run --provider lmstudio-agentic --task '...'` and observes multi-iteration tool-call loop ending with final answer"
    - "WorkerResult populates `tool_call_count` and `iterations` (already typed at types.ts:68-69)"
    - "Hash-based loop detector aborts at 3 consecutive identical hashes with LOOP_DETECTED reason; iteration cap 20 catches slower loops"
    - "`shell_exec` (alias `bash`) clamped to task.workdir; stdout truncated to 32KB; outside-workdir attempts rejected"
    - "LFM2 model detection injects JSON-format system-prompt nudge; never emits Pythonic"
    - "`tool_call_id` echoed byte-exact (no normalization)"
    - "Capability pre-check via GET /api/v0/models refuses dispatch when `tool_use` capability absent"
    - "stream:false hard-coded; no SSE accumulation in v0.2"
    - "`relay parallel` accepts `lmstudio-agentic` as a provider value"
  artifacts:
    - path: "src/workers/lmstudio-agentic.ts"
      provides: "LmStudioAgenticRunner class (capabilities = { agentic: true, execution_model: 'tool_loop' }) + pure helpers buildInitialMessages/hashToolCall/executeShellExec/buildLfm2Nudge"
      min_lines: 350
    - path: "src/workers/lmstudio-agentic.test.ts"
      provides: "node:test suite covering 14+ cases via injected fetchImpl + shellExec seams"
      min_lines: 400
    - path: "src/cli/cmd-run.ts"
      provides: "type union extended to include 'lmstudio-agentic'; HTTP_PROVIDERS set updated; dispatch branch wired"
      contains: "args.provider === 'lmstudio-agentic'"
    - path: "src/cli/cmd-parallel.ts"
      provides: "SpecTask.provider union extended; getRunner() branch added; validProviders set updated"
      contains: "'lmstudio-agentic'"
  key_links:
    - from: "src/cli/cmd-run.ts:72-74"
      to: "src/workers/lmstudio-agentic.ts"
      via: "dynamic import on provider==='lmstudio-agentic'"
      pattern: "import.*lmstudio-agentic"
    - from: "src/workers/lmstudio-agentic.ts"
      to: "/v1/chat/completions"
      via: "fetchImpl injected (defaults to globalThis.fetch); POSTed via getLmStudioEndpoint() from src/config/providers.ts"
      pattern: "fetch.*v1/chat/completions"
    - from: "src/workers/lmstudio-agentic.ts"
      to: "/api/v0/models"
      via: "capability probe before first POST; refuses if model lacks 'tool_use'"
      pattern: "/api/v0/models"
---

## Goal

Ship `src/workers/lmstudio-agentic.ts`, a **standalone** tool-calling worker (NOT a `GenericHttpRunner` subclass) that runs an in-process OpenAI-style tool loop against LM Studio's `/v1/chat/completions`. Satisfies AGENTIC-01..06 against ROADMAP Phase 3 success criteria.

**Why standalone, not GenericHttpRunner subclass:** `GenericHttpRunner.run` (generic-http-runner.ts:29-138) does one round-trip and returns; its capability is hard-coded `{ agentic: false }` (line 25). The tool loop fundamentally violates the "single-shot" contract documented at generic-http-runner.ts:6-13. Subclassing would require overriding `run()` entirely, leaving only `getHeaders()` reusable — net negative ergonomics. Reuse instead: `getLmStudioEndpoint()` + `getLmStudioApiKey()` from `src/config/providers.ts:55-61`, and the `contextPrefix → system message` convention from generic-http-runner.ts:49-58.

## Files to Touch (with line ranges)

### New files
| Path | Purpose |
|---|---|
| `src/workers/lmstudio-agentic.ts` | `LmStudioAgenticRunner` class + pure helpers (estimated ~380 LoC) |
| `src/workers/lmstudio-agentic.test.ts` | `node:test` suite, no real HTTP, ~14 cases (~450 LoC) |

### Modify (precondition + dispatch wiring)
| File | Lines | Edit |
|---|---|---|
| `src/workers/runner.ts` | line 6 | **VERIFY ONLY** — `"tool_loop"` already present in `ExecutionModel` union. T1 below confirms via grep test. |
| `src/workers/types.ts` | 7-47, 68-69 | **VERIFY ONLY** — `ToolDef`/`ToolCall`/`ToolCallMessage`/`WorkerTask.tools`/`WorkerResult.iterations`/`WorkerResult.tool_call_count` already declared. T1 confirms via type-import test. |
| `src/cli/cmd-run.ts` | 20 | Extend `provider` union: `'codex' \| 'openrouter' \| 'lmstudio' \| 'anthropic' \| 'lmstudio-agentic'` |
| `src/cli/cmd-run.ts` | 28 | Add `'lmstudio-agentic'` to `HTTP_PROVIDERS` set |
| `src/cli/cmd-run.ts` | 72-74 area | Insert `else if (args.provider === 'lmstudio-agentic')` branch after the existing `lmstudio` branch — dynamic import + `new LmStudioAgenticRunner()` |
| `src/cli/cmd-parallel.ts` | 20 | Extend `SpecTask.provider` union the same way |
| `src/cli/cmd-parallel.ts` | 42-45 area | Add `if (provider === 'lmstudio-agentic')` branch inside `getRunner()` |
| `src/cli/cmd-parallel.ts` | 105 | Add `'lmstudio-agentic'` to `validProviders` set (NOT to `httpProviders` — see note below) |

**Out of scope (deferred to follow-up plan):** `src/cli.ts:259-261, 771`, `src/cli/cmd-completion.ts:38`, `src/cli/cmd-init.ts:316,337`, `src/config/providers.ts:8-15` (`BUILTIN_PROVIDERS`), `src/contracts/delegate.ts:19` — these are surface-area completeness items, not required for the runner to function via `relay run`/`relay parallel`. Add follow-up note in PLAN.md output.

**Note on httpProviders set:** Adding `lmstudio-agentic` to `HTTP_PROVIDERS` (cmd-run.ts:28) and `httpProviders` (cmd-parallel.ts:106) enforces the same `--model required` validation as plain `lmstudio` — desired behavior.

**Out-of-scope (per user constraint):** `src/memory/*`, `src/cli/cmd-budget.ts`.

## Task Breakdown (strict TDD)

Each task: RED (write failing test) → GREEN (minimal impl) → REFACTOR (if needed). Commit at each transition. Tests in `lmstudio-agentic.test.ts` use `node:test` + `assert/strict` (mirror codex.test.ts:1-46 style).

---

### T1 — Type-precondition verification + provider literal

**Files:** `src/workers/lmstudio-agentic.test.ts` (new), `src/cli/cmd-run.ts:20,28`, `src/cli/cmd-parallel.ts:20,105`.

**RED:** Add a test `describe('preconditions', ...)` that:
1. Imports `ExecutionModel` from `../workers/runner.js` and asserts `'tool_loop'` is assignable (compile-time satisfied; runtime assert via type-only re-export trick).
2. Imports `ToolDef`, `ToolCall`, `ToolCallMessage` from `../workers/types.js` and asserts shape via a sample literal.
3. Asserts `WorkerResult` accepts `{ iterations, tool_call_count }` (compile-time).
4. Imports the (not-yet-extended) provider union from `cmd-run.ts` and asserts `'lmstudio-agentic'` is valid via a typed cast helper that throws at runtime if literal mismatched.

Run `npm test` → expect failures in steps 4 only (steps 1-3 already pass per runner.ts:6 + types.ts:7-47,68-69 discovery).

**GREEN:** Edit `cmd-run.ts:20` and `cmd-parallel.ts:20` to add `'lmstudio-agentic'` to the literal union. Add to `HTTP_PROVIDERS` (cmd-run.ts:28) and `validProviders`+`httpProviders` (cmd-parallel.ts:105-106).

**Verify:** `npx tsc --noEmit` clean; `npm test -- lmstudio-agentic` precondition group green.

**Done:** Type-precondition group all green; provider literal accepted in both dispatch files.

---

### T2 — Worker skeleton + pure helpers (no loop yet)

**Files:** `src/workers/lmstudio-agentic.ts` (new), `src/workers/lmstudio-agentic.test.ts`.

**RED:** Add tests for pure helpers:
- `buildInitialMessages(task)` — system message from `task.contextPrefix` (per generic-http-runner.ts:52-58), user message from `task.task`. When `contextPrefix` absent → only user message.
- `buildLfm2Nudge(modelName)` — returns nudge string when `modelName` matches `/^liquid\/lfm2-/i`, else `null`. Per pitfall 1.1, the nudge must read: `"Output function calls strictly as JSON in the tool_calls field, never as Python literals."`
- `LmStudioAgenticRunner` class declares `capabilities = { agentic: true, execution_model: 'tool_loop' } as const` and accepts `{ fetchImpl?, shellExec?, maxIterations? }` constructor opts.
- `run(task)` returns `WorkerResult` with `status: 'error'` + `INVALID_ARGS` when `task.tools` is absent (initial guard).

**GREEN:** Create `src/workers/lmstudio-agentic.ts` with: imports (`makeError` from `../errors.js`, `getLmStudioEndpoint`/`getLmStudioApiKey` from `../config/providers.js`, types from `./types.js`/`./runner.js`); export interfaces `FetchFn`, `ShellExecFn`; export class with the four members above. Implement `buildInitialMessages` and `buildLfm2Nudge` as pure module-level functions and re-export for test access.

**Verify:** `npm test -- lmstudio-agentic` skeleton tests green; `npx tsc --noEmit` clean.

**Done:** Skeleton compiles, helper tests pass, `run()` correctly errors on missing tools.

---

### T3 — Tool execution sandbox (`shell_exec` + cwd clamp + 32KB truncation)

**Files:** `src/workers/lmstudio-agentic.ts`, `src/workers/lmstudio-agentic.test.ts`.

**RED:** Add tests for `executeToolCall(call, workdir, shellExec)`:
1. Unknown tool name → returns `{ tool_call_id: <echoed>, content: 'ERROR: unknown tool <name>' }` — never throws.
2. `function.arguments` not valid JSON → returns `{ ..., content: 'ERROR: arguments not valid JSON' }` per LMSTUDIO-TOOL-API.md Error Modes table.
3. `shell_exec` with `{ command: 'echo hi' }` invokes injected `shellExec({ command, cwd: workdir, maxBytes: 32768 })` and returns `{ content: <stringified result> }`.
4. Alias `bash` resolves to the same handler as `shell_exec`.
5. `shell_exec` with `{ cwd: '/etc' }` (attempt to override) — **clamp policy:** the `cwd` field in args MUST be ignored; `task.workdir` is the only allowed cwd. Test asserts injected shellExec receives `task.workdir`, not `/etc`.
6. Output >32KB → truncated to 32768 bytes + trailing marker `\n…[TRUNCATED: original NN bytes]`; final string length ≤ 32768 + marker length.
7. `tool_call_id` field on returned message MUST byte-equal `call.id` — round-trip a numeric `"365174485"` and a UUID-style id, assert both unchanged.

**GREEN:** Implement `executeToolCall` and `executeShellExec` in `lmstudio-agentic.ts`:
- `BUILTIN_TOOL_NAMES = new Set(['shell_exec', 'bash'])`.
- `executeShellExec(args, workdir, shellExec)`:
  - Parse args with zod schema `z.object({ command: z.string().min(1) }).passthrough()` — `passthrough()` allows extra fields like a model-emitted `cwd`, but we ignore everything except `command`.
  - Call `shellExec({ command, cwd: workdir, maxBytes: 32768 })`.
  - If `result.stdout.length > 32768` → truncate to 32768 bytes (Buffer slice for byte-safety) + append marker.
- Default `shellExec` implementation: `execFile('/bin/sh', ['-c', command], { cwd, timeout: 30_000, maxBuffer: 64*1024 })` wrapped in promise; returns `{ stdout, stderr, exitCode }`. Truncate at 32KB regardless of `maxBuffer`.

**Verify:** `npm test -- lmstudio-agentic` sandbox tests green.

**Done:** All 7 sandbox tests pass; tool_call_id byte-exact; cwd clamp enforced; truncation works.

---

### T4 — Tool loop + iteration cap + wall-clock timeout

**Files:** `src/workers/lmstudio-agentic.ts`, `src/workers/lmstudio-agentic.test.ts`.

**RED:** Add tests with injected `fetchImpl`:
1. **Zero tool calls** → 1 POST, returns assistant `content` directly, `iterations === 1`, `tool_call_count === 0`, status `success`.
2. **One tool call then final** → 2 POSTs, `tool_call_count === 1`, messages array contains `{role:'tool', tool_call_id:'call_1', content: <stringified result>}` between assistant turns.
3. **Iteration cap (20)** — fetchImpl always returns tool_call → status `error`, `error.code === 'UNSUPPORTED'`, `error.message` contains "iteration cap"; `iterations === 20`. Loop detector at T5 must NOT fire (vary args per iteration).
4. **Wall-clock timeout via AbortController** — fetchImpl returns a never-resolving Promise with abort-honoring (rejects with `AbortError`); `task.timeout_ms = 100`; status `timeout`, `error.code === 'TIMEOUT'`, retryable=true.
5. **HTTP 500** → status `error`, `PROVIDER_ERROR`, retryable=true, no further iterations.
6. **`usage` summed across iterations** — 3 iterations each with `usage.total_tokens: 100` → result `token_usage === 300`.
7. **Capability probe rejects** — fetchImpl probe-response (GET /api/v0/models) returns model without `"tool_use"` capability → status `error`, `INVALID_ARGS`, non-retryable; ZERO POSTs to `/v1/chat/completions`.
8. **`tools[]` re-sent every turn** — assert request body of iteration 2 still contains the original `tools` array (per LMSTUDIO-TOOL-API.md §"Follow-up Turn": "keep passing every turn").

**GREEN:** Implement the loop in `run(task)`:
```
1. startTime = Date.now()
2. Validate task.tools present + non-empty → INVALID_ARGS
3. Probe GET {endpoint}/api/v0/models via fetchImpl; find entry with id === task.model;
   if missing capability 'tool_use' → INVALID_ARGS
4. messages = buildInitialMessages(task); inject LFM2 nudge into system content if applicable
5. controller = new AbortController(); timer = setTimeout(() => controller.abort(), task.timeout_ms)
6. for (iter = 1; iter <= maxIterations; iter++):
     resp = await fetchImpl(`${endpoint}/v1/chat/completions`,
       { method: POST, headers: {Content-Type, Bearer?}, body: JSON({model, messages, tools: task.tools, tool_choice: 'auto', stream: false, temperature: 0.2}), signal: controller.signal })
     if !resp.ok → PROVIDER_ERROR retryable
     parse body; sum usage; append msg = body.choices[0].message to messages
     if !msg.tool_calls?.length → success path (return)
     [T5 loop detector check goes here]
     for tc of msg.tool_calls:
       tool_call_count++
       toolResult = await executeToolCall(tc, task.workdir, shellExec)
       messages.push(toolResult)  // {role:'tool', tool_call_id: tc.id, content}
7. (loop exit) → UNSUPPORTED "iteration cap hit"
8. finally: clearTimeout(timer)
9. catch AbortError → status 'timeout', TIMEOUT retryable
```

**Verify:** All 8 loop tests pass.

**Done:** Tool loop functional with iteration cap + timeout + capability probe + usage aggregation + tools re-sent every turn.

---

### T5 — Hash-based loop detector (3 consecutive identical hashes)

**Files:** `src/workers/lmstudio-agentic.ts`, `src/workers/lmstudio-agentic.test.ts`.

**RED:**
1. Pure helper `hashToolCall(name, args)` — input `('shell_exec', {a:1, b:2})` and `('shell_exec', {b:2, a:1})` must produce **identical** hashes (key-order independence per LMSTUDIO-TOOL-API.md §Error Modes). Use `sha256(name + '\x00' + canonicalJsonStringify(args))`.
2. fetchImpl returns same `shell_exec({command:'ls'})` call 3 times → status `error`, `error.code === 'UNSUPPORTED'`, `error.message` contains `LOOP_DETECTED`; `iterations === 3`; loop aborts BEFORE the 4th POST.
3. fetchImpl returns same call 2 times then different call → loop CONTINUES (sliding window resets).
4. Parallel tool_calls in single turn — hash compared per assistant turn's combined-tools fingerprint (concat-and-hash of all tc hashes sorted), not per individual tool_call. Test: turn N has [shell_exec(ls), shell_exec(pwd)], turn N+1 has same pair → counts as one repeat.

**GREEN:**
- Add `canonicalJsonStringify(obj)` — sort object keys recursively before `JSON.stringify`. Cite test fixtures `{a:1,b:2}` and `{b:2,a:1}` produce identical strings.
- Add `hashToolCall(name, args)` using `node:crypto` `createHash('sha256')`.
- In `run()` loop body after appending tool_calls, compute combined-turn hash:
  ```
  turnHash = sha256(msg.tool_calls.map(tc => hashToolCall(tc.function.name, JSON.parse(tc.function.arguments))).sort().join('|'))
  recentHashes.push(turnHash); if (recentHashes.length > 3) recentHashes.shift();
  if (recentHashes.length === 3 && new Set(recentHashes).size === 1) → UNSUPPORTED 'LOOP_DETECTED: same tool-call signature 3 turns in a row'
  ```
- Argument-parse failure (caught in T3) → use `arguments` raw string in hash so retries are still detected.

**Verify:** 4 loop-detector tests green; T4 iteration-cap test still passes (vary args ensures detector doesn't fire prematurely).

**Done:** Loop detector aborts at 3-in-a-row; key-order independence verified; parallel tool calls handled.

---

### T6 — LFM2 system-prompt nudge integration

**Files:** `src/workers/lmstudio-agentic.ts`, `src/workers/lmstudio-agentic.test.ts`.

**RED:**
1. `task.model === 'liquid/lfm2-24b-a2b'` → first POST body's `messages[0]` (system) content ends with the LFM2 nudge string from T2.
2. `task.model === 'qwen/qwen3-coder-next'` → no nudge appended; system content equals raw `task.contextPrefix` (or default "You are a coding agent…" if `contextPrefix` empty).
3. Mixed case `'LIQUID/LFM2-foo'` → nudge appended (case-insensitive match `/^liquid\/lfm2-/i`).
4. When `task.contextPrefix` absent AND model is LFM2 → system message exists with nudge as the only content (don't drop the nudge just because contextPrefix is missing).

**GREEN:** In `buildInitialMessages(task)`:
- If `buildLfm2Nudge(task.model)` returns non-null, the system message content = `(contextPrefix ?? '') + (contextPrefix ? '\n\n' : '') + nudge`.
- Ensure the system message slot exists when nudge is required.

**Verify:** 4 LFM2 tests green; T2 helper tests still green.

**Done:** LFM2 detection works; nudge appended; non-LFM2 models unaffected.

---

### T7 — Dispatch wiring + integration smoke through cmd-run and cmd-parallel

**Files:** `src/cli/cmd-run.ts:67-91`, `src/cli/cmd-parallel.ts:37-55`, `src/workers/lmstudio-agentic.test.ts` (integration block).

**RED:**
1. Smoke test for `cmd-run.ts`: stub `import('../workers/lmstudio-agentic.js')` (via test seam or direct import-and-assert), invoke `executeRunCommand({ provider: 'lmstudio-agentic', model: 'qwen/qwen3-coder-next', task: 'test', workdir: '/tmp/work', timeoutMs: 5000, json: true }, ioStub)`; assert RunStore records `provider: 'lmstudio-agentic'` and the dispatch branch fires (use a spy on the module).
2. Smoke test for `cmd-parallel.ts`: spec file with `{tasks:[{provider:'lmstudio-agentic', model:'qwen/qwen3-coder-next', task:'t'}]}`; assert validation passes and `getRunner('lmstudio-agentic')` returns a `LmStudioAgenticRunner` instance.

**GREEN:**
- Insert dispatch branch in `cmd-run.ts:74` (after the existing `lmstudio` branch):
  ```
  } else if (args.provider === 'lmstudio-agentic') {
    const { LmStudioAgenticRunner } = await import('../workers/lmstudio-agentic.js');
    runner = new LmStudioAgenticRunner();
  ```
- Insert branch in `cmd-parallel.ts:44` inside `getRunner`:
  ```
  if (provider === 'lmstudio-agentic') {
    const { LmStudioAgenticRunner } = await import('../workers/lmstudio-agentic.js');
    return new LmStudioAgenticRunner();
  }
  ```
- Type union + `HTTP_PROVIDERS`/`validProviders`/`httpProviders` updates from T1 already done.

**Verify:** `npx tsc --noEmit` clean, exhaustiveness check at cmd-run.ts:82 still satisfied (`const exhaustive: never`); smoke tests green.

**Done:** Both CLI entrypoints recognize `lmstudio-agentic`; dispatch reaches the new runner.

---

### T8 — Integration test against ephemeral http server (no real LM Studio)

**Files:** `src/workers/lmstudio-agentic.test.ts` (integration `describe` block).

**RED:**
1. Spin `http.createServer` on ephemeral port (port 0); script its responses:
   - `GET /api/v0/models` → `{data:[{id:'qwen/qwen3-coder-next', capabilities:['tool_use']}]}`
   - `POST /v1/chat/completions` first call → tool_calls with `shell_exec({command:'echo hello'})` and `id:'365174485'`
   - 2nd call → final `content: 'Done — output was: hello'`, `finish_reason: 'stop'`
2. Inject `LMSTUDIO_ENDPOINT=http://localhost:<port>` env; run worker with `task.tools = [shellExecToolDef]`, `task.model = 'qwen/qwen3-coder-next'`, real `shellExec` that returns `{stdout:'hello\n', exitCode:0}` (mock at injection seam; do NOT execute real `/bin/sh` in test).
3. Assertions: `result.status === 'success'`; `result.iterations === 2`; `result.tool_call_count === 1`; `result.output.includes('Done')`; recorded request bodies show `tool_call_id: '365174485'` on the appended tool message; `tools[]` present in both POST bodies.
4. Round-trip integration test for UUID-style `tool_call_id`: `id: 'call_abc-123-XYZ'` echoed byte-exact in tool message.

**GREEN:** Test infra only — no production code changes required if T2-T6 implemented correctly. If integration reveals bugs, fix in `lmstudio-agentic.ts` and re-run.

**Verify:** Integration block green. Total suite count ≥ 14 tests across T1-T8.

**Done:** End-to-end loop drains a real (in-process) HTTP server; tool_call_id byte-exact echo proven on numeric AND UUID styles.

---

## Acceptance Criteria (per ROADMAP Phase 3 success criterion)

| # | ROADMAP Criterion | Verified By |
|---|---|---|
| 1 | Multi-iteration tool-call loop returns with `tool_call_count`/`iterations` populated | T4 case 2, T8 integration |
| 2 | LOOP_DETECTED at 3 consecutive identical hashes; does NOT reach iteration 20 | T5 case 2 (asserts loop aborts before 4th POST) |
| 3 | LFM2 model receives JSON nudge in system prompt | T6 cases 1, 3 |
| 4 | `shell_exec`/`bash` clamped to `task.workdir`; 32KB truncation enforced | T3 cases 4, 5, 6 |
| 5 | `relay parallel` accepts `--provider lmstudio-agentic`; `"tool_loop"` in ExecutionModel union | T1 (type literal), T7 (parallel smoke), runner.ts:6 (already present) |

## Runtime Validation (exact commands)

Pre-step: ensure LM Studio is running with `qwen/qwen3-coder-next` loaded (`lms server start && lms load qwen/qwen3-coder-next`).

```
# Capability probe (should list 'tool_use' for the loaded model)
curl -sS http://localhost:1234/api/v0/models | jq '.data[] | select(.id=="qwen/qwen3-coder-next") | .capabilities'

# Smoke run
relay run --provider lmstudio-agentic \
          --model qwen/qwen3-coder-next \
          --workdir /tmp/relay-agentic-smoke \
          --timeout-ms 60000 \
          --task "List files in the current directory and tell me how many TypeScript files there are."

# Expected JSON envelope fields (when --json):
#   status: "success"
#   iterations: 2-4
#   tool_call_count: ≥ 1
#   output: includes a count + brief summary

# Parallel mode
echo '{"tasks":[{"provider":"lmstudio-agentic","model":"qwen/qwen3-coder-next","task":"pwd and uname -a","timeout_ms":30000}]}' > /tmp/spec.json
relay parallel /tmp/spec.json --max-concurrency 1 --json

# LFM2 nudge validation (requires liquid/lfm2-24b-a2b loaded)
RELAY_LMSTUDIO_DEBUG_DUMP=1 relay run --provider lmstudio-agentic \
   --model liquid/lfm2-24b-a2b --workdir /tmp/lfm2 --timeout-ms 60000 \
   --task "echo hello"
# Then: cat ~/.relay/debug/lmstudio-*.json | jq '.request.messages[0].content' — assert string contains "Output function calls strictly as JSON"
# (Debug dump itself is OUT OF SCOPE for this plan — flag exists per pitfall 1.3 doc but implementation deferred to a follow-up debug-dump plan.)
```

**Note:** the `RELAY_LMSTUDIO_DEBUG_DUMP` validation step is descriptive only — actual debug-dump wiring is a separate concern (pitfall 1.3 doc); included here as the recommended manual LFM2 verification path once that helper exists.

## Risk Register (12 risks)

| # | Risk | Mitigation in plan |
|---|---|---|
| R1 | Model not loaded → HTTP 404/400 cryptic | Capability pre-check via GET /api/v0/models (T4 case 7); refuses dispatch with `INVALID_ARGS` |
| R2 | Malformed `tool_calls` JSON / Pythonic output | LFM2 nudge T6; per LMSTUDIO-TOOL-API.md, default to qwen3-coder-next. Drift detection (content contains tool-shape but tool_calls empty) deferred to follow-up — current plan returns final answer in that case (matches LM Studio's own behavior) |
| R3 | Infinite tool loop burns budget | T4 iteration cap (20) + T5 hash detector (3 consecutive identical) — BOTH guards always active |
| R4 | Stream-chunk accumulation bugs | `stream: false` hard-coded in T4 request body; pitfall 1.5 — no SSE in v0.2 |
| R5 | LFM2 Pythonic default | T6 system-prompt nudge injected when model name matches `/^liquid\/lfm2-/i` |
| R6 | GLM hidden preset injection | OUT OF SCOPE for this plan — pitfall 1.3 needs `RELAY_LMSTUDIO_DEBUG_DUMP` helper, deferred. Mitigation: default model recommendation is qwen3-coder-next; document GLM as advanced |
| R7 | `tool_call_id` mismatch from defensive normalization | T3 case 7 + T8 round-trip: byte-exact echo asserted on numeric `"365174485"` AND UUID `"call_abc-123-XYZ"` |
| R8 | Tool execution throws (e.g., shellExec rejects) | Caught inside `executeToolCall`; returns `{role:'tool', content:'ERROR: <msg>'}` so model can self-correct; loop CONTINUES (per AGENTIC-WORKER-PATTERN.md §3 termination table) |
| R9 | Wall-clock budget exceeded mid-loop | T4 case 4: AbortController wired to all fetches; on AbortError → status `timeout`, `TIMEOUT` retryable |
| R10 | cwd-escape via model-emitted `{cwd: '/etc'}` argument | T3 case 5: `cwd` field in args IGNORED; only `task.workdir` honored — passthrough zod schema strips control |
| R11 | Output >32KB floods context | T3 case 6: byte-safe truncation at 32768 + marker; default `shellExec.maxBuffer` 64KB so command can't OOM Node before truncate runs |
| R12 | Context overflow across many iterations (usage approaches model limit) | OUT OF SCOPE — token-watchdog cumulative cap deferred to follow-up (pitfall 1.2 lists as Tier-2 mitigation). Current plan documents iteration cap + loop detector as Tier-1; user can manually `--timeout-ms` ceiling |
| R13 | Dispatch wiring incomplete for `cli.ts`/`cmd-completion.ts`/`cmd-init.ts`/`BUILTIN_PROVIDERS`/`contracts/delegate.ts` | Scoped out of this plan — runner functions via `relay run`/`relay parallel`. Follow-up plan covers completeness items (auto-init suggestion, shell-completion, `BUILTIN_PROVIDERS` registration) |

## Tool Execution Sandbox Spec

### `shell_exec` tool definition (offered to model)

```json
{
  "type": "function",
  "function": {
    "name": "shell_exec",
    "description": "Execute a shell command in the task workdir. Stdout is truncated at 32KB.",
    "parameters": {
      "type": "object",
      "properties": {
        "command": { "type": "string", "description": "Shell command (bash syntax) to run." }
      },
      "required": ["command"],
      "additionalProperties": false
    }
  }
}
```

**Alias `bash`** — identical schema, registered as a second key in the dispatch map. Both names resolve to the same handler. Test T3 case 4 asserts equivalence.

### CWD clamp policy

- The **only** cwd used is `task.workdir`, validated upstream by the dispatch layer.
- Even if the model emits `{command: 'ls', cwd: '/etc'}`, the `cwd` field is **silently dropped** — the zod schema uses `.passthrough()` to permit (not reject) the field, then the executor explicitly passes `task.workdir` to `execFile`.
- `command` is NOT sanitized for path-escape (e.g., `cd /etc && ls`). User accepts shell-injection risk for v0.2 — `task.workdir` already represents user-trusted territory per existing `assertWorkdirAllowed` in the dispatch chain. Future-phase: containerized sandbox.

### 32KB truncation policy

- Truncation applies to `stdout` (the primary signal returned to the model). `stderr` is included but counted against the same 32KB budget — combined as `STDOUT:\n<...>\n\nSTDERR:\n<...>\n\nEXIT: <code>`, total clamped at 32768 bytes.
- Byte-safe (Buffer slice on UTF-8 boundaries — use `Buffer.from(str).subarray(0, 32768).toString('utf8')` with a final-char repair for split codepoints).
- Marker: `\n…[TRUNCATED: original NN bytes]` appended AFTER truncation (so total may exceed 32768 by the marker length — acceptable, deterministic).
- Test T3 case 6 asserts both length-bound AND marker presence.

### Tool-result message shape (sent back to model)

```json
{
  "role": "tool",
  "tool_call_id": "<byte-exact echo of assistant turn's tool_calls[i].id>",
  "content": "STDOUT:\n<truncated text>\n\nSTDERR:\n<truncated text>\n\nEXIT: 0"
}
```

`content` is ALWAYS a string (per LMSTUDIO-TOOL-API.md §"Tool result message — required fields") — error states use `content: 'ERROR: <reason>'`.

## Success Criteria (measurable)

- [ ] `src/workers/lmstudio-agentic.ts` exists, exports `LmStudioAgenticRunner` with `capabilities = { agentic: true, execution_model: 'tool_loop' }`
- [ ] `npm test -- lmstudio-agentic` passes ≥ 14 cases across 8 task groups
- [ ] `npx tsc --noEmit` clean (no new errors)
- [ ] `cmd-run.ts` and `cmd-parallel.ts` accept `lmstudio-agentic` provider; exhaustiveness check still satisfied
- [ ] Smoke `relay run --provider lmstudio-agentic` returns success with populated `iterations` + `tool_call_count` against real LM Studio + qwen3-coder-next
- [ ] No `console.log` in production code (global rule); no new deps added (use `node:crypto` + `node:child_process` only)
- [ ] `src/memory/*` and `src/cli/cmd-budget.ts` untouched

## Output

After completion, create `.planning/phases/03-agentic-lmstudio-runner/03-01-SUMMARY.md` capturing:
- Exact line ranges changed in cmd-run.ts and cmd-parallel.ts
- Test count + names
- Follow-up plan stub for: debug-dump helper, full `BUILTIN_PROVIDERS` registration, `cli.ts`/`cmd-completion.ts` updates, token watchdog (R12), tool-call-drift detection (R2 Tier-2)
- Runtime validation results from the smoke commands above
