# Phase 9: v0.4 Lean Core — Agnostic Dispatch + MCP Memory Server - Context

**Gathered:** 2026-06-09 (rescoped same day after the v0.4 scrutiny — see `.planning/RELAY-V04-SCOPE.md` and `.planning/LESSONS-FROM-RELAY-MCP.md`)
**Status:** Ready for execution
**Source:** Maintainer-driven scope cut. The original Phase 9 draft (6 plans) centered on exposing session-control over MCP; that scope is KILLED. What remains is the v0.4 lean core: model-agnostic dispatch + a thin stdio MCP server exposing memory only.

<domain>
## Phase Boundary

Two deliverables, nothing else:

1. **Agnostic dispatch** — any OpenAI-compatible (or Anthropic-messages) endpoint becomes a `relay run` provider via `RELAY_PROVIDER_<NAME>_URL|KEY|TYPE|HEADER_*` env config. The closed provider unions die. The pattern is ported from the sunsetted relay-mcp predecessor (`src/config/providers.ts` + `registry.ts` there — pattern only, fresh code). Builtins (codex, openrouter, lmstudio, lmstudio-agentic, anthropic) keep working byte-identically. Run records keep the raw provider usage as a receipt — no price map, no dollar math.

2. **Thin stdio MCP server** — `relay mcp` exposes exactly two tools to MCP clients: `relay_memory_recall` and `relay_memory_save`, wrapping the existing handlers, schemas, store, and workdir scoping. SDK pinned + build-time verified. Stdout is protocol-only.

This is additive. The `relay` CLI keeps working exactly as today (plus two new commands: `mcp`, `providers`).

### Memory subsystem: verified existing, NOT built here

The v0.4 scope's memory requirements were inventoried against the codebase on 2026-06-09 — they already exist. No memory build work in this phase:

| v0.4 memory requirement | Status | Evidence |
|---|---|---|
| Workspace scoping | EXISTS | `src/memory/types.ts:36` (workdir col), `memory-store.ts:1082` (scoped WHERE), `memory-store.ts:69-79` (RELAY_MEMORY_ALLOWED_WORKDIRS gate) |
| entity_key wiki-upsert | EXISTS | `memory-store.ts:777-893` (upsert + supersession) |
| Token-budgeted recall | EXISTS | `contracts/memory.ts:49-54`, `memory-engine.ts:243-309` (budgetedRecall) |
| Unverified-default + outcome trust | EXISTS | `types.ts:19` (TrustLevel), `memory-store.ts:51-60` (computeTrustLevel), `memory-store.ts:1141-1177` (markRecallSuccess) |
| Redaction on save | EXISTS | `memory-store.ts:62-66` (sanitizeContent → redactSecrets) |
| FTS5 keyword recall | EXISTS | `db-migrations.ts:42-56` (fts5 vtable + triggers), `memory-store.ts:1027-1040` (MATCH/bm25) |
| No RAG in v1 | CONFIRMED | optional lazy embeddings exist (`memory-store.ts:311-349`) but recall works without; no vector DB |

</domain>

<decisions>
## Implementation Decisions

### Dispatch
- **D-01:** Env naming: `RELAY_PROVIDER_<NAME>_URL` (required for dynamic), `_KEY` (optional; configs store the env-var NAME, value resolved at request time), `_TYPE` (protocol adapter), `_HEADER_*` (extra headers). The relay-mcp adapter zoo (ADAPTER_TYPE/OPENCLAW/EXECUTABLE/INTEGRATION_LEVEL) is NOT ported — it served the predecessor's scope sprawl.
- **D-02:** `_TYPE` enum v1 = `openai` (chat-completions wire, default) | `anthropic` (messages wire). `openai-responses` deferred: OpenAI still serves chat/completions and nearly all third parties are chat-completions-compatible. Revisit when a real endpoint needs it.
- **D-03:** Dynamic providers are single-shot (non-agentic) in v1; the agentic tool_loop stays bound to lmstudio-agentic. Generalizing agentic to dynamic providers is a later, measured step.
- **D-04:** Builtin names win. An env definition colliding with a builtin name is a RelayError, never a silent override.
- **D-05:** Usage receipt only: prompt/completion/total tokens from the provider response, persisted on the run record uniformly for both wire shapes. No price map, no cost math (killed scope — provider dashboards own pricing; a drifting price map is a confident wrong number).

