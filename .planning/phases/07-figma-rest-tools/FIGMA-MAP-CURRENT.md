# FIGMA-MAP-CURRENT — Codebase State for Phase 7

**Mapped:** 2026-05-20
**Scope:** Phase 7 surface only — `src/tools/`, `src/config/`, secret-loading, `cmd-doctor`, codex MCP disable list, retry/fetch baseline, PII redaction baseline.

---

## 1. `src/tools/` — existing tool surface

All 14 files are flat (no subdirs). Each `handle*` is a pure function returning the MCP-style envelope `{ content: [{ type: 'text', text: <json string> }] }`.

| File | Handler | Args contract | Notes |
|---|---|---|---|
| `src/tools/memory_search.ts:22` | `handleMemorySearch(args: RecallArgs)` | `../contracts/memory.js` | SHIP-54 compact search; no touch/audit |
| `src/tools/recall.ts:8` | `handleRecall(args: RecallArgs)` | `../contracts/memory.js` | Touches + logs reads (SHIP-65) |
| `src/tools/remember.ts:8` | `handleRemember(args: RememberArgs, memorySource = 'worker-mcp')` | `../contracts/memory.js` | Second param for provenance |
| `src/tools/get_memory.ts:7` | `handleGetMemory(args: GetMemoryArgs)` | `../contracts/memory.js` | Uses `toMcpResult` helper |
| `src/tools/corpus_query.ts:17` | `handleCorpusQuery(args: CorpusQueryArgs)` | `../contracts/corpus.js` | Sets `isError: true` on not-found |
| `src/tools/browse_runs.ts:7` | `handleBrowseRuns(args: BrowseRunsArgs)` | `../contracts/browse_runs.js` | Maps to `BrowseRunProjection[]` |
| `src/tools/mcp-result.ts:1` | `toMcpResult<T>(data)` | — | Shared envelope helper |

**Shared local type** (duplicated in most tool files, NOT exported from a central module):

```
type McpToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
```
— see `src/tools/recall.ts:6`, `src/tools/memory_search.ts:20`, `src/tools/corpus_query.ts:12-15`, `src/tools/remember.ts:6`, `src/tools/get_memory.ts:5`.

**Pattern for new `figma_*` tool files:** create one file per handler under `src/tools/` (e.g., `figma_list_layers.ts`, `figma_update_token.ts`); import args type from `src/contracts/figma.ts` (new); use `toMcpResult` from `src/tools/mcp-result.ts:1`; return `isError: true` for token-missing / 403 / 429-after-retry.

---

## 2. ToolDef registration — there is NO central registry

**Crucial finding:** tool handlers do NOT register themselves anywhere. Each `handle*` is called directly by:

- **CLI surface** — `src/cli/cmd-memory-ops.ts:2,19,54`, `src/cli/cmd-verify.ts:55,85`, `src/cli/cmd-memory-auto-extract.ts:62`. CLI dispatch lives in `src/cli.ts` (not a registry — switch/case on positional argv).
- **Tests** — direct import + invoke.

**`ToolDef` (the OpenAI tool-schema shape) is a different concept**, used only by the agentic worker:

- Defined: `src/workers/types.ts:8-18` — `ToolFunctionDef { name, description?, parameters? }` and `ToolDef { type: "function"; function: ToolFunctionDef }`.
- Wired into task: `src/workers/types.ts:47` — `tools?: ToolDef[]` on `WorkerTask` (caller passes these in).
- Consumed by: `src/workers/lmstudio-agentic.ts:411` (`tools: task.tools` in the chat-completion body).
- Dispatched by name: `src/workers/lmstudio-agentic.ts:239 executeToolCall(...)` — currently hard-gated to `SHELL_EXEC_NAMES = new Set(['shell_exec', 'bash'])` at `src/workers/lmstudio-agentic.ts:47, 245-246`.

**Implication for Phase 7:** to expose Figma tools to the agentic worker, EITHER (a) extend `SHELL_EXEC_NAMES` semantics into a generic name→handler map (preferred — minimal blast radius), OR (b) add a parallel `FIGMA_TOOL_NAMES` set + dispatch branch. There is no "registerTool()" call site to extend — the registry is the `switch`-style code in `executeToolCall`. CLI exposure (e.g., `relay figma list-layers …`) is a separate addition to `src/cli.ts` mirroring the memory-command pattern.

