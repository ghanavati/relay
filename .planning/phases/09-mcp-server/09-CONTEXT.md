# Phase 9: Relay MCP Server - Context

**Gathered:** 2026-06-09
**Status:** Ready for planning
**Source:** User request — "what would it take to make the relay system an MCP as well as CLI". Scoped by Claude (sensible defaults baked, open items flagged); maintainer to veto before execution.

<domain>
## Phase Boundary

Expose Relay's existing memory and session-control capabilities to MCP-capable clients (Claude Code, Claude Desktop, other agents) through a stdio MCP server, started by a new `relay mcp` subcommand. The server is a THIN TRANSPORT LAYER over the handlers that already exist — `src/control/tools.ts` (session control) and the memory recall/save path. It must not reimplement business logic, and an MCP caller must not bypass the Phase 8 broker policy.

This is additive. The `relay` CLI keeps working exactly as today. The MCP server is a second front door onto the same store, broker, and handlers.

In scope: stdio MCP server, `relay mcp` command, memory tools, session-control tools (reuse), Zod→MCP schema mapping, RelayError→MCP-error mapping, redaction at the boundary, caller-as-llm-session policy, `.mcp.json` registration docs.

Out of scope (this phase): HTTP/SSE transport (stdio only for v1); exposing `relay run`/worker dispatch over MCP (flagged open — heavier, side-effecting); MCP resources/prompts (tools only for v1); multi-user/hosted MCP.
</domain>

<decisions>
## Implementation Decisions (defaults — maintainer may veto)

### Transport
- **D-01:** stdio MCP server only for v1. Standard for local single-user registration in Claude Code / Claude Desktop. HTTP/SSE deferred — no remote/multi-tenant need yet.

### Surface (which tools)
- **D-02:** Memory tools exposed: `relay_memory_recall` (token-budgeted recall for current workdir) and `relay_memory_save`. This is the highest-value Relay capability — persistent cross-session memory — and the reason an MCP client would mount Relay at all.
- **D-03:** Session-control tools exposed by REUSING the existing `src/control/tools.ts` handlers: `relay_session_list`, `relay_session_inspect`, `relay_session_send`, `relay_inbox_read`, `relay_inbox_ack`, `relay_control_request_grant`. The MCP server registers these against the SDK; it does not duplicate their logic.
- **D-04 (OPEN):** `relay run` / worker dispatch over MCP is DEFERRED from v1 unless the maintainer wants it. It is side-effecting (spawns workers, shell_exec) and deserves its own consent design. Flagged, not assumed.

### Reuse and schemas
- **D-05:** Single source of truth for schemas. The MCP SDK's `registerTool` accepts a Zod object as `inputSchema`. Relay already validates tool input with Zod. The MCP layer imports and reuses those exact Zod schemas — no hand-maintained JSON Schema. If the existing handlers expose OpenAI-style `ToolDef` JSON rather than raw Zod, the plan must extract/share the underlying Zod schema so MCP and the agentic path validate against the same definition.
- **D-06:** New code is confined to a `src/mcp/` module (e.g. `src/mcp/server.ts`, `src/mcp/tools.ts`) plus a `mcp` branch in `src/cli.ts`. Each MCP tool handler is a thin wrapper that calls the existing control/memory handler and shapes the result into the MCP `{ content: [...] }` envelope.

### Security / policy (mirror Phase 8)
- **D-07:** An MCP caller is an llm-kind control session. Cross-session sends are default-deny, require grants (TTL + budget), are loop-detected, and emit SQLite audit events — identical to the agentic path. No MCP tool may let a caller self-grant, raise its own budget, or bypass the broker.
- **D-08:** Workdir scoping (`RELAY_MEMORY_ALLOWED_WORKDIRS`) applies to memory tools over MCP exactly as it does to the CLI.
- **D-09:** Redaction (`REDACTION_PATTERNS`) runs before any value is returned across the MCP boundary — session content, memory text, errors. RelayError maps to an MCP tool-error result (isError), not a thrown exception that crashes the server.

### SDK
- **D-10:** Use the official Model Context Protocol TypeScript SDK. The exact published package name + import paths MUST be verified at build time against the installed version (the SDK has shifted between `@modelcontextprotocol/sdk` with `/server/mcp.js` + `/server/stdio.js` subpaths and a newer `@modelcontextprotocol/server` style). The executor runs `npm view <pkg> version` / checks the installed package before writing imports. Pin in package-lock. This is a new dependency — flagged for explicit install approval.

### Packaging
- **D-11:** `relay mcp` starts the stdio server (blocking, speaks MCP on stdin/stdout, logs to stderr only — stdout is the protocol channel, so nothing else may write to it). Docs show the `.mcp.json` entry for Claude Code/Desktop registration.
</decisions>

<open_questions>
## Open — maintainer decides (do not silently assume in plans)
- **O-01:** Expose `relay run`/dispatch over MCP in v1, or defer? (D-04 default: defer.)
- **O-02:** Should each MCP connection map to one ephemeral control session, or a persistent named session? Affects how `relay_session_send` identifies "self" and how audit attributes actions. (Lean: one session per MCP connection, id derived from client info, ended on disconnect.)
- **O-03:** Memory `save` over MCP — auto-approved, or behind the same consent/allowlist the CLI uses? (Lean: same workdir consent as CLI; no looser path.)
</open_questions>

<canonical_refs>
## Code References (MUST read before planning/implementing)
- `src/control/tools.ts` — existing LLM-facing tool handlers to REUSE (relay_session_*). Source of truth for session-control behavior + Zod input validation.
- `src/cli.ts` — command dispatcher; add a `mcp` branch (study existing branches like `session`, `tui`).
- `src/cli/cmd-run.ts` — how the agentic path wires control tools + creates a control session per run (mirror for "MCP caller = session").
- `src/control/broker.ts`, `src/control/session-store.ts` — broker policy + store the MCP caller is subject to.
- `src/security/redaction.ts` (`REDACTION_PATTERNS`, `redactSecrets`) — run at the MCP boundary.
- `src/errors.ts` — RelayError shape for the error-mapping.
- Memory recall/save path — `src/cli/cmd-memory-ops.ts` / memory recall command (the handler the memory MCP tools wrap).
- `package.json` — add the MCP SDK dep; `tsconfig.json` — ESM/module settings the new files must match.

## External
- MCP TypeScript SDK (Context7 `/modelcontextprotocol/typescript-sdk`): `McpServer({name,version})`, `server.registerTool(name, {title?, description, inputSchema: <zodObject>, outputSchema?}, async handler)`, handler returns `{ content: [{type:'text', text}], structuredContent? }`; `StdioServerTransport` + `await server.connect(transport)`. Verify exact package/import at build time.
</canonical_refs>

<non_goals>
## Out Of Scope
- HTTP/SSE transport (stdio only v1).
- `relay run`/worker dispatch over MCP (deferred unless O-01 says otherwise).
- MCP resources and prompts (tools only v1).
- Hosted/multi-user MCP, auth beyond the OS-user/stdio trust boundary.
- Any change to the existing CLI behavior — additive only.
</non_goals>
