# relay mcp — the MCP memory server

`relay mcp` runs Relay as a stdio MCP server. It exposes Relay's cross-session, cross-tool memory to any MCP client — the same SQLite store the CLI reads and writes, reachable from Claude Code, Claude Desktop, Cursor, and anything else that speaks MCP over stdio. The CLI is unchanged; this is a second front door onto the same store.

Built on the official MCP TypeScript SDK (`@modelcontextprotocol/sdk@1.29.0`, exact-pinned, supply-chain verified before install).

## Registration

Claude Code — add to `.mcp.json` at the project root:

```json
{
  "mcpServers": {
    "relay": {
      "command": "relay",
      "args": ["mcp"],
      "env": {
        "RELAY_MEMORY_ALLOWED_WORKDIRS": "/Users/you/projects/app-a:/Users/you/projects/app-b"
      }
    }
  }
}
```

Claude Desktop — the same `mcpServers` block goes in `claude_desktop_config.json` (Settings → Developer → Edit Config). Other stdio MCP clients (Cursor, Codex, Windsurf) take the same `command` + `args` pair in their own config format.

`RELAY_MEMORY_ALLOWED_WORKDIRS` is optional but recommended: a colon-separated allowlist of project roots the server may read or write memory for. Without it, any workdir the client names is in scope. Set it so a client session in one project cannot pull another project's memory. The `env` field is per-entry, so different clients can get different scopes.

`relay` must be on the client's PATH (`npm link` from the checkout — see [README install](../README.md#install)). If the client does not inherit your shell PATH, use the absolute path to `dist/cli.js`'s `relay` symlink as `command`.

## Tools

Exactly two tools, both thin wrappers over the same handlers the CLI uses:

| Tool | What it does |
|---|---|
| `relay_memory_recall` | Search memories (facts, decisions, lessons, context) for a project within a hard token budget. FTS5 keyword search with recency fallback. |
| `relay_memory_save` | Persist a memory to the shared store so future sessions and other tools can recall it. Writes are deduplicated, rate-limited, and redacted by the store. |

Saves arriving over MCP carry the `worker-mcp` source tag and start at `unverified` trust — the same trust model as every other non-human write.

There is no dispatch tool, no shell tool, and no session-control surface over MCP. Memory is the whole v1 surface.

## Reach

stdio reaches any app that is an MCP client: Claude Desktop, Claude Code, Cursor, Codex, Windsurf — and harnesses that run those agents (Conductor and the like) when MCP config passes through to the agent layer.

ChatGPT and web clients need a remote transport plus OAuth; that is deferred to v2. Relay stays local either way — `relay mcp` opens no port and serves only the process that spawned it.

## Security posture

- **Workdir scoping** — `RELAY_MEMORY_ALLOWED_WORKDIRS` applies over MCP exactly as in the CLI. A recall or save for a workdir outside the allowlist returns a `MEMORY_WORKDIR_FORBIDDEN` error, never data.
- **Boundary redaction** — every value crossing the MCP boundary (results and error messages) passes through the secret redactor on the way out.
- **stderr-only logs** — diagnostics go to stderr; stdout carries only protocol framing, so a log line can never corrupt the client connection.
- **stdio trusts the OS user** — any local process that can pipe into `relay mcp` stdin acts as you. That is the stdio trust model; see [SECURITY.md](../SECURITY.md).
- **No dispatch/shell/control** — those surfaces are structurally absent from the MCP server, not gated off.
