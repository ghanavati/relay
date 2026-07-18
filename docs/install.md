# Install

Relay is a CLI plus an MCP server that gives your AI tools a shared, persistent memory. This page takes you from nothing to a memory that travels between your tools.

Requires **Node 20 or newer** and git. No compiler, no Xcode, no build tools — the SQLite driver ships prebuilt binaries for macOS and Linux (x64 and ARM).

## The 2-minute path

```bash
git clone https://github.com/ghanavati/relay.git
cd relay
npm install -g .
relay init
```

`npm install -g .` builds Relay and puts the `relay` command on your PATH.

`relay init` is interactive (add `--auto` to accept defaults). It:

1. writes `~/.relay/config.json`,
2. installs the Claude Code session hooks so past lessons load automatically,
3. detects your LLM CLIs (Codex, LM Studio, OpenRouter, Anthropic) and wires them,
4. offers to register the Relay MCP server with every MCP client it can find — Claude Code, Claude Desktop, Cursor, Codex.

Re-running it is safe; it never duplicates entries and never touches config it can't parse. `--auto` skips MCP client registration because those are global client settings; run interactive `relay init` to approve that step.

## The success moment

Save a memory in your terminal:

```bash
relay memory save "the staging cluster is named osprey" --type fact
```

Now open a different tool — Claude Desktop, Claude Code, Cursor — and ask it to recall. The `relay_memory_recall` tool returns the memory you just saved. Same store, any surface. (From the terminal: `relay memory recall --query "staging cluster"`.)

If a client was open during `relay init`, restart it so it picks up the new MCP server.

## Per-client notes

Interactive `relay init` handles these after your confirmation when the client is installed. The manual fallbacks below are only needed if you skipped that step or the client wasn't detected.

**Claude Code** — registered via `claude mcp add --scope user relay`. Manual: add to `.mcp.json` in your project or run that command yourself.

**Claude Desktop** — entry written into `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Linux: `~/.config/Claude/`). The entry uses absolute paths because GUI apps don't inherit your shell PATH.

**Cursor** — entry written into `~/.cursor/mcp.json`.

**Codex CLI** — a `[mcp_servers.relay]` block appended to `~/.codex/config.toml`.

**Any other MCP client** — point it at the server with absolute paths:

```json
{
  "mcpServers": {
    "relay": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/relay/dist/cli.js", "mcp"]
    }
  }
}
```

`which node` and `which relay` (follow the symlink) give you the two paths.

## Check your install

```bash
relay doctor
```

Reports the database, hooks, provider probes, and — per client — whether the Relay MCP server is registered. Every problem comes with the command that fixes it.

## Where your data lives, and uninstalling

All memory lives in `~/.relay/relay.db`, a plain SQLite file you can copy, back up, or point at a hosted database — see [database.md](./database.md).

To uninstall: `npm rm -g relay`, then delete `~/.relay/` if you also want the data gone. Hooks and MCP registrations can be removed with `relay setup --clean` before you uninstall.