### MCP surface
- **D-06:** stdio transport only for v1. Reach: any MCP-client app — Claude Desktop/Code, Cursor, Codex, Windsurf, and harnesses that run those agents (e.g. Conductor). v2 (deferred): remote HTTP transport + OAuth 2.1 DCR for ChatGPT/web, fronted by OpenAI's Secure MCP Tunnel so Relay stays local. Do NOT slide into hosting.
- **D-07:** Tools exposed: `relay_memory_recall` + `relay_memory_save`. NOTHING else — no session-control tools, no dispatch/run tool, no shell surface. Memory is Relay's one genuinely unique value (persists across sessions AND tools); everything else over MCP duplicated host capabilities or expanded attack surface.
- **D-08:** Single source of truth for schemas: the MCP inputSchema IS `RecallArgsSchema`/`RememberArgsSchema` from `src/contracts/memory.ts` (already exported — no new export work).
- **D-09:** New code confined to `src/mcp/` + an `mcp` branch and a `providers` branch in `src/cli.ts`. Thin wrappers call existing handlers (`handleRecall`/`handleRemember`); no parallel implementation.
- **D-10:** Workdir scoping (`RELAY_MEMORY_ALLOWED_WORKDIRS`) applies over MCP exactly as in the CLI (inherited from MemoryStore.assertWorkdirAllowed — wrap, don't bypass). Save consent = same gate as the CLI, no looser path (formerly O-03, now decided).
- **D-11:** Redaction (`redactSecrets`) runs on every value crossing the MCP boundary — results AND error messages. RelayError maps to an MCP isError result; unknown throws map to a generic redacted result. Centralized in `src/mcp/result.ts`.
- **D-12:** Official MCP TypeScript SDK, exact-pinned, name/maintainer/version verified before install (supply-chain gate), import surface verified against the installed package via `resolveMcpSdk` — never hardcoded from docs.
- **D-13:** `relay mcp` is blocking, speaks MCP on stdin/stdout, logs to stderr only. Docs ship the `.mcp.json` registration block.
- **D-14:** No per-connection control session. The earlier draft bound MCP connections to llm-kind control sessions; with control tools killed, that machinery is unnecessary for a memory server. Provenance = the memory source tag (unverified-by-default trust for non-human sources) + the store's own write gates (rate limit, dedup, redaction).

### Resolved former open questions
- **O-01 (dispatch over MCP):** RESOLVED — killed for v1 entirely (not just deferred from the tool list). Side-effecting dispatch over MCP needs its own consent design; nothing ships until that exists.
- **O-02 (MCP session identity):** MOOT — no control session is created (D-14).
- **O-03 (save consent):** RESOLVED — same workdir gate as the CLI (D-10).
</decisions>

<open_questions>
## Open — none

All draft-phase open questions were resolved by the v0.4 rescope (see above).
</open_questions>

<canonical_refs>
## Code References (MUST read before implementing)

### Dispatch (Plan 01)
- `src/cli/cmd-run.ts` — the five hardwired providers + closed union to replace with registry resolution.
- `src/workers/generic-http-runner.ts`, `openrouter.ts`, `lmstudio.ts` — the HTTP runner base + subclasses to parameterize.
- `src/workers/anthropic.ts` — messages-wire shaping to REUSE for anthropic-type dynamic providers.
- `src/workers/runner.ts`, `types.ts` — WorkerResult fields (token_usage, prompt_tokens, completion_tokens).
- `src/runtime/store/run-store.ts` — run records where the usage receipt persists.
- `/Users/ghanavati/ai-stack/Projects/relay-mcp/src/config/providers.ts` — READ-ONLY pattern source for env discovery (port pattern, write fresh code).

### MCP (Plans 02–05)
- `src/tools/recall.ts`, `src/tools/remember.ts` — the handlers the MCP tools wrap (already emit the `{content}` envelope; do NOT redact — the wrapper does).
- `src/contracts/memory.ts` — recallSchema/RecallArgsSchema, rememberSchema/RememberArgsSchema (already exported; the single source of truth).
- `src/memory/memory-store.ts` — assertWorkdirAllowed (the scoping gate, ~lines 69-79), write rate limit, dedup.
- `src/security/redaction.ts` — redactSecrets/REDACTION_PATTERNS (boundary redaction).
- `src/errors.ts` — RelayError shape for the error mapping.
- `src/cli.ts` — dispatcher; add `mcp` + `providers` branches (study session/tui branches).
- `package.json`, `tsconfig.json` — ESM/module settings new files must match.

### Scope guards
- `.planning/RELAY-V04-SCOPE.md` — the build/kill/defer record this phase implements.
- `.planning/LESSONS-FROM-RELAY-MCP.md` — why the kill list exists; the predecessor died of scope, not engineering.

## External
- MCP TypeScript SDK (Context7 `/modelcontextprotocol/typescript-sdk`): `McpServer({name,version})`, `registerTool(name,{description,inputSchema:<zod>},handler)` → `{content:[{type:'text',text}], isError?}`; `StdioServerTransport` + `await server.connect(transport)`. Exact package/import verified at build time (D-12).
</canonical_refs>

<non_goals>
## Out Of Scope (the v0.4 kill/defer list — enforced)

KILLED (do not build, do not partially build):
- Session-control tools over MCP / MCP-caller-as-control-session — the entire old 09-04 draft.
- `relay run`/dispatch/shell over MCP.
- Cost tracking / price maps / $ math (raw usage receipt only).
- MCP-client bridge (Relay consuming other MCP servers).
- Trader/finance/market features of any kind.
- Berry/hallucination-check built-in (external tool only).
- Command Central/TUI extensions.

DEFERRED (post-v1, only if measured-needed):
- RAG/embeddings beyond the existing optional lazy-embed path (FTS5 + scoping is the v1 recall story).
- `openai-responses` wire type; agentic tool_loop for dynamic providers.
- v2 remote MCP transport + OAuth 2.1 DCR (ChatGPT/web reach).
- HTTP/SSE transports, MCP resources/prompts, multi-user/hosted anything.
</non_goals>
