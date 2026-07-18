# Step 1-C — MCP client wiring inventory (Relay, worktree `productize`, branch phase-9-v04)

All paths relative to `/Users/ghanavati/ai-stack/Projects/Relay/.claude/worktrees/productize/` unless absolute.

## 1. The MCP server itself

**Start command:** `relay mcp` — no separate bin. package.json declares a single bin `"relay": "dist/cli.js"` (package.json:29-31). The dispatcher routes `cmd === 'mcp'` at src/cli.ts:875-895 → `executeMcpCommand` (src/cli/cmd-mcp.ts:79). Stdio server construction: `startMcpServer` (src/mcp/server.ts:119), server identity name `relay` (src/mcp/server.ts:22), version = CLI VERSION passed in (src/cli.ts:881) or self-read from package.json (src/mcp/server.ts:87-113).

**Modes:** plain stdio (default); `relay mcp --http [--port N]` token-gated StreamableHTTP (src/cli/cmd-mcp.ts:118-137); `relay mcp --http --oauth` OAuth 2.1 + PKCE for ChatGPT connectors (src/cli/cmd-mcp.ts:83-117). Help text src/cli.ts:239-242.

**Tools exposed:** exactly two — `relay_memory_recall` (src/mcp/tools-memory.ts:161) and `relay_memory_save` (src/mcp/tools-memory.ts:181), built by `buildMemoryMcpTools()` (tools-memory.ts:159) and registered in a loop (server.ts:125-128). Nothing else: "no dispatch, no shell, no session-control" is a design decision (tools-memory.ts:2-3, docs/mcp.md:42,65). Save schema omits `pinned`/`source_run_id` (tools-memory.ts:42-46) and the handler forces `pinned: false` (tools-memory.ts:196-206); saves carry source `worker-mcp` (tools-memory.ts:55).

**Stdout cleanliness:** yes. The command layer writes every diagnostic to `io.stderr` only (src/cli/cmd-mcp.ts:4-8 comment; actual writes at 109-113, 129-133, 143, 146-149, 178); the server module writes to neither stream (src/mcp/server.ts:9-12: "This module writes to NEITHER stream — no logging of any kind lives here"). Guarded by test per cmd-mcp.ts:8. Caveat outside the MCP path: `src/config/runtime.ts:44,58` uses `console.warn` in `resolveCodexBin` — that helper serves dispatch, not the MCP server start path, so the wire stays clean (unverified whether any MCP tool call could transitively reach it; recall/save handlers import only memory modules, tools-memory.ts:25-32).

## 2. Config writers — all code that writes/edits external client config

grep sweep (`mcpServers`, `claude_desktop_config`, `settings.json`, `.cursor`, `config.toml`, `codex`, `hook`, `--install`) over src/ found these writers:

**(a) Claude Code `settings.json` hook installer** — `executeMemoryHookCommand` (src/cli/cmd-memory-ops.ts:271-369).
- Client: Claude Code. Target file: `~/.claude/settings.json` when `--global`, else `<cwd>/.claude/settings.json` (`resolveHookSettingsPath`, cmd-memory-ops.ts:224-228).
- Shape written per event (SessionStart / SessionEnd / UserPromptSubmit): `{ "_relay_id": "<marker>", "hooks": [{ "type": "command", "command": "<script>" }] }` appended to `settings.hooks[<event>]` (cmd-memory-ops.ts:349-356). Markers: `relay-context-emit-v1` / `relay-session-end-v1` / `relay-user-prompt-v1` (cmd-memory-ops.ts:216-219).
- Idempotent: yes — prior Relay entries matched by `_relay_id` marker, legacy `id`, or exact command string are filtered out before append (cmd-memory-ops.ts:246-256, 343); foreign hooks preserved.
- Backup: none. Safety instead: aborts (exit 1) if the existing file is invalid JSON rather than overwriting it (cmd-memory-ops.ts:319-335); uninstall on missing file is a no-op that creates nothing (cmd-memory-ops.ts:310-317). Writes pretty-printed JSON + newline (cmd-memory-ops.ts:356). NOTE: this wires memory injection via hooks — it is NOT MCP registration.

