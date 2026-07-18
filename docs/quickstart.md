# Quickstart

> Install Relay from GitHub Releases. See [install.md](./install.md) for the
> v0.4.0-beta.1 archive and checksum steps. You do not need npm or Node.

End-to-end walk: save a memory, verify recall, and wire Relay into an LLM.

## 1. Prerequisites

- **Optional local model:** [LM Studio](https://lmstudio.ai) for free local inference + auto-extract.
- **Optional Codex CLI:** install it using the official Codex instructions,
  then run `codex login` for delegated runs.

## 2. Configure an existing runtime

```bash
relay setup --everything    # init + hooks (global) + auto-extract consent for cwd
```

`setup --everything` is non-interactive (use `--yes` to skip the final confirm). It runs:
1. `relay init --auto` , probes providers, writes `~/.relay/config.json`
2. `relay memory hook --install --global` , SessionStart hook in `~/.claude/settings.json`
3. `relay memory hook --install --session-end --global` , SessionEnd auto-extract hook
4. `relay memory auto-extract --enable --workdir <cwd>` , writes per-workdir consent

Skip the wrapper and run each step yourself if you want different choices per LLM.

## 3. First memory

```bash
relay memory remember 'hello' --type fact
```

Prints the new memory ID. Stored in `~/.relay/relay.db` (override with `RELAY_DB_PATH`).

## 4. Verify recall

```bash
relay memory recall 'hello'
```

Should return the entry you just wrote. If empty, see [troubleshooting.md](./troubleshooting.md) for `RELAY_DB_PATH` mismatches.

## 5. Verify cross-LLM injection

```bash
relay context emit --target cc --workdir "$PWD"
```

Returns the JSON `{additionalContext: "..."}` shape Claude Code's SessionStart hook expects. Run with `--target codex` for plain markdown, `--target lmstudio-http` for an OpenAI-compatible system fragment, or `--target lmstudio-cli` for single-line text.

## 6. The MCP server (memory in every tool)

`relay init` registers Relay's MCP server , two tools, `relay_memory_recall` and `relay_memory_save` , with every client it detects: Claude Code, Claude Desktop, Cursor, Codex. Restart the client and ask it to recall; it reads the same store your terminal writes. Manual registration and details: [mcp.md](./mcp.md); pointing the store at a hosted database: [database.md](./database.md).

## 7. Per-LLM pointers

Each frontier CLI has its own wiring. `relay setup --everything` covers Claude Code; for the rest:

- **Claude Code:** auto-wired by `setup --everything` via SessionStart + SessionEnd hooks. See [cookbook.md](./cookbook.md#claude-code).
- **Codex CLI:** `relay setup-llm codex --write` , appends a Relay-managed block to `AGENTS.md`. See [cookbook.md](./cookbook.md#codex).
- **LM Studio:** `relay setup-llm lmstudio --write` , writes a model preset note. See [cookbook.md](./cookbook.md#lm-studio).
- **OpenRouter:** `relay setup-llm openrouter --write` , probes API key, lists available models. See [cookbook.md](./cookbook.md#openrouter).
- **Anthropic API direct:** `relay setup-llm anthropic --write` , probes API key. See [cookbook.md](./cookbook.md#anthropic).

## 8. Where to next

- `relay info` , health check: hook status, provider reachability, last activity
- `relay memory tail` , live view of recent memory writes / hook activity
- `relay --help` , full menu
- [docs/commands.md](./commands.md) , every verb + flag
- [docs/configuration.md](./configuration.md) , env vars + consent files
- [docs/cookbook.md](./cookbook.md) , per-LLM recipes
