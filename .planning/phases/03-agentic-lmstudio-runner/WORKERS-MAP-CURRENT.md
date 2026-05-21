# Phase 3 — src/workers/ Current-State Map

**Scope:** Read-only snapshot at HEAD (`a6e8e1d`) of files Phase 3 (lmstudio-agentic.ts) consumes or extends. Citations use `path:line` where line is the literal line number in the file at HEAD.

---

## 1. File Inventory — `src/workers/`

| File | LOC | Role |
|---|---|---|
| `runner.ts` | 22 | `WorkerRunner` interface + `WorkerCapabilities` / `ExecutionModel` types |
| `types.ts` | 99 | `WorkerTask`, `WorkerResult`, `ToolDef`, `ToolCall`, `ToolCallMessage`, `DelegateMeta`, `DelegateResponse` |
| `codex.ts` | 656 | Subprocess runner (Codex CLI). Capability probing, env injection, group-kill timeout. |
| `codex.test.ts` | 185 | Injection-seam tests for `buildCodexInvocation` (writer + pathBuilder) |
| `lmstudio.ts` | 51 | `LmStudioRunner extends GenericHttpRunner` — single-shot |
| `openrouter.ts` | ~60 | OpenRouter `GenericHttpRunner` subclass — single-shot |
| `anthropic.ts` | ~100 | `AnthropicRunner` — direct fetch, single-shot, no tool loop (`anthropic.ts:9`) |
| `anthropic.test.ts` | ~100 | (existing) |
| `generic-http-runner.ts` | 189 | Shared single-shot HTTP base class — does NOT support tool loop (see file header `:5-13`) |
| `generic-http-runner.test.ts` | ~200 | contextPrefix tests for chat-completions + responses formats |
| `lmstudio-agentic.ts` | **563** | Phase 3 target file — exists, skeleton + pure helpers landed (ed1b01c) |
| `lmstudio-agentic.test.ts` | **1011** | TDD harness — T1-T8 describe blocks already structured |

12 files total. Phase 3 worker is **partially landed**, not a greenfield. Remaining work is GREEN-bar for T3-T8.

---

## 2. `runner.ts` — `tool_loop` Union Member (committed `8e5c08e`)

`src/workers/runner.ts:5-6`:
```ts
// "tool_loop" — in-process OpenAI-style tool-calling loop (lmstudio-agentic worker)
export type ExecutionModel = "relay-loop" | "subprocess" | "tool_loop";
```
- `WorkerCapabilities.execution_model?` field at `runner.ts:12`.
- `getRunnerCapabilities()` default fallback at `runner.ts:20-22` returns `{ agentic: false }`.
- Confirmed in git: `git log src/workers/runner.ts` → `8e5c08e feat(v0.2): commit GREEN partials ... ExecutionModel tool_loop`.

---

## 3. `types.ts` — Phase 3 Type Surface (committed `8e5c08e`)

All required types present:

| Type | Line | Shape |
|---|---|---|
| `ToolFunctionDef` | `types.ts:8-12` | `{ name, description?, parameters? }` |
| `ToolDef` | `types.ts:15-18` | `{ type: "function", function: ToolFunctionDef }` |
| `ToolCall` | `types.ts:21-28` | `{ id, type: "function", function: { name, arguments: string (JSON) } }` |
| `ToolCallMessage` | `types.ts:31-35` | `{ role: "tool", tool_call_id, content }` |
| `WorkerTask.tools?` | `types.ts:47` | `ToolDef[]` optional |
| `WorkerResult.iterations?` | `types.ts:68` | number, POST iterations |
| `WorkerResult.tool_call_count?` | `types.ts:69` | number, total tool invocations |
| `WorkerTask.contextPrefix?` | `types.ts:39` | Cache-stable system layer (bareTask convention) |
| `WorkerTask.run_id` | `types.ts:50` | Required |
| `WorkerResult.token_usage / prompt_tokens / completion_tokens` | `types.ts:60-62` | Optional num/null — agentic must SUM across iterations |