**(b) Codex `~/.codex/AGENTS.md` block** — `setupCodex` (src/cli/cmd-setup-llm.ts:147-208).
- Client: Codex CLI. Target: `~/.codex/AGENTS.md` (cmd-setup-llm.ts:103-105). Writes a Markdown block delimited by `<!-- relay-managed-start/end -->` (block content cmd-setup-llm.ts:51-74; delimiters exported from src/control/adapters/codex.ts:48-49) telling Codex to shell out to `relay memory recall` / `relay memory remember` — CLI instructions, NOT an MCP server entry.
- Idempotent: yes — `upsertManagedBlock` replaces an existing delimited block or appends (cmd-setup-llm.ts:134-145); skips write when unchanged (169-177). Backup: none. Dry-run by default; writes only with `--write` (cmd-setup-llm.ts:15-16).
- It does NOT touch `~/.codex/config.toml`. The only `config.toml` code is a READ-ONLY probe: `probeCodexControlSetup` reads `~/.codex/config.toml` (src/control/adapters/codex.ts:92-104) matching `[mcp_servers.relay]` / `[mcp_servers."relay-mcp"]` via regex `RELAY_MCP_ENTRY` (codex.ts:57) to derive control capabilities (codex.ts:107-116).

**(c) LM Studio wrapper** — `setupLmStudio` writes `~/.local/bin/relay-llm` shell wrapper (cmd-setup-llm.ts:240-254). Not MCP config.

**(d) Orchestrators that call (a)/(b):**
- `relay setup --everything` (src/cli/cmd-setup.ts:141-256): init --auto → hook --install --global (SessionStart, cmd-setup.ts:217-227) → hook --install --global --session-end (229-243) → auto-extract enable (245-253). `--clean` strips Relay-managed hooks from BOTH global and project settings, both events (cmd-setup.ts:176-200).
- `relay init` (src/cli/cmd-init.ts:178-431): installs SessionStart hook — default GLOBAL (`globalHook !== false`, cmd-init.ts:236; CLI default true, src/cli.ts:810-812); optional SessionEnd (cmd-init.ts:261-283); Step 6b "Wire detected LLM CLIs" calls `setupCodex`/`setupLmStudio`/`setupOpenRouter`/`setupAnthropic` with `write: true` (cmd-init.ts:303-366). Also writes Relay's own `~/.relay/config.json` (cmd-init.ts:97-100, 394-396).

**(e) Relay-internal writes (not client config):** `~/.relay/config.json` (cmd-init.ts:99), `<workdir>/.relay/auto-extract.json` consent (src/memory/auto-extract-consent.ts:54), `~/.relay/mcp-oauth-state.json` (src/cli/cmd-mcp.ts:99, written by src/mcp/oauth-provider.ts), CLAUDE.md promote-to-rules (cmd-memory-ops.ts:429-470), pause sentinel (cmd-pause.ts), `.relayignore` (cmd-project.ts).

**Negative findings (verified by grep):** NO code writes `.mcp.json`, `claude_desktop_config.json`, `~/.cursor/mcp.json`, `~/.codex/config.toml`, or any Windsurf config. `mcpServers` appears only in docs (docs/mcp.md:13, docs/commands.md:188, docs/recipes/qmd-companion.md:65). ".mcp.json" appears in src only inside a comment (src/config/runtime.ts:46). "Windsurf"/"Cursor"/"Claude Desktop" appear in src only in comments/tool descriptions (tools-memory.ts:137,141).

## 3. Hook install — current shape and target file (post-a71189d)

Commit a71189d (2026-05-03, "fix(memory): correct CC SessionStart hook schema in installer") replaced the invalid `{ id, run }` entry shape with `{ hooks: [{ type: 'command', command }] }` — confirmed via `git show a71189d`. Current code has evolved further: entries now carry the `_relay_id` marker field on top of that shape (cmd-memory-ops.ts:349-352), and identification is marker-first with legacy-`id` and exact-command fallbacks (cmd-memory-ops.ts:246-256) so pre-fix and pre-marker entries self-heal on reinstall.

Exact JSON written today for `relay memory hook --install`:
```json
{ "hooks": { "SessionStart": [ { "_relay_id": "relay-context-emit-v1",
    "hooks": [ { "type": "command", "command": "relay pause --check --workdir \"${CLAUDE_PROJECT_DIR:-$PWD}\" 2>/dev/null && exit 0; relay context emit --target cc --workdir \"${CLAUDE_PROJECT_DIR:-$PWD}\" 2>/dev/null || true" } ] } ] } }
```
(script constant HOOK_SCRIPT, cmd-memory-ops.ts:167-169; SessionEnd variant HOOK_SCRIPT_SESSION_END at 195-199; UserPromptSubmit reuses HOOK_SCRIPT, 208.)