---

## 3. `src/config/providers.ts` — env var loading pattern

The repo uses a **per-provider getter function** that reads `process.env[…]` lazily on each call (not at import time):

- `src/config/providers.ts:51` — `getOpenRouterApiKey()` → `process.env["OPENROUTER_API_KEY"]?.trim() || null`
- `src/config/providers.ts:59` — `getLmStudioApiKey()`
- `src/config/providers.ts:63` — `getAnthropicApiKey()`
- `src/config/providers.ts:71` — `getDynamicProviderKey(name)` — pattern `RELAY_PROVIDER_${name.toUpperCase()}_KEY`

**Pattern for FIGMA_API_TOKEN:** add `getFigmaApiToken(): string | null` returning `process.env["FIGMA_API_TOKEN"]?.trim() || null`. Lazy read (not module-scoped const) — required so users can `source ~/.relay/secrets` after process start in test contexts.

Header pattern reference: dynamic provider headers are constructed from env at `src/config/providers.ts:93-111`. Figma differs: only ONE header (`X-Figma-Token`) — no need for a generic header-collector; hardcode the header name in the tool fetch call.

---

## 4. `~/.relay/secrets` — current state

**File, not directory.** Confirmed via `stat`:

```
-rw------- ghanavati staff 4541 /Users/ghanavati/.relay/secrets       ← chmod 600 OK
-rw------- ghanavati staff 4457 /Users/ghanavati/.relay/secrets.bak   ← chmod 600 OK
-rw-r--r-- ghanavati staff  101 /Users/ghanavati/.relay/config.json   ← 0644 (JSON, non-sensitive)
```

