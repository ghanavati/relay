# Phase 9: v0.4 Lean Core (Agnostic Dispatch + MCP Memory Server) - Research

**Date:** 2026-06-09 (updated same day for the v0.4 rescope; the original MCP-SDK findings stand, the control-tools reuse map is removed with its killed scope)
**Status:** Complete for execution. SDK grounded via Context7; dispatch pattern grounded by direct read of the relay-mcp predecessor; memory capabilities grounded by codebase inventory.

## Core finding

Both deliverables are thin adapters over things that already exist and work.

- **Dispatch:** relay-mcp already solved provider agnosticism with `RELAY_PROVIDER_<NAME>_*` env discovery; Relay's GenericHttpRunner already speaks the OpenAI wire and AnthropicRunner the messages wire. The work is a registry module + parameterization, not new protocol code.
- **MCP:** the SDK registers tools that take a Zod `inputSchema` and return a `{content}` envelope. Relay's memory handlers already validate with exported Zod schemas and already return that envelope. The work is: pin the SDK, register two wrapped tools, connect stdio, keep stdout clean.

The risks are not difficulty — they are drift (a second schema/config path), stdout discipline (stdio MCP uses stdout as the wire), and supply chain (one new dependency).

## Dispatch: the relay-mcp pattern to port (verified by direct read)

From `/Users/ghanavati/ai-stack/Projects/relay-mcp/src/config/providers.ts` (read-only reference):

- Dynamic provider names discovered by env-key regex scan: `/^RELAY_PROVIDER_([A-Z0-9_]+)_URL$/` (name lowercased).
- Settings per provider: `_URL`, `_KEY`, `_TYPE` (`openai` | `openai-responses` | `anthropic`, default `openai`), `_HEADER_*` (kebab-cased into HTTP headers).
- Request-URL derivation auto-suffixes per type: `/chat/completions` (openai), `/messages` (anthropic), `/responses` (openai-responses).
- Builtins remain a static table; dynamic providers merge in.

v0.4 port decisions (recorded in 09-CONTEXT.md): TYPE enum trimmed to `openai`|`anthropic` for v1; the adapter zoo (`_ADAPTER_TYPE`, `_OPENCLAW_TOOL`, `_EXECUTABLE`, `_INTEGRATION_LEVEL`) is NOT ported; dynamic providers are single-shot; builtin names win on collision.

Current Relay run path (verified): `src/cli/cmd-run.ts` hardwires `'codex' | 'openrouter' | 'lmstudio' | 'anthropic' | 'lmstudio-agentic'`; openrouter/lmstudio extend `GenericHttpRunner`; anthropic is a separate messages-wire runner; usage lands in WorkerResult (`token_usage`, plus `prompt_tokens`/`completion_tokens` from anthropic) and `run-store.ts` persists `token_usage`. The receipt task normalizes this across both wire shapes and persists prompt/completion columns (PRAGMA-guarded additive migration if missing).

## MCP TS SDK shape (Context7 `/modelcontextprotocol/typescript-sdk`)

```ts
import { McpServer } from '@modelcontextprotocol/...';      // verify exact path at build
import { StdioServerTransport } from '@modelcontextprotocol/.../stdio';
import { z } from 'zod';

const server = new McpServer({ name: 'relay', version: <relay version> });

server.registerTool(
  'relay_memory_recall',
  { description: '...', inputSchema: RecallArgsSchema },    // reuse the contracts schema
  async (args) => {
    const result = await handleRecall(args);                // REUSE, don't reimplement
    return redactEnvelope(result);                          // boundary redaction (result.ts)
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);   // blocks; speaks MCP on stdin/stdout
```