Which settings file: **project-local `<cwd>/.claude/settings.json` by default; `--global` switches to `~/.claude/settings.json`** (cmd-memory-ops.ts:224-228; CLI parse src/cli.ts:430-440; help src/cli.ts:115-117). But the two guided paths flip that default: `relay init` defaults to global (src/cli.ts:812, cmd-init.ts:17,236) and `relay setup --everything` passes `global: true` explicitly (cmd-setup.ts:221,237).

## 4. Per-client verdict

| Client | Config file | Auto-wire code today | Evidence |
|---|---|---|---|
| Claude Code — hooks (memory injection, not MCP) | `.claude/settings.json` (project or `~/.claude`) | **YES** | cmd-memory-ops.ts:271-369; orchestrated by cmd-setup.ts:217-243, cmd-init.ts:232-283 |
| Claude Code — MCP registration | `.mcp.json` / `claude mcp add` | **NO — manual** | no writer; snippet only in docs/mcp.md:9-23, docs/commands.md:188; no `claude mcp add` invocation anywhere in src |
| Claude Desktop | `claude_desktop_config.json` | **NO — manual** | zero src hits; manual instruction docs/mcp.md:25 |
| Cursor | `~/.cursor/mcp.json` | **NO — manual** | zero src hits; docs/mcp.md:25 lumps it under "same command + args pair" |
| Codex CLI | `~/.codex/config.toml` `[mcp_servers.relay]` | **NO — manual** (read-only probe exists; AGENTS.md CLI-block writer exists but is not MCP) | probe: control/adapters/codex.ts:57,92-104; AGENTS.md writer: cmd-setup-llm.ts:147-208 |
| Windsurf | its MCP config | **NO — manual** | zero src hits; named only in docs/mcp.md:25,54 |
| ChatGPT (v2 path) | remote connector | partial: server side exists (`--http --oauth`, cmd-mcp.ts:83-117 + scripts/mcp-tunnel-supervisor.sh); connector-side always manual | cmd-mcp.ts:83-117; docs/mcp.md:56 |

## 5. What a client config must contain

- Command: `relay`, args: `["mcp"]` — `{"mcpServers": {"relay": {"command": "relay", "args": ["mcp"]}}}` (docs/mcp.md:12-23, docs/commands.md:188).
- cwd: NOT required — the store lives at `RELAY_DB_PATH` or `~/.relay/relay.db` (src/runtime/store/db.ts:146). Junk-cwd launches (Claude Desktop) are handled by the workdir default below.
- Env: `RELAY_MEMORY_ALLOWED_WORKDIRS` optional-but-recommended, colon-separated allowlist (parsed src/mcp/tools-memory.ts:92-99); when set, an omitted `workdir` defaults to the FIRST allowed root (tools-memory.ts:114-118) and forbidden-workdir errors name the allowed roots (tools-memory.ts:126-135). HTTP mode additionally: `RELAY_MCP_TOKEN`; OAuth mode: `RELAY_MCP_OWNER_SECRET` / `RELAY_MCP_DANGEROUSLY_ALLOW_NO_AUTH` / `RELAY_MCP_PUBLIC_URL` (src/cli.ts:885-891).
- PATH caveat: `relay` must be on the client's PATH (npm link install); GUI clients that don't inherit shell PATH need the absolute path to the `dist/cli.js` symlink as `command` — docs-only guidance (docs/mcp.md:29), no code resolves it.
- **No `relay mcp print-config` or equivalent exists** — grep for print-config/printConfig/mcpConfig/snippet found nothing config-emitting in src; the only ready-to-paste snippets live in docs (docs/mcp.md:11-23, docs/commands.md:188). `relay doctor`/`relay info` check the CC hook (cmd-doctor.ts:30-50, cmd-info.ts:206-211) but do NOT check any MCP client registration.

## 6. docs/mcp.md vs code

