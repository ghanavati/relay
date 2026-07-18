# Install Relay from GitHub Releases

Relay is the control layer for AI coding: shared memory, deliberate delegation,
and visible multi-model work.

## Install v0.4.0-beta.1

Relay ships through [GitHub Releases](https://github.com/ghanavati/relay/releases),
not npm. The archive includes Relay, its production dependencies, and its Node
runtime.

Choose the archive for your machine:

- Apple Silicon Mac: `relay-v0.4.0-beta.1-darwin-arm64.tar.gz`
- Intel Mac: `relay-v0.4.0-beta.1-darwin-x64.tar.gz`
- Linux x64: `relay-v0.4.0-beta.1-linux-x64.tar.gz`

On an Apple Silicon Mac, download, verify, and install it like this:

```bash
curl -fL -O https://github.com/ghanavati/relay/releases/download/v0.4.0-beta.1/relay-v0.4.0-beta.1-darwin-arm64.tar.gz
curl -fL -O https://github.com/ghanavati/relay/releases/download/v0.4.0-beta.1/SHA256SUMS.txt
shasum -a 256 -c SHA256SUMS.txt --ignore-missing
tar -xzf relay-v0.4.0-beta.1-darwin-arm64.tar.gz
mkdir -p "$HOME/.local/bin"
ln -sf "$PWD/relay-v0.4.0-beta.1-darwin-arm64/relay" "$HOME/.local/bin/relay"
export PATH="$HOME/.local/bin:$PATH"
relay setup --everything
```

Add `export PATH="$HOME/.local/bin:$PATH"` to your shell profile if it is not
already there. For another platform, replace `darwin-arm64` with the matching
archive name above. To upgrade, download the newer archive, verify it, and
update the symlink.

## After Relay is provisioned

An interactive `relay init` can:

1. write `~/.relay/config.json`,
2. installs the Claude Code session hooks so past lessons load automatically,
3. detects your LLM CLIs (Codex, LM Studio, OpenRouter, Anthropic) and wires them,
4. offers to register the Relay MCP server with every MCP client it can find , Claude Code, Claude Desktop, Cursor, Codex.

Re-running it is safe; it never duplicates entries and never touches config it
can't parse. `--auto` skips MCP client registration because those are global
client settings; run interactive `relay init` to approve that step.

## Per-client notes

Interactive `relay init` handles these after your confirmation when the client
is installed. The manual fallbacks below are for an already provisioned Relay
runtime.

**Claude Code** , registered via `claude mcp add --scope user relay`. Manual: add to `.mcp.json` in your project or run that command yourself.

**Claude Desktop** , entry written into `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Linux: `~/.config/Claude/`). The entry uses absolute paths because GUI apps don't inherit your shell PATH.

**Cursor** , entry written into `~/.cursor/mcp.json`.

**Codex CLI** , a `[mcp_servers.relay]` block appended to `~/.codex/config.toml`.

**Any other MCP client** , point it at the server with absolute paths:

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

Use the runtime's resolved executable paths for these entries; GUI clients do
not inherit a shell PATH.

## Where your data lives, and uninstalling

All memory lives in `~/.relay/relay.db`, a plain SQLite file you can copy, back
up, or point at a hosted database , see [database.md](./database.md).