`ResolvedMcpAttachment` import at `types.ts:3` — not used by lmstudio-agentic (no MCP attachments in Phase 3 scope).

---

## 4. `codex.ts` — Reference Pattern

| Aspect | Citation | Detail |
|---|---|---|
| Capability cache | `codex.ts:83` | `capabilityCache = new Map<string, Promise<CodexCliCapabilities>>()` — keyed by `bin@version` |
| Capability probe | `codex.ts:136-147` | `probeCodexCliCapabilities()` — runs `--help` + `exec --help`, falls back to `LEGACY_*` on failure |
| Pure invocation builder | `codex.ts:184-326` | `buildCodexInvocation()` — exported, takes `env`, `capabilities`, `writer`, `pathBuilder` injection seams |
| Subprocess spawn | `codex.ts:435-439` | `spawn(codexBin, args, { stdio: ["pipe","pipe","pipe"], env, detached: true })` |
| Detached + unref | `codex.ts:441-444` | `registerPid(child.pid); child.unref();` — group-kill semantics |
| Timeout: SIGTERM → SIGKILL escalation | `codex.ts:520-529` | `killGroup('SIGTERM')` then `setTimeout(killGroup 'SIGKILL', 5_000)` |
| Error envelope (timeout) | `codex.ts:573-583` | `{ status: 'timeout', error: makeError("TIMEOUT", ...) }` |
| Error envelope (exit ≠ 0) | `codex.ts:585-595` | `error: makeError("CODEX_ERROR", ..., false)` |
| Error envelope (spawn fail) | `codex.ts:607-631` | `BINARY_NOT_FOUND` retryable=false |
| Behavioral signals | `codex.ts:566-571` | `thinking_blocks`, `tool_use_blocks`, `file_reads_before_first_write`, `tool_retry_count` |
| `CodexRunner` class | `codex.ts:650-656` | `capabilities = { agentic: true, execution_model: "subprocess" }` |

Phase 3 should mirror: pure helpers exported for unit tests + thin class wrapper holding state.

---

## 5. `lmstudio.ts` — Current State (single-shot, untouched)

`src/workers/lmstudio.ts:31-51`:
```ts
export class LmStudioRunner extends GenericHttpRunner {
  constructor() {
    super({
      providerName: "LM Studio",
      getUrl: () => `${getLmStudioEndpoint().replace(/\/+$/, "")}/v1/chat/completions`,
      getHeaders: (_model) => {
        const apiKey = getLmStudioApiKey();
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
        return headers;
      },
      requiresModel: true,
      fetchFailureMessage: (err, url) =>
        `LM Studio fetch failed: ${String(err)}. Is it running at ${url.replace(/\/v1\/chat\/completions$/, "")}?`,
    });
  }
}
```
- Single-shot only — no tool loop, no model probe.
- Reuses `getLmStudioEndpoint()` (`providers.ts:55`) + `getLmStudioApiKey()` (`providers.ts:59`).
- Endpoint path: `${base}/v1/chat/completions` after trailing-slash strip (line 35).
- `parseLmStudioResponse()` (line 20-29) and `parseLmStudioMessageContent()` (line 4-18) are pure exports — Phase 3 can reuse for response parsing if needed.

**Verdict:** keep untouched. `lmstudio-agentic.ts` is a parallel runner, not a subclass.

---

## 6. `generic-http-runner.ts` — Inheritance & Why-Not-Subclass

File header `:5-13`:
```
* Slim HTTP runner for solo Relay v0.1.0.
* Posts a single chat-completions (or OpenAI Responses) request and returns
* the model's text. No agentic tool-loop, no MCP attachment fetching, no
* Anthropic-specific path.
```

