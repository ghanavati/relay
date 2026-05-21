# Workers Subsystem Map — v0.2

**Scope:** `src/workers/` subtree + dispatch + all LM Studio HTTP call sites.
**Source of truth for ROADMAP #2:** agentic local LLM runner insertion points.
**Date:** 2026-05-18. Read-only inventory.

---

## 1. Files in `src/workers/`

| File | Lines | Class/Exports | `capabilities` | Mode |
|---|---|---|---|---|
| `runner.ts` | 21 | `WorkerRunner` iface, `WorkerCapabilities`, `IntegrationLevel`, `AdapterType`, `ExecutionModel`, `getRunnerCapabilities()` | — (contract) | — |
| `types.ts` | 66 | `WorkerTask`, `WorkerResult`, `WorkerStatus`, `DelegateMeta`, `DelegateResponse` | — (contract) | — |
| `codex.ts` | 656 | `CodexRunner` class (line 650), `runCodexWorker()` (397), `buildCodexInvocation()` (184), `buildCodexArgs()` (329), `parseCodexLine()` (163), `deriveCodexCliCapabilities()` (105), `CodexCliCapabilities` iface (62) | `{ agentic: true, execution_model: "subprocess" }` (line 651) | **agentic** subprocess |
| `lmstudio.ts` | 51 | `LmStudioRunner` class (31), `parseLmStudioResponse()` (20) | inherits `{ agentic: false }` from `GenericHttpRunner` (line 25) | **single-shot** HTTP |
| `openrouter.ts` | 66 | `OpenRouterRunner` class (35), `parseOpenRouterResponse()` (21) | inherits `{ agentic: false }` from `GenericHttpRunner` | **single-shot** HTTP |
| `anthropic.ts` | 120 | `AnthropicRunner` class (9) | `{ agentic: false }` literal (line 10) | **single-shot** HTTP |
| `generic-http-runner.ts` | 189 | `GenericHttpRunner` class (24), `GenericHttpProviderConfig` iface (15), `extractOutputText()` (140) | `{ agentic: false }` literal (line 25) | **single-shot** HTTP base |
| `codex.test.ts` | 185 | tests | — | — |
| `anthropic.test.ts` | 114 | tests | — | — |
| `generic-http-runner.test.ts` | 198 | tests | — | — |

**Note:** there is NO `lmstudio.test.ts` — LM Studio is covered transitively by `generic-http-runner.test.ts`.

**Comment at `generic-http-runner.ts:6-13`** is stale — claims `Subclasses (LmStudioRunner, OpenRouterRunner) provide endpoint + headers` for "solo Relay v0.1.0", "no agentic tool-loop". This is the contract the new `lmstudio-agentic.ts` must break.

---

## 2. `WorkerRunner` interface — full signature

File: `src/workers/runner.ts:14-17`

```ts
export interface WorkerRunner {
  readonly capabilities?: WorkerCapabilities;
  run(task: WorkerTask): Promise<WorkerResult>;
}
```

Supporting types (`runner.ts:3-12`):

```ts
export type IntegrationLevel = "callable" | "status" | "full";
export type AdapterType = "openclaw" | "process" | "http";
export type ExecutionModel = "relay-loop" | "subprocess";

export interface WorkerCapabilities {
  agentic: boolean;
  integrationLevel?: IntegrationLevel; // undefined = "full" for built-ins
  adapterType?: AdapterType;           // undefined = native runner
  execution_model?: ExecutionModel;
}

export function getRunnerCapabilities(runner: WorkerRunner): WorkerCapabilities {
  return runner.capabilities ?? { agentic: false };
}
```

**For new agentic runner:** declare `capabilities = { agentic: true, execution_model: "relay-loop" } as const` (NOT "subprocess" — LM Studio is in-process HTTP, no child process).

---

## 3. `WorkerTask` / `WorkerResult` contract — full shape

File: `src/workers/types.ts`