**Format:** single shell-source file. Header (line 1): `# relay-mcp — secrets & runtime config`. Each entry is a `#`-commented section followed by `VAR_NAME=value` lines. Loading mechanism (per the file's own self-documentation): `~/.zshrc` sources it; tools inherit via shell env.

**Existing keys (shape only, no values):** `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `LMSTUDIO_ENDPOINT`, `RELAY_ALLOWED_ROOTS`, `BERRY_API_URL`, `RELAY_DISABLE_COMPRESS_WRAPPERS`. Anthropic / Gemini-secondary slots commented out as `# VAR=REPLACE_WITH_YOUR_…`.

**No in-repo code reads `~/.relay/secrets` directly.** Grep for `loadSecrets|readSecrets|.relay/secrets` across `src/**.ts` returns zero matches. Loading is entirely out-of-process (zshrc). The `homedir()` references in `src/cli/cmd-doctor.ts:34,161,252`, `src/cli/cmd-init.ts:48`, etc. point at `~/.relay/config.json`, `~/.claude/settings.json`, `~/.relay/relay.db`, `~/.relay/relay.ndjson` — never `~/.relay/secrets`.

**`chmod 600` enforcement:** there is currently NO code path that creates `~/.relay/secrets` or enforces 0600. The user maintains it manually. `src/workers/codex.ts:49` is the only spot that writes a file with mode `0o600` (the codex tempfile writer). For Phase 7, if the plan introduces an auto-add flow, enforce `mode: 0o600` on write — mirror that codex pattern.

**Implication:** Phase 7 should NOT introduce a new secrets directory. `FIGMA_API_TOKEN` simply joins the existing flat file. Documentation should add a section to the secrets-file template; no code change needed for loading itself.

---

## 5. `src/cli/cmd-doctor.ts` — patterns for `--figma` probe

**`ProviderProbe` interface:** `src/cli/probes.ts:16-20`

```
interface ProviderProbe { name: string; status: 'ok' | 'failed' | 'missing'; detail: string; }
```

Status semantics (verbatim from probes.ts header comment, lines 1-11): `ok` = reachable/configured; `failed` = attempted and explicitly failed; `missing` = env-var unset.

**Three probe styles to copy:**

1. **Env-key only** — `probeEnvKey(envName, label)` at `src/cli/probes.ts:62-67`. One-liner: returns `ok` if `process.env[envName]` is set, `missing` otherwise. Used at `src/cli/cmd-doctor.ts:435` (`OPENROUTER_API_KEY`), `:441` (`ANTHROPIC_API_KEY`).
2. **HTTP reachability** — `probeLmStudio()` at `src/cli/probes.ts:38-56`. Uses `fetch` + `AbortController` with 3s timeout; checks `res.ok`; reports model count on success, generic failure detail on error.
3. **CLI invocation** — `probeCodex()` at `src/cli/probes.ts:23-34`. Uses `execFile` + 5s timeout.

**Recommended `--figma` probe shape (FIGMA-equivalent of probeLmStudio):**
- If `FIGMA_API_TOKEN` unset → `{ name: 'figma', status: 'missing', detail: 'FIGMA_API_TOKEN not set' }` (cheap, no HTTP).
- If set → `GET https://api.figma.com/v1/me` with `X-Figma-Token` header, 3-5s timeout. `res.ok` → `ok` with user email/handle in detail. Otherwise `failed` with status-only (NEVER log the response body — may contain account info).

**Registration site:** `executeDoctorCommand` at `src/cli/cmd-doctor.ts:422`. Add the new `record(await probeFigma())` call between probes 4 (`ANTHROPIC_API_KEY`, `:441`) and 5 (DB check, `:444-453`) — keep API-key probes grouped before infrastructure probes.

**`--json` envelope shape:** `src/cli/cmd-doctor.ts:490` — `JSON.stringify({ checks, summary })` where `summary = { ok, missing, failed }` (counts). No nesting under `checks` — flat `ProviderProbe[]`. Exit code: `summary.failed > 0 ? 1 : 0` at `:505`. New figma probe slots in transparently — `missing` does NOT increment exit code 1.

**CliIO interface (output channel):** `src/cli/commands.ts:8-12` — `{ cwd, stdout, stderr }`.

---

## 6. `src/workers/codex.ts:72` — `DISABLED_CODEX_MCP_LABELS`

**Confirmed:** `'figma'` IS in the disable set today.

```
src/workers/codex.ts:72: const DISABLED_CODEX_MCP_LABELS = new Set(['figma', 'notion', 'pencil']);
```

**Usage sites:**
- `src/workers/codex.ts:271-273` — iterates set, appends `-c mcp_servers.<label>.enabled=false` to codex globalArgs (hard-disable at config level).
- `src/workers/codex.ts:275-277` — filters out matching `ResolvedMcpAttachment` entries from `task.mcps`.

**Implication for Phase 7:** the disable is specifically for MCP-server-style figma attachments to the Codex CLI. If Phase 7 implements figma as **direct REST tools inside `lmstudio-agentic`** (not as a Codex MCP server), this set does NOT need to change — figma stays disabled for Codex (correctly: Codex is the coding worker, figma is design context). If the plan ever wants figma callable from Codex, remove `'figma'` from this set. PLAN should explicitly state which path.

`ResolvedMcpAttachment` shape: `src/contracts/mcp.ts:34-38` — `{ url, label?, headers? }`.

---

## 7. Retry / backoff / Retry-After — baseline state

**There is NO retry-with-backoff helper anywhere in the repo.** Grep results:

- `Retry-After` / `retry-after` — **zero matches** across `src/`.
- `exponential` — only `src/memory/memory-engine.ts:25` (memory recency-scoring decay, unrelated).
- `backoff` — zero matches in source (test file uses the word in a label only).

**All current HTTP callers fail-fast on non-2xx** — no retry loop, no jitter, no `Retry-After` parsing:
- `src/workers/anthropic.ts:39-68` — single `fetch`, returns `PROVIDER_ERROR` immediately on `!res.ok`.
- `src/workers/lmstudio-agentic.ts:419-451` — single `fetch` per loop iteration, no retry.
- `src/workers/generic-http-runner.ts:76-94` — single `fetch`, fail-fast.
- `src/memory/auto-extract-runner.ts:99,162` — single `fetch`, no retry.
- `src/memory/embedding-client.ts:109,195` — classifies HTTP reason but does not retry.

**Implication for Phase 7 (FIGMA-04):** Phase 7 must introduce the FIRST retry+backoff implementation in the repo. Recommended placement: a new shared helper `src/workers/http-retry.ts` (or `src/tools/figma-fetch.ts` if scope-limited) consuming `Retry-After` (per RFC 7231 — both delta-seconds AND HTTP-date), full jitter on retries, capped attempts (e.g., 3), respecting `task.timeout_ms` parent budget. Reference 429 handling pattern from `src/memory/embedding-client.ts:109` (`classifyHttpReason`) — extend or replace, but document the choice.

---

## 8. Native fetch — confirmed, no axios

**Zero matches** for `from 'axios'` / `require('axios')` across the repo.

**All HTTP uses native `fetch`** (Node 18+ global). Reference call sites:
- `src/workers/anthropic.ts:39` — POST with `headers, body: JSON.stringify(...), signal: controller.signal`.
- `src/workers/lmstudio-agentic.ts:419-424` — same pattern, includes `signal` from `AbortController`.
- `src/cli/probes.ts:41` — GET with `signal: controller.signal`, `clearTimeout` in finally-style.
- `src/cli/cmd-init.ts:113`, `src/cli/cmd-setup-llm.ts:204,264` — same.
- `src/workers/generic-http-runner.ts:76` — generic POST.

**Pattern to copy for Figma tools:** `AbortController` + `setTimeout(() => controller.abort(), TIMEOUT_MS)` + `signal: controller.signal` in fetch options; `clearTimeout(timer)` on both success and error paths. Example: `src/cli/probes.ts:38-56`.

---

## 9. `src/security/redaction-pii.ts` — figma PAT regex absent

**Confirmed:** figma PAT regex is NOT yet present.

- `src/security/redaction-pii.ts:35-82` — `PII_PATTERNS` lists: `jwt`, `gh_fine_grained_pat`, `stripe`, `gcp_service_account`, `db_url`, `email`, `ipv4_private`, `internal_lan_host`, `env_assignment`. **No `figma` entry.**
- `src/security/redaction.ts:7-46` — base `REDACTION_PATTERNS` lists: `aws_key`, `bearer`, `openai_key`, `github_pat` (classic ghp_), `slack_token`, `generic_api`, `env_assignment`, `private_key`. **No `figma` entry.**

Grep across `src/` for `figd_` / `FIGMA_PERSONAL` / `figd-` / `figma.*pat` returns **zero matches**.

**Figma PAT format reference (for the regex to add):** Figma personal access tokens start with `figd_` followed by a long opaque token (typically 40+ chars of `[A-Za-z0-9_-]`). Phase 7 must add to `REDACTION_PATTERNS` (so memory writes redact it — `redact.ts` is the right file because PII_PATTERNS is auto-extract-only, but tokens leak into worker stdout too). Proposed entry shape mirroring `github_pat`:

```
{ name: 'figma_pat', pattern: /figd_[A-Za-z0-9_-]{40,}/g, replacement: '[REDACTED:FIGMA_PAT]' }
```

Place in `src/security/redaction.ts` (the always-on set), not `redaction-pii.ts` (which is gated to auto-extract per the module's own doc comment at lines 22-34). Add a test alongside existing redaction tests.

---

## Summary of insertion points for Phase 7

| Concern | File | Action |
|---|---|---|
| Tool files | `src/tools/figma_list_layers.ts`, `src/tools/figma_update_token.ts` (new) | Mirror `recall.ts` shape; use `toMcpResult` |
| Args schemas | `src/contracts/figma.ts` (new) | Zod schemas, mirror `src/contracts/memory.ts` |
| Env getter | `src/config/providers.ts` add `getFigmaApiToken()` | Lazy `process.env[...]?.trim() || null` |
| Worker dispatch | `src/workers/lmstudio-agentic.ts:47, 239-246` | Extend dispatch beyond `SHELL_EXEC_NAMES` |
| Doctor probe | `src/cli/cmd-doctor.ts:441`-ish | Insert `record(await probeFigma())` |
| Probe impl | `src/cli/probes.ts` add `probeFigma()` | GET /v1/me with X-Figma-Token, AbortController |
| Codex MCP set | `src/workers/codex.ts:72` | Leave `'figma'` in set (REST tools ≠ MCP attach) |
| Retry helper | `src/workers/http-retry.ts` (new) | First-of-its-kind; Retry-After + jitter + caps |
| PAT redaction | `src/security/redaction.ts:7-46` | Add `figma_pat` regex `/figd_[A-Za-z0-9_-]{40,}/g` |
| Secrets file | `~/.relay/secrets` (user-owned) | Doc-only update; chmod 600 already enforced manually |

**No relay-mcp / MCP server scaffolding required** — `src/mcp/` directory does NOT exist; tools are called as in-process functions from CLI commands and from the agentic worker's `executeToolCall` switch.