Read in full (65 lines). It is **current** — every checked claim matches code:
- `relay mcp` stdio + two tools + names (mcp.md:3,35-38 ↔ tools-memory.ts:161,181). SDK pin `1.29.0` (mcp.md:5 ↔ package.json:48).
- `.mcp.json` snippet command/args/env (mcp.md:12-23 ↔ cli.ts:875, tools-memory.ts:93).
- Colon-separated allowlist + first-root default + junk-cwd note (mcp.md:27,48 ↔ tools-memory.ts:96,114-118).
- worker-mcp source, pinned stripped (mcp.md:40 ↔ tools-memory.ts:55,42-46,200).
- stderr-only logs (mcp.md:63 ↔ cmd-mcp.ts:4-8, server.ts:9-12).
- `--http --oauth`, tunnel script, `~/.relay/mcp-oauth-state.json` 0600 (mcp.md:56 ↔ cmd-mcp.ts:83-117,99; scripts/mcp-tunnel-supervisor.sh exists).
- Skill dir exists: docs/skills/relay-memory/SKILL.md.

Stale bits are in the OTHER docs:
- docs/commands.md:187 says `relay mcp` has "**No flags**" — false since `--http` / `--port` / `--oauth` landed (cli.ts:239-242, cmd-mcp.ts:32-58).
- docs/quickstart.md contains zero MCP mention (grep "mcp" = no hits) — the MCP front door is invisible from the quickstart path.
- docs/mcp.md:54 promises reach to "Cursor, Codex, Windsurf" with no per-client config example beyond the CC/Desktop JSON — accurate but thin (one line, mcp.md:25).

## Auto-wire coverage table

| Client | Auto today? | Evidence |
|---|---|---|
| Claude Code (hooks — memory via context emit) | YES | cmd-memory-ops.ts:271-369; cmd-setup.ts:217-243; cmd-init.ts:232-283 |
| Claude Code (MCP `.mcp.json`) | NO (manual) | docs/mcp.md:9-23 only; no writer, no `claude mcp add` call in src |
| Claude Desktop (`claude_desktop_config.json`) | NO (manual) | docs/mcp.md:25 only; zero src hits |
| Cursor (`~/.cursor/mcp.json`) | NO (manual) | docs/mcp.md:25 only; zero src hits |
| Codex CLI (`~/.codex/config.toml`) | NO (manual; read-only probe + AGENTS.md block exist) | codex.ts:57,92-104 (probe); cmd-setup-llm.ts:147-208 (AGENTS.md, not MCP) |
| Windsurf | NO (manual) | docs/mcp.md:25,54 only; zero src hits |
| ChatGPT (remote) | server half auto (`--http --oauth` + tunnel script); connector half manual | cmd-mcp.ts:83-117; scripts/mcp-tunnel-supervisor.sh |

## Top 5 MCP-install gaps

1. **No MCP config writer for ANY client** — even Claude Code's `.mcp.json` is copy-paste from docs. The hook installer is the proven template (marker-idempotent, parse-abort safety, cmd-memory-ops.ts:246-356) but nothing reuses it for `mcpServers` blocks. blocks-install: YES. Fix: M (4 writers: `.mcp.json`, `claude_desktop_config.json`, `~/.cursor/mcp.json`, codex TOML append — JSON three share a shape; TOML needs care).
2. **Codex asymmetry: Relay probes `[mcp_servers.relay]` in `~/.codex/config.toml` (codex.ts:57,103) and gates the `tool_call` capability on it (codex.ts:114), yet `relay setup-llm codex` never writes that entry** — the one client where Relay already knows the exact expected config, install is still manual. blocks-install: YES (for Codex MCP). Fix: S.
3. **No `relay mcp print-config`-style emitter** — no command outputs a ready-to-paste per-client snippet with the resolved absolute binary path and suggested `RELAY_MEMORY_ALLOWED_WORKDIRS`; snippets live only in docs with placeholder paths. blocks-install: no (manual workaround exists). Fix: S.
4. **PATH resolution for GUI clients is docs-only** — Claude Desktop won't inherit shell PATH; docs/mcp.md:29 tells the user to find the absolute `dist/cli.js` symlink themselves. Any auto-writer/snippet-emitter must embed the resolved absolute command (process.execPath sibling or fileURLToPath) or Desktop installs fail silently. blocks-install: YES for Claude Desktop when relay came via npm link/nvm. Fix: S.
5. **No verification surface + stale docs** — `relay doctor`/`relay info`/`relay verify` check hooks and providers but never whether any MCP client actually has the relay server registered (only the codex control probe looks, and it isn't surfaced as an install check); docs/commands.md:187 falsely says `relay mcp` has "No flags"; quickstart.md never mentions MCP. blocks-install: no (but hides broken installs). Fix: S–M.