```ts
// types.ts:5
export type WorkerStatus = "success" | "error" | "timeout";

// types.ts:7-21
export interface WorkerTask {
  task: string;
  contextPrefix?: string;        // stable layers for Anthropic prompt caching; bare task in `task` when set
  workdir: string;
  timeout_ms: number;
  model?: string;
  reasoning_effort?: string;
  codex_approval_policy?: string;
  mcps?: ResolvedMcpAttachment[];
  images?: string[];             // multimodal (OpenRouter/LM Studio only)
  logStream?: WriteStream;
  onStderr?: (text: string) => void;
  run_id: string;
  provider: string;
}

// types.ts:23-37
export interface WorkerResult {
  status: WorkerStatus;
  output: string;
  duration_ms: number;
  exit_code: number | null;
  error?: RelayError;
  token_usage?: number | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  cost_usd?: number | null;
  thinking_blocks?: number;
  tool_use_blocks?: number;
  file_reads_before_first_write?: number;
  tool_retry_count?: number;
}
```

`DelegateMeta` / `DelegateResponse` (`types.ts:39-66`) are MCP-shell envelopes — not used inside workers themselves.

**Behavioral signals** (`thinking_blocks`, `tool_use_blocks`, `file_reads_before_first_write`, `tool_retry_count`) are produced by codex.ts (`codex.ts:566-571`) — the new agentic runner SHOULD populate the same fields so downstream telemetry stays uniform.

---

## 4. `codex.ts` — pattern for `agentic: true`

### Declaration site

`codex.ts:650-656`:

```ts
export class CodexRunner implements WorkerRunner {
  readonly capabilities = { agentic: true, execution_model: "subprocess" } as const;

  run(task: WorkerTask): Promise<WorkerResult> {
    return runCodexWorker(task);
  }
}
```

Thin class — all work is in `runCodexWorker()` (`codex.ts:397-647`).

### Key agentic-loop structure to mirror

Codex is "agentic" because Codex CLI runs its own tool-loop in a subprocess. Relay's job: spawn, stream JSONL, parse `agent_message` items, count behavioral signals. For `lmstudio-agentic.ts`, Relay itself must implement the tool-loop (no subprocess).

| Phase | Codex location | LM Studio analog needed |
|---|---|---|
| Capability probe | `getCodexCliCapabilities()` `codex.ts:149` | Probe `/v1/models` once; cache per (endpoint, model) |
| Build invocation | `buildCodexInvocation()` `codex.ts:184-326` | Build initial messages array w/ system + tools |
| Spawn / call | `spawn(codexBin, ...)` `codex.ts:435` | `fetch(POST /v1/chat/completions)` in a loop |
| Stream parser | `parseCodexLine()` `codex.ts:163-181` (JSONL event → text) | Parse `choices[0].message.tool_calls` to drive next turn |
| Behavioral counters | `codex.ts:461-484` (`countBlockType`) — increments `thinking_blocks`, `tool_use_blocks`, `file_reads_before_first_write`, `tool_retry_count` | Re-implement same counters from tool_call events |
| Timeout w/ SIGKILL escalation | `codex.ts:512-529` | AbortController per request + outer wall-clock check |
| Context injection | `model_instructions_file` TOML override `codex.ts:296-307` | System message slot — already supported by GenericHttpRunner pattern `generic-http-runner.ts:52-58` |
| Result envelope | `codex.ts:597-603` (success), `573-595` (timeout/error) | Identical `WorkerResult` shape |

### Critical patterns from codex.ts to copy

1. **stdout buffering for streaming** — `codex.ts:486-500`: chunk into lines, retain trailing partial. LM Studio agentic equivalent: if you stream, same buffer pattern; if you don't, batch per turn.
2. **Final-flush on close** — `codex.ts:545-552`: process any leftover `stdoutBuf`. Equivalent: ensure final tool result included.
3. **Wall-clock timeout returns `WorkerResult{status:"timeout"}` not throw** — `codex.ts:573-583`. Mirror exactly.
4. **`agentic` capability is a flag, not behavior** — capability only declares intent. Loop behavior is in `runCodexWorker()`. Same for `lmstudio-agentic.ts`.

---

## 5. `lmstudio.ts` — current single-shot path

File: `src/workers/lmstudio.ts:31-51`

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

`parseLmStudioResponse()` (`lmstudio.ts:20-29`) — extracts `choices[0].message.content` (array or string) and `usage.completion_tokens`. **NOT used** by the runner itself (which delegates to `GenericHttpRunner.run`); only exported for testing.

### GenericHttpRunner.run flow (`generic-http-runner.ts:29-138`)

