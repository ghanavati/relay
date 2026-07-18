# MCP server — `relay mcp serve`

Serve relay's memory tools over the [Model Context Protocol](https://modelcontextprotocol.io)
so any MCP client — Claude Desktop, Cursor, Windsurf, Zed — can read and write
the same SQLite memory store the CLI and hooks use.

**Honest scope.** MCP tools are *model-invoked*: the model calls `relay_recall`
when it decides to, which is not every time it should. This is not ambient
injection — for that, use the Claude Code `SessionStart` hook
(`relay memory hook --install`). The `relay-context` prompt below is the
one-tap middle ground for clients without hooks.

## Client setup

Relay is not yet published to npm, so point your client at the built CLI by
absolute path.

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "relay": {
      "command": "node",
      "args": ["/ABS/PATH/TO/relay/dist/cli.js", "mcp", "serve"],
      "env": { "RELAY_MCP_DEFAULT_WORKDIR": "/ABS/PATH/TO/your-project" }
    }
  }
}
```

**Cursor** (`.cursor/mcp.json` in your project):

```json
{
  "mcpServers": {
    "relay": {
      "command": "node",
      "args": ["/ABS/PATH/TO/relay/dist/cli.js", "mcp", "serve"],
      "env": { "RELAY_MCP_DEFAULT_WORKDIR": "${workspaceFolder}" }
    }
  }
}
```

Verify the wiring without a client:

```bash
relay mcp serve --selfcheck   # in-process handshake + tools/list, exit 0 on ok
```

## Workdir semantics (important)

MCP clients have no meaningful working directory, so relay refuses to guess:

1. an explicit `workdir` tool argument always wins (`'*'` = all projects, reads only);
2. otherwise `RELAY_MCP_DEFAULT_WORKDIR` from the `env` block above;
3. otherwise the call errors with instructions — **never** a silent global fallback.

This is deliberate: a desktop client silently reading another project's memory
is the failure mode the gate exists to prevent.

## Tools

| Tool | What it does |
|---|---|
| `relay_recall` | Scored recall within a token budget (default 4000). |
| `relay_memory_search` | Compact index (ID + tags + excerpt) — pair with `relay_get_memory`; ~10x cheaper for browsing. |
| `relay_get_memory` | One entry, full content, by `memory_id`. |
| `relay_remember` | Store a memory — quarantined, see below. |
| `relay_corpus_query` | Query a corpus built with `relay corpus build` (read-only). |
| `relay_browse_runs` | List recorded delegation runs. |
| `relay_compare_runs` | Shared vs diverged files across runs. |

**Prompt:** `relay-context` — renders the recalled lessons + decisions for a
workdir (same defaults as `relay memory show-context`) as a one-tap context
loader in clients that surface MCP prompts.

## Trust quarantine on MCP writes

Every `relay_remember` over MCP enters as `memory_source='worker-mcp'` at
trust `unverified`. Default recall (CLI, hooks, **and** MCP — the floor is
`min_trust='provisional'` everywhere an LLM is on the other end) will not
surface these entries until they are promoted by normal trust mechanics
(successful recalls, or human pinning via the CLI). `pinned` and
`source_run_id` are not accepted over MCP — pinning jumps the quarantine and
`source_run_id` bypasses the write rate limit.

Practical effect: a prompt-injected model can write poisoned "lessons" all day;
they sit invisible at `unverified` until a human (or proven use) promotes them.
Review incoming MCP writes with:

```bash
relay memory recent --limit 20        # look for source worker-mcp
relay memory why <memory_id>          # score + provenance breakdown
relay memory forget <memory_id>       # discard
```

## Pause switch

The privacy off-switch holds here too: while `~/.relay/paused` (or
`<workdir>/.relay/paused`) exists and is unexpired, `relay_recall`,
`relay_memory_search`, `relay_remember`, and the `relay-context` prompt all
return a `paused: true` notice instead of touching memory. `relay resume`
re-enables.

## Audit

Every MCP read lands in `memory_reads` with `read_source='mcp'`; writes carry
`memory_source='worker-mcp'`. `relay memory why <id>` shows surfacings as usual.

## Troubleshooting

- **Client shows no relay server** — check the absolute path in `args`; run
  the selfcheck; on macOS ensure the client can run `node` (full path to the
  binary if needed).
- **`workdir required` errors** — set `RELAY_MCP_DEFAULT_WORKDIR` in the
  server's `env` block, or have the model pass `workdir` explicitly.
- **Writes don't show up in recall** — that's the quarantine working; pass
  `min_trust: "unverified"` to see them, or promote them.