| Aspect | Citation |
|---|---|
| Class declaration | `generic-http-runner.ts:24-28` — `class GenericHttpRunner implements WorkerRunner` |
| `capabilities` literal | `generic-http-runner.ts:25` — `{ agentic: false } as const` |
| Single `fetch()` call | `generic-http-runner.ts:76-81` — no loop, no `tools`/`tool_choice` |
| `AbortController` timeout | `generic-http-runner.ts:72-73` — `setTimeout(() => controller.abort(), task.timeout_ms)` |
| `contextPrefix` → system msg | `generic-http-runner.ts:52-57` — bareTask convention |
| Body format switch | `generic-http-runner.ts:59-70` — `chat-completions` vs `responses` |
| Provider error envelope | `generic-http-runner.ts:85-98` — `makeError("PROVIDER_ERROR", ..., true)` retryable=true |
| Timeout envelope | `generic-http-runner.ts:115-122` — `makeError("TIMEOUT", ..., true)` |

`lmstudio-agentic.ts` correctly does **not** extend `GenericHttpRunner` (`lmstudio-agentic.ts:3-6` header explicitly justifies the split).

---

## 7. `cmd-run.ts` — Dispatch Insertion Point

`src/cli/cmd-run.ts:18-26`:
```ts
export interface RunCommandArgs {
  task: string;
  provider: 'codex' | 'openrouter' | 'lmstudio' | 'anthropic' | 'lmstudio-agentic';
  // ...
}
```
`src/cli/cmd-run.ts:28`:
```ts
const HTTP_PROVIDERS = new Set(['openrouter', 'lmstudio', 'anthropic', 'lmstudio-agentic']);
```
`src/cli/cmd-run.ts:81-83`:
```ts
} else if (args.provider === 'lmstudio-agentic') {
  const { LmStudioAgenticRunner } = await import('../workers/lmstudio-agentic.js');
  runner = new LmStudioAgenticRunner();
```
- Provider literal + HTTP_PROVIDERS set membership + dispatch branch **all wired**.
- Exhaustive `never` check at line 85-86 guards future provider additions.
- Header docstring at `cmd-run.ts:11-12` still says "v0.1.0: codex, openrouter, lmstudio" — stale, low-priority cleanup.

---

## 8. `cmd-parallel.ts` — Dispatch Insertion Point

`src/cli/cmd-parallel.ts:18-25` (`SpecTask`):
```ts
interface SpecTask {
  task: string;
  provider: 'codex' | 'lmstudio' | 'openrouter' | 'anthropic' | 'lmstudio-agentic';
  // ...
}
```
`src/cli/cmd-parallel.ts:54-56`:
```ts
if (provider === 'lmstudio-agentic') {
  const { LmStudioAgenticRunner } = await import('../workers/lmstudio-agentic.js');
  return new LmStudioAgenticRunner();
}
```
`src/cli/cmd-parallel.ts:109-110`:
```ts
const validProviders = new Set(['codex', 'lmstudio', 'openrouter', 'anthropic', 'lmstudio-agentic']);
const httpProviders = new Set(['lmstudio', 'openrouter', 'anthropic', 'lmstudio-agentic']);
```
Validation message at `cmd-parallel.ts:113` includes `lmstudio-agentic`. Both dispatch sites are wired.

---

## 9. `src/config/providers.ts` — Required Signatures

```ts
// providers.ts:55-57
export function getLmStudioEndpoint(): string {
  return process.env["LMSTUDIO_ENDPOINT"]?.trim() || "http://localhost:1234";
}

// providers.ts:59-61
export function getLmStudioApiKey(): string | null {
  return process.env["LMSTUDIO_API_KEY"]?.trim() || null;
}
```
- Endpoint: returns base URL only (no path) — caller must append `/v1/chat/completions` or `/api/v0/models`. `lmstudio.ts:35` strips trailing slashes; `lmstudio-agentic.ts` must do the same.
- API key: nullable; only emit `Authorization: Bearer ...` when present (mirror `lmstudio.ts:41-43`).
- No retry / circuit logic — pure env-read.