1. Validate model present (`requiresModel`) → return `INVALID_ARGS` if missing (line 32-44).
2. Build messages: if `contextPrefix` → `[{role:system}, {role:user}]`; else just `user` (line 52-58).
3. Build body — `chat-completions` shape default (line 66-70).
4. `fetch(url, { signal: AbortController, timeout })` (line 76-81).
5. On non-OK: `WorkerResult{status:"error", error:PROVIDER_ERROR(retryable)}` (line 85-98).
6. On OK: extract via `extractOutputText` (line 140-188) → return `WorkerResult{status:"success", ...usage}`.
7. On abort: `status:"timeout"`. On other catch: `status:"error", PROVIDER_ERROR`.

**No tool-loop. No re-invocation. One round-trip.**

---

## 6. Provider dispatch in `src/cli/cmd-run.ts`

**Insertion site:** `src/cli/cmd-run.ts:67-91`

```ts
let runner;
try {
  if (args.provider === 'codex') {
    const { CodexRunner } = await import('../workers/codex.js');
    runner = new CodexRunner();
  } else if (args.provider === 'lmstudio') {                      // ← line 72
    const { LmStudioRunner } = await import('../workers/lmstudio.js');
    runner = new LmStudioRunner();
  } else if (args.provider === 'openrouter') {
    ...
  } else if (args.provider === 'anthropic') {
    ...
  } else {
    const exhaustive: never = args.provider;
    ...
  }
}
```

**Type union at `cmd-run.ts:20`:**
```ts
provider: 'codex' | 'openrouter' | 'lmstudio' | 'anthropic';
```

**HTTP_PROVIDERS set at `cmd-run.ts:28`:**
```ts
const HTTP_PROVIDERS = new Set(['openrouter', 'lmstudio', 'anthropic']);
```

### Insertion strategy for `lmstudio-agentic`

The dispatch is an exhaustive `if/else if` checked by `const exhaustive: never = args.provider` (line 82). Adding a new provider requires:

1. **Add to type union** `cmd-run.ts:20` — e.g. `'lmstudio-agentic'` or keep `'lmstudio'` and switch on a new flag.
2. **Add dispatch branch** `cmd-run.ts:72-74` area.
3. **Register in `BUILTIN_PROVIDERS`** `src/config/providers.ts:8-15`.
4. **Update `cli.ts` provider list:** `src/cli.ts:259-261` (validation), `src/cli.ts:771` (`validTargets`).
5. **Update `cmd-parallel.ts`** parallel dispatch: `src/cli/cmd-parallel.ts:37-55` (`getRunner`), line 20 type union, line 105-106 validation sets.
6. **Update `cmd-completion.ts:38`** `PROVIDERS` array.
7. **Update `cmd-init.ts`** wiring (`src/cli/cmd-init.ts:316`, 337-area auto-setup).
8. **Update `contracts/delegate.ts:19`** zod description string.

**Recommended approach (less surface area):** keep `provider === 'lmstudio'` and switch within the lmstudio dispatch on an env var or task field (e.g., `RELAY_LMSTUDIO_AGENTIC=1` or `task.agentic === true`). Only the branch at `cmd-run.ts:72-74` changes:

```ts
} else if (args.provider === 'lmstudio') {
  if (shouldUseAgenticLmStudio(args, process.env)) {
    const { LmStudioAgenticRunner } = await import('../workers/lmstudio-agentic.js');
    runner = new LmStudioAgenticRunner();
  } else {
    const { LmStudioRunner } = await import('../workers/lmstudio.js');
    runner = new LmStudioRunner();
  }
}
```

Mirror the same branch in `src/cli/cmd-parallel.ts:42-45`.

### Dispatch context payload (`cmd-run.ts:112-121`)

```ts
result = await runner.run({
  task: built.bareTask,
  contextPrefix: built.contextPrefix,
  workdir: args.workdir,
  timeout_ms: args.timeoutMs,
  model: args.model,
  reasoning_effort: args.reasoningEffort,
  run_id,
  provider: args.provider,
});
```

`buildDelegatedTask()` (`src/context/layers.ts`) splits into `bareTask` + `contextPrefix` — agentic runner MUST preserve that split and inject `contextPrefix` as a system message (not concatenated into user message), per the comment at `generic-http-runner.ts:49-51`.

---

## 7. All LM Studio HTTP call sites (whole codebase)