- `registerTool(name, config, handler)` — config = `{ title?, description, inputSchema: <zodObject>, outputSchema? }`. **inputSchema is a Zod object** → reuse `src/contracts/memory.ts` schemas directly (MCP-03 single source of truth).
- Handler returns `{ content: [{ type:'text', text }], structuredContent? }`. On failure, return `isError: true` rather than throwing — map RelayError there (MCP-04).
- `StdioServerTransport` + `server.connect()`. **stdout is the protocol channel** — the server and every handler log only to stderr; any stray `console.log` corrupts the MCP stream.
- **Version/package caveat (MCP-05):** Context7 snippets have shown both `@modelcontextprotocol/sdk` with subpath imports (`/server/mcp.js`, `/server/stdio.js`) and newer package layouts. The executor MUST run `npm view @modelcontextprotocol/sdk version` (and check for a newer official package) and read the installed package's exports map before writing imports. Do not hardcode from this doc.
- For the integration test: check whether the installed SDK exports a `Client` + an in-memory linked transport pair (e.g. `InMemoryTransport.createLinkedPair()`); fall back to a child-process stdio test if not.

## Local reuse map (what already exists — do not rebuild)

- `src/tools/recall.ts` / `src/tools/remember.ts` — handlers already returning the `{content}` envelope. They do NOT redact; the MCP wrapper does.
- `src/contracts/memory.ts` — `recallSchema`/`RecallArgsSchema`, `rememberSchema`/`RememberArgsSchema` already exported. No schema work needed.
- `src/memory/memory-store.ts` — workdir gate (`assertWorkdirAllowed` → MEMORY_WORKDIR_FORBIDDEN), write rate limit, 60s dedup, redaction-on-save, trust model (unverified-by-default for non-human sources). Wrapping the handlers inherits all of it.
- `src/security/redaction.ts` — `redactSecrets`/`REDACTION_PATTERNS` for the boundary.
- `src/errors.ts` — RelayError shape for the error mapping.
- `src/workers/generic-http-runner.ts` + `src/workers/anthropic.ts` — both wire shapes already implemented; dispatch parameterizes them.
- Memory subsystem capabilities (scoping, entity_key upsert, token budget, outcome trust, FTS5) verified existing 2026-06-09 — inventory table in 09-CONTEXT.md.

## Architecture

- `src/workers/provider-registry.ts` — config-only module: builtin table + env scan → ProviderConfig (stores key env-var NAMES, never values).
- `src/mcp/` subsystem:
  - `sdk-probe.ts` — `resolveMcpSdk()` verifies + returns the installed SDK surface.
  - `result.ts` — `toMcpResult` / `relayErrorToMcpResult` / `withMcpResult`: envelope + redaction + error mapping, SDK-free.
  - `tools-memory.ts` — `buildMemoryMcpTools()`: the two registrations.
  - `server.ts` — `startMcpServer()`: build, register, connect, shut down. No broker/control imports.
- `src/cli/cmd-mcp.ts` + `src/cli/cmd-providers.ts` — the two new CLI branches.

## Main risks

- **Schema/config drift** — a second definition of tool input or provider wiring. Mitigation: import the same Zod schemas; registry is the only provider source; tests assert same-object identity.
- **stdout corruption** — anything writing to stdout breaks the MCP wire. Mitigation: stderr-only logging in the mcp path; grep gates; a test asserting stdout stays protocol-only; the real-client integration test.
- **New dependency** — the SDK. Mitigation: verify name/maintainer/version pre-install, exact-pin, maintainer approval (plan 02 is autonomous: false).
- **SDK API mismatch** — building against docs instead of the installed version. Mitigation: resolveMcpSdk build-time gate; integration test over the real protocol.
- **Key leakage via the new providers surface** — mitigation: configs carry env-var names only; `relay providers` masks by construction; existing redaction covers error paths.
- **"Green units, dead live surface"** (the Phase 8 TUI lesson) — mitigation: plan 05's integration test drives the REAL SDK client against the REAL server.

## Route

1. Plan 01 — provider registry + parameterized runner + receipt + `relay providers` (no MCP dependency; wave 1).
2. Plan 02 — SDK pin/verify + result.ts helpers (wave 1, parallel).
3. Plan 03 — the two memory tools over existing handlers (wave 2).
4. Plan 04 — server assembly + `relay mcp` + stdout discipline (wave 3).
5. Plan 05 — real-client integration test + docs + human gate (wave 4).
