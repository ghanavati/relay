# Phase 9: Relay MCP Server - Research

**Date:** 2026-06-09
**Status:** Complete enough for planning (SDK grounded via Context7; reuse map from this session's Phase 8 work)

## Core finding

Relay-as-MCP is a thin adapter, not a rewrite. The MCP TypeScript SDK registers tools that take a Zod `inputSchema` and return a `{ content }` envelope. Relay already has (a) Zod-validated tool handlers in `src/control/tools.ts` and (b) a memory recall/save path. The work is: start an `McpServer` over stdio, register one MCP tool per existing handler, wrap each result in the MCP envelope, and ensure the caller is bound to a control session so Phase 8 broker policy applies. The risk is not difficulty — it is drift (a second schema/policy path) and stdout discipline (stdio MCP uses stdout as the wire).

## MCP TS SDK shape (Context7 `/modelcontextprotocol/typescript-sdk`)

```ts
import { McpServer } from '@modelcontextprotocol/...';      // verify exact path at build
import { StdioServerTransport } from '@modelcontextprotocol/.../stdio';
import { z } from 'zod';

const server = new McpServer({ name: 'relay', version: <relay version> });

server.registerTool(
  'relay_memory_recall',
  { description: '...', inputSchema: z.object({ /* reuse existing schema */ }) },
  async (args) => {
    const result = await existingRecallHandler(args);     // REUSE, don't reimplement
    return { content: [{ type: 'text', text: redactSecrets(JSON.stringify(result)) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);   // blocks; speaks MCP on stdin/stdout
```

- `registerTool(name, config, handler)` — config = `{ title?, description, inputSchema: <zodObject>, outputSchema? }`. **inputSchema is a Zod object** → reuse Relay's existing Zod schemas directly (no JSON Schema by hand). This is the single-source-of-truth lever (MCP-05).
- Handler returns `{ content: [{ type: 'text', text }], structuredContent? }`. On failure, return an error result (`isError: true`) rather than throwing — map RelayError here (MCP-06).
- `StdioServerTransport` + `server.connect()`. **stdout is the protocol channel** — the server and every handler must log only to stderr; any stray `console.log` to stdout corrupts the MCP stream. Relay's logging must be audited for this in the `mcp` path.
- **Version/package caveat (MCP-07):** Context7 snippets show a v2-style `@modelcontextprotocol/server` import; the widely-published v1 package is `@modelcontextprotocol/sdk` with subpath imports (`/server/mcp.js`, `/server/stdio.js`). These differ. The executor MUST run `npm view @modelcontextprotocol/sdk version` (and check for the newer package) and read the installed package's entry points before writing imports. Do not hardcode from this doc.

## Local reuse map (what already exists — do not rebuild)

- `src/control/tools.ts` — `relay_session_list / relay_session_inspect / relay_session_send / relay_inbox_read / relay_inbox_ack / relay_control_request_grant`. Caller-bound, default-deny, grant-enforced, audited (verified by Codex review this session). The MCP tools are wrappers over these.
- `src/cli/cmd-run.ts` — shows the pattern for "this caller is a control session": a run registers a control session (id = run_id) and wires the control tools through `extraToolHandlers`. The MCP server mirrors this: on connect, register an llm-kind control session for the MCP client; tear it down on disconnect.
- `src/control/broker.ts` / `session-store.ts` — the policy + store the MCP caller is subject to. No new policy code; the wrappers call the same broker.
- `src/security/redaction.ts` — `redactSecrets` / `REDACTION_PATTERNS`. Run on every value returned across the MCP boundary.
- `src/errors.ts` — RelayError → MCP error-result mapping lives in a small shared helper.
- `src/cli.ts` — add a `mcp` branch; pattern matches the existing `session`/`tui` branches.

## Architecture recommendation

`src/mcp/` subsystem:
- `server.ts` — builds the `McpServer`, registers tools, connects stdio, manages the per-connection control session lifecycle.
- `tools.ts` — the MCP tool definitions: name + description + reused Zod schema + thin handler that calls the existing control/memory handler and shapes the MCP envelope (with redaction + error mapping).
- `result.ts` (small) — `toMcpResult(value)` and `relayErrorToMcpError(err)` helpers so envelope/redaction/error logic is one place.
- `cmd-mcp.ts` in `src/cli/` — `relay mcp` entry that imports and starts `server.ts`.

## Main risks

- **Schema drift** — two definitions of a tool's input. Mitigation: import the same Zod schema; if `tools.ts` only exposes OpenAI JSON `ToolDef`, refactor to export the underlying Zod schema and derive both from it.
- **stdout corruption** — anything writing to stdout breaks the MCP wire. Mitigation: stderr-only logging in the mcp path; a test that asserts the server emits valid framed MCP on stdout and nothing else.
- **Policy bypass** — an MCP tool that calls the store/broker without the caller-session binding would let an MCP client send cross-session messages as if human. Mitigation: every session tool resolves the caller's session id from the MCP connection context; reuse the exact `tools.ts` caller-binding, never a privileged path.
- **New dependency** — the SDK is a new dep; pin it, verify maintainer/name/version (supply-chain per project security rules), and confirm the install is approved.
- **SDK API mismatch** — building against the doc's import style instead of the installed version. Mitigation: MCP-07 build-time verification gate.

## MVP route

1. Add + pin the SDK dep (verify exact package/version first). 
2. `src/mcp/result.ts` helpers (envelope, redaction, error mapping) — TDD.
3. `src/mcp/tools.ts` — register memory tools first (recall/save) over reused schemas + handlers — TDD against an in-memory store.
4. Add session-control tools by wrapping `src/control/tools.ts`, with the MCP-caller-as-control-session binding + policy assertions (default-deny without grant) — TDD.
5. `src/mcp/server.ts` + `relay mcp` CLI branch; stdout-discipline test.
6. Docs: `.mcp.json` registration for Claude Code/Desktop; README + docs/commands.md `relay mcp` section. CHANGELOG.