### `/v1/chat/completions` (POST)

| File:Line | Caller | Purpose |
|---|---|---|
| `src/workers/lmstudio.ts:35` | `LmStudioRunner.constructor` (via `getUrl`) | Production single-shot inference |
| `src/memory/auto-extract-runner.ts:151` | `callChatCompletions()` private | Memory lesson extraction (V1 LM-Studio-only) |
| `src/cli/cmd-setup-llm.ts:92` | bash heredoc | Generated test snippet for user |
| `src/memory/auto-extract-runner.test.ts:233-234` | test fixture | mock-fetch assertion |
| `src/cli/cmd-memory-auto-extract.ts:891` | doc comment | inline reference |

### `/v1/models` (GET — probe)

| File:Line | Caller | Purpose |
|---|---|---|
| `src/cli/probes.ts:41` | `probeLmStudio()` | Health probe (3s timeout) |
| `src/cli/cmd-init.ts:113` | `fetchLmStudioModels()` | List loaded models during init |
| `src/cli/cmd-setup-llm.ts:204` | inline | Setup wizard probe |
| `src/memory/auto-extract-runner.ts:96` | `probeLmStudio()` private | Pre-flight before extraction |

### `/v1/embeddings`

**NOT FOUND.** No call sites in `src/`. The roadmap mention is forward-looking only.

### Hardcoded endpoint default `http://localhost:1234`

| File:Line | Context |
|---|---|
| `src/config/providers.ts:56` | `getLmStudioEndpoint()` — central default, single source of truth |
| `src/cli/probes.ts:37` | `probeLmStudio()` — duplicates default (bypasses config helper) |
| `src/cli/cmd-init.ts:109` | `fetchLmStudioModels()` — duplicates default |
| `src/cli/cmd-setup-llm.ts:81,202` | wizard text + inline fetch |
| `src/cli/cmd-memory-auto-extract.ts:156` | `DEFAULT_ENDPOINT` constant |
| `src/memory/auto-extract-runner.ts:35` | jsdoc only |

**Tech-debt note:** 5 duplications of the `http://localhost:1234` default outside `getLmStudioEndpoint()`. New agentic runner should call `getLmStudioEndpoint()` to stay consistent.

### Env vars

- `LMSTUDIO_ENDPOINT` — `getLmStudioEndpoint()` `src/config/providers.ts:55-57`
- `LMSTUDIO_API_KEY` — `getLmStudioApiKey()` `src/config/providers.ts:59-61` (optional Bearer token)

### Other emit/context targets (not HTTP)

- `lmstudio-http` / `lmstudio-cli` — `relay context emit --target` (`src/cli/cmd-context-emit.ts:168-176`). Produces system-message fragments; no network I/O.

---

## 8. Insertion checklist for `lmstudio-agentic.ts` (no-code-change summary)

1. **New file:** `src/workers/lmstudio-agentic.ts` — class `LmStudioAgenticRunner implements WorkerRunner` with `capabilities = { agentic: true, execution_model: "relay-loop" } as const`.
2. **Reuse:** `getLmStudioEndpoint()`, `getLmStudioApiKey()` from `src/config/providers.ts`.
3. **Copy patterns from codex.ts:**
   - Behavioral counters (`codex.ts:461-484`).
   - Wall-clock timeout w/ `AbortController` (`codex.ts:512-529`, simpler version).
   - Result envelope branches (`codex.ts:573-603`).
4. **Tool-loop body** — new code (no existing pattern):
   - Build initial messages w/ system (`contextPrefix`) + user (`task.task`).
   - Loop until response has no `tool_calls` OR loop-cap reached OR timeout.
   - Each iteration: POST `/v1/chat/completions` w/ `tools` schema and accumulated `messages`; on `tool_calls`, execute locally and append `role:tool` messages; recurse.
5. **Dispatch:** modify `src/cli/cmd-run.ts:72-74` and `src/cli/cmd-parallel.ts:42-45` per Section 6 strategy.
6. **No changes needed to:** `runner.ts`, `types.ts`, `generic-http-runner.ts`, `providers.ts` (if reusing `'lmstudio'` provider name).
7. **Tests:** add `src/workers/lmstudio-agentic.test.ts` (currently no `lmstudio.test.ts` either — agentic version sets new bar).

---

*End of map. ~310 lines.*