---

## 10. `codex.test.ts` — Constructor-Injection Seam Pattern

`src/workers/codex.test.ts`:

| Line | Pattern |
|---|---|
| `3-7` | Import seam types: `TempFileWriter`, `TempPathBuilder` from worker module |
| `10-20` | `CodexTaskFields = Pick<WorkerTask, ...>` — narrow surface for test fixtures |
| `22-29` | `baseTask(overrides)` factory — sensible defaults, spreadable overrides |
| `31-42` | `makeWriter()` returns `{ writer, calls }` — recorded-call double, not a spy library |
| `44-46` | `fixedPathBuilder(path)` — closure returns a `TempPathBuilder` constant |
| `48-184` | Each test constructs `buildCodexInvocation(task, env, capabilities, writer, pathBuilder)` and asserts on returned struct + recorded calls |

**Seam style:** plain function injection via positional args, no DI container, no `sinon`. `lmstudio-agentic.ts:80-86` mirrors this with constructor opts `{ fetchImpl?, shellExec?, maxIterations? }` — equivalent surface, expressed as class options because runner is stateful.

Phase 3 tests at `lmstudio-agentic.test.ts:43-918` use the same `node:test` + `assert/strict` toolchain; T1-T8 describe blocks already scaffolded. T7 (`:803`) reads `cmd-run.ts` + `cmd-parallel.ts` source text to assert provider-literal wiring — uses helper `readSourceFile()` at `:34-39`.

---

## 11. Other Phase-3 Touchpoints (out-of-scope but adjacent)

- `src/errors.ts` — `makeError(code, message, retryable)` signature used throughout. Codes already in use that Phase 3 inherits: `TIMEOUT`, `PROVIDER_ERROR`, `INVALID_ARGS`, `UNSUPPORTED` (`lmstudio-agentic.ts:513`, `:540`).
- `src/context/layers.ts` — `buildDelegatedTask()` at `cmd-run.ts:107` produces `{ bareTask, contextPrefix }` — Phase 3 worker receives both as `task.task` + `task.contextPrefix` (already handled in `buildInitialMessages()` at `lmstudio-agentic.ts:99-114`).
- `src/runtime/store/run-store.ts` — `runStore.create/recordEvent/recordError` invoked by `cmd-run.ts:46-62`. Phase 3 worker does not interact with the store directly — `cmd-run.ts` owns lifecycle.

---

## 12. Delta Summary for Phase 3 Execution

**Already landed (do not redo):**
- Types `ToolDef`, `ToolCall`, `ToolCallMessage`, `WorkerTask.tools`, `WorkerResult.iterations`, `tool_call_count` (`types.ts:8-69`).
- `ExecutionModel = "tool_loop"` (`runner.ts:6`).
- Provider literal `'lmstudio-agentic'` in `cmd-run.ts:20`, `:28`, `:81-83`.
- Provider literal `'lmstudio-agentic'` in `cmd-parallel.ts:20`, `:54-56`, `:109-110`, `:113`.
- `lmstudio-agentic.ts` skeleton — class + `capabilities` + pure helpers (`buildInitialMessages`, `buildLfm2Nudge`, `canonicalJsonStringify`, `hashToolCall`, `computeTurnFingerprint`, `executeToolCall`, `probeCapability`).
- `lmstudio-agentic.test.ts` describe-block harness for T1-T8.

**Phase 3 remaining work (per PLAN.md tasks):** drive each describe block (`T3` exec sandbox at `:248`, `T4` loop at `:470`, `T5` detector at `:606`, `T6` LFM2 at `:731`, `T7` wiring smoke at `:803`, `T8` integration at `:918`) from RED → GREEN. No new file creation expected; no schema or dispatch changes.

---

*Map written: 2026-05-20 — HEAD `a6e8e1d`. Sources cited at line granularity for executor navigation.*
