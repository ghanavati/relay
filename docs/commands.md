# Commands

Every verb in the v0.2.0 surface. Flags are listed with defaults.

## relay memory

### relay memory remember <content>
Save a memory entry. Flags: `--type <fact|decision|lesson|context|state|handoff>` (default `fact`), `--tag <tag>` (repeatable), `--pinned`, `--workdir <path>`, `--expires-in <hours>`, `--json`.
Example: `relay memory remember 'Berry uses gpt-4.1-nano' --type lesson --tag verification`.

### relay memory recall [<query>]
Retrieve memories by FTS5 query, with recency fallback when there is no match. Flags: `--tag <tag>` (repeatable), `--type <type>` (repeatable), `--token-budget <N>` (default `4000`), `--workdir <path>`, `--include-expired`, `--created-after <unix-ms>`, `--created-before <unix-ms>`, `--file <path>`, `--json`. When `RELAY_MEMORY_ALLOWED_WORKDIRS` is set and `--workdir` is omitted, defaults to current cwd.
Example: `relay memory recall 'authentication' --type lesson --token-budget 2000`.

### relay memory show-context <query>
Preview the recalled_lessons context layer for a query. Flags: `--type <type>` (repeatable, default `lesson` + `decision`), `--token-budget <N>` (default `800`), `--workdir <path>`, `--json`.
Example: `relay memory show-context 'fix the failing test'`.

### relay memory get <memory_id>
Inspect one memory entry. Flags: `--json`.
Example: `relay memory get mem_abc123`.

### relay memory lint
Detects duplicates, stale entries, contradictions. Flags: `--workdir <path>`, `--json`.

### relay memory gc
Garbage-collect stale entries. Flags: `--max-age-days <N>` (default `30`), `--json`. Soft-deletes pinned-but-unused entries; purges superseded tombstones.

### relay memory status
Token budget + entry stats. Flags: `--workdir <path>`, `--json`.

### relay memory promote <memory_id>
Move a workdir-scoped entry to global scope.

### relay memory consolidate
Merge memories with shared tag clusters. Flags: `--workdir <path>`, `--dry-run`, `--min-shared-tags <N>` (default `2`), `--json`.

### relay memory hook --install [--global] [--session-end]
Install or remove the Claude Code hook script. Without `--global`, writes to `<cwd>/.claude/settings.json`. With `--global`, writes to `~/.claude/settings.json` so every CC session sees it. Without `--session-end`, installs the SessionStart injection hook (runs `relay context emit --target cc --workdir "${CLAUDE_PROJECT_DIR:-$PWD}"`). With `--session-end`, installs the SessionEnd auto-extract hook (runs `relay memory auto-extract --from-stdin`). Use `--uninstall` to remove. Implementation in `src/cli/cmd-memory-ops.ts` (`HOOK_SCRIPT` + `HOOK_SCRIPT_SESSION_END` constants).
Example: `relay memory hook --install --global`.
Example: `relay memory hook --install --session-end --global`.

### relay memory auto-extract --enable [--workdir <path>]
Write the consent file `<workdir>/.relay/auto-extract.json` opting this workdir in to session-end auto-extraction. Without consent, the SessionEnd hook is a no-op. Flags: `--enable`, `--disable`, `--workdir <path>` (default cwd), `--json`.
Example: `relay memory auto-extract --enable`.

### relay memory auto-extract --from-stdin
Pipe-driven extractor invoked by the SessionEnd hook. Reads the CC transcript JSON on stdin, validates consent, applies `.relayignore` redaction, calls the configured local model (`RELAY_AUTO_EXTRACT_MODEL`), validates the JSON schema, optionally runs Berry verification, then writes accepted memories with the `auto-extract` tag and 30-day TTL. Errors append to `~/.relay/auto-extract.log`. Implementation in `src/cli/cmd-memory-auto-extract.ts`.
Example: `cat transcript.json | relay memory auto-extract --from-stdin`.

### relay memory wipe --workdir <path>
Hard-delete every memory scoped to the given workdir. Destructive — confirm with `--yes` for non-interactive use. Flags: `--workdir <path>` (required), `--yes`, `--json`. Implementation in `MemoryStore.wipeWorkdir`.
Example: `relay memory wipe --workdir /Users/me/old-project --yes`.

### relay memory tail
Live-tail recent memory writes and hook activity from the centralized log. Flags: `--lines <N>` (default `20`), `--follow`, `--json`. Reads `~/.relay/relay.ndjson`. Implementation in `src/cli/cmd-memory-tail.ts`.
Example: `relay memory tail --follow`.

### relay memory why <memory_id>
Show why a memory scored where it did on the last recall: components include type weight, recency, tag overlap, FTS rank, success-recall count. Flags: `--json`. Implementation in `src/cli/cmd-memory-why.ts`; scoring in `scoreMemoryDetailed` (`src/memory/memory-engine.ts`).
Example: `relay memory why mem_abc123 --json`.

### relay memory forget <memory_id> [--hard]
Soft-delete (default) or hard-delete a memory. Soft-delete sets a tombstone; hard-delete with `--hard` removes the row. Flags: `--hard`, `--json`. Implementation in `MemoryStore.forget`.
Example: `relay memory forget mem_abc123 --hard`.

### relay memory to-rules <memory_id>
Promote a memory entry to a static rules file. Flags: `--rules-file <path>` (default `.claude/CLAUDE.md`), `--json`.

## relay context

### relay context emit --target <cc|codex|lmstudio-http|lmstudio-cli>
Emit recalled memory in the format the target LLM expects. `cc` produces `{additionalContext: "..."}` JSON for CC's SessionStart hook. `codex` produces plain markdown to paste into `AGENTS.md`. `lmstudio-http` produces an OpenAI-compatible system fragment. `lmstudio-cli` produces a single-line text payload for `lms chat -p`. Flags: `--target <name>` (required), `--workdir <path>` (default cwd), `--query <text>`, `--token-budget <N>` (default `800`), `--json`.
Example: `relay context emit --target cc --workdir "$PWD"`.
Example: `relay context emit --target codex > AGENTS.relay.md`.

## relay project

### relay project disable
Stop recall + auto-extract for the current workdir without deleting memory. Flags: `--workdir <path>` (default cwd), `--json`. Writes a sentinel; recall and auto-extract honor it.
Example: `relay project disable`.

### relay project enable
Re-enable recall + auto-extract for the workdir. Flags: `--workdir <path>` (default cwd), `--json`.

### relay project audit
Report what Relay knows about the workdir: memory count, tag distribution, last write, last recall, hook install state. Flags: `--workdir <path>` (default cwd), `--json`.

## relay run

### relay run <task>
Delegate a task to a worker. Flags: `--provider <codex|lmstudio|openrouter|anthropic|lmstudio-agentic>` (default `codex`), `--model <id>` (required for HTTP providers), `--workdir <path>` (default cwd), `--timeout-ms <N>` (default `300000`), `--reasoning-effort <low|medium|high>`, `--json`.
Example: `relay run 'fix the failing test' --provider codex --model gpt-5.3-codex`.

With `--provider lmstudio-agentic`, the run is registered as a Relay control session (session_id = run_id, ended when the run finishes) and the model is offered the `relay_session_list` / `relay_session_inspect` / `relay_session_send` / `relay_inbox_read` / `relay_inbox_ack` control tools alongside `shell_exec`. LLM-initiated sends stay default-deny — they require a grant issued via `relay session grant` (see `relay session`).

## relay parallel

### relay parallel <spec.json>
Dispatch N tasks concurrently from a JSON spec. Flags: `--max-concurrency <N>` (default `4`), `--json`.
Example: `relay parallel ./batch.json --max-concurrency 8`.

## relay session

Universal control layer (Phase 8): every supported LLM surface registers as a control session with an explicit capability set. One command surface drives them all — observe, send, delegate, and (for processes Relay launches) live stdin and interrupt. Commands refuse unsupported operations (`CONTROL_DELIVERY_UNSUPPORTED`) instead of silently degrading. Agent-initiated cross-session sends are gated by grants, budgets, and loop detection; human (`relay session ...`) sends are not. Exit codes: 0 success, 1 policy/runtime failure (RelayError code on stderr), 2 usage error.

### relay session list
List registered control sessions with provider, state, and declared capabilities. Flags: `--provider <claude-code|codex|lmstudio|openrouter|anthropic|fake>`, `--state <active|idle|ended>`, `--json`.
Example: `relay session list --provider lmstudio --json`.

### relay session inspect <session_id>
Show one session's record, queued mailbox count, and recent audit events. Flags: `--json`.
Example: `relay session inspect 4f1c... --json | jq .queued_count`.

### relay session tail <session_id>
Tail a session's audit events in append order. Flags: `--after <event_id>` (monotonic cursor — pass the last seen id to poll), `--limit <N>` (default `100`, max `1000`), `--json`.
Example: `relay session tail 4f1c... --after 120 --json`.

### relay session send <session_id> <text>
Send a brokered, redacted, audited message to a session (sender_kind `human`). Delivery is attempted through the target provider's adapter when one is registered; otherwise the message waits honestly in the mailbox (`status: queued`). Flags: `--from <source_id>` (default `human:cli`), `--expires-in <duration>` (e.g. `30s`, `10m`, `2h`), `--no-deliver` (queue only), `--json`.
Example: `relay session send 4f1c... 'stop after the current test run' --json`.

### relay session delegate <session_id> <task>
Delegate a task to a session that declares the `tool_call` capability (a session that can't call tools can't act on a delegated task — D-01). Routes through the same broker policy path as `send`. Flags: `--from <source_id>`, `--no-deliver`, `--json`.
Example: `relay session delegate lm-sess-a 'write tests for src/auth.ts' --json`.

### relay session spawn --provider <name> <command...>
Launch a Relay-owned process session. Relay owns the pipes, so it can observe and tail the child's stdout/stderr as control events, write to its stdin (`live_stdin`), and interrupt it with SIGINT. Line-based processes get strong control; full-TTY CLIs (claude, codex) detect non-TTY stdio and report `live_stdin` absent. The command follows the provider; for a command with its own flags, wrap it in a shell — `relay session spawn --provider lmstudio sh -c 'mycli --flag'`. While it runs, peer `relay session send <id>` messages are delivered onto the child's stdin. Flags: `--workdir <path>`, `--json`. Exit code mirrors the child.
Example: `relay session spawn --provider fake node repl.js`.

### relay session grant <source_id> <target_id>
Authorize LLM-initiated sends from source to target (D-04 — LLM sends are default-deny). TTL and message budget are always bounded. Flags: `--ttl <duration>` (default `15m`), `--max-messages <N>` (default `10`), `--json`.
Example: `relay session grant lm-sess-a cc-sess-b --ttl 30m --max-messages 5`.

### relay session revoke <grant_id>
Revoke a grant immediately. Idempotent. Flags: `--json`.
Example: `relay session revoke 9a2e...`.

### relay session pause <session_id>
Mark an active session idle (requires the session to declare `interrupt`). Records a `session_updated` audit event. Flags: `--json`.
Example: `relay session pause 4f1c... --json`.

### relay session resume <session_id>
Return an idle session to active (requires `resume_send`). Flags: `--json`.
Example: `relay session resume 4f1c... --json`.

### relay session approve <request_id>
Approve a pending model-initiated grant request and issue the grant. Human only — a model can never approve its own request (D-14). Flags: `--ttl <duration>`, `--max-messages <N>` (override the requested values), `--json`.
Example: `relay session approve 7b3d... --ttl 20m --json`.

### relay session deny <request_id> [reason]
Deny a pending model-initiated grant request. Flags: `--json`.
Example: `relay session deny 7b3d... 'not now' --json`.

## relay tui

### relay tui
Command Central is the terminal-native operator console over the control layer. It is an Ink terminal UI that runs entirely in your terminal — no hosted service, no graphical client. The layout is a split rail on the left (a Sessions roster plus a merged Queue of inbox, grants, and pending requests), a live event stream on the right with `human` / `llm` source badges and pending/approved/denied/executed dispositions, and one status strip along the bottom. The control snapshot refreshes on a fast cadence so the stream stays live; provider probes refresh on a slower cadence and are timeout-bounded so an offline backend never stalls the UI. Flags: `--json` (emit the underlying bounded `ControlSnapshot` once instead of rendering — the same read model the TUI consumes, D-12). Keys: `q` quit, `j` / `k` move the rail selection, `:` open the command palette.
Example: `relay tui`.
Example: `relay tui --json | jq .control.pending_actions`.

The `:` palette runs the same broker-backed actions as `relay session ...`, defaulting to the selected session when the argument is omitted:

- `send <session> <message…>` — brokered, redacted, audited message to a session.
- `delegate <session> <task…>` — delegate a task to a session that declares `tool_call`.
- `inspect [session]` — record, queued count, and recent events for a session.
- `tail [session]` — recent audit events for a session.
- `grant <source> <target> [ttl] [max]` — authorize LLM-initiated sends (default-deny without a grant).
- `revoke <grant_id>` — revoke a grant immediately.
- `pause [session]` / `resume [session]` — move a session idle or active (capability-gated).
- `approve <request_id>` — approve a pending model-initiated grant request and issue the grant.
- `deny <request_id> [reason…]` — deny a pending model-initiated grant request.

Relay-owned process sessions enter the rail through `relay session spawn` (see `relay session`). Once spawned, the palette observes, tails, sends to, pauses, and resumes them like any other session.

#### Verifying Command Central

Two paths share one broker, so both are worth a pass.

Human-driven control: spawn or register a session, open `relay tui`, select it in the rail, then drive it from the `:` palette — `send` or `delegate` a message, watch the result land in the live stream with a `human` badge, then `pause` and `resume` it. `relay session list --json` and `relay tui --json` report the same state the rail shows.

Model-requested control: a running model has no cross-session authority by default. When it needs to reach a peer it calls the `relay_control_request_grant` tool, which records a visible `control_requested` event — it appears in the Queue and the stream with an `llm` badge and a `pending` disposition. A human resolves it from the palette: `approve <request_id>` issues the grant, after which the model's next brokered `send` is delivered to the target; `deny <request_id>` closes it with no grant. A model cannot approve its own request — self-approval is rejected at the broker (`self_approval_blocked`), so authority only ever moves through a human. The control snapshot health and the pending grant-request queue depth are reported by `relay verify` and `relay doctor` as well (see below).

## relay mcp

### relay mcp
Run Relay as a stdio MCP server. Exposes exactly two tools to the connected client: `relay_memory_recall` and `relay_memory_save` — thin wrappers over the same memory handlers and SQLite store the CLI uses, with the same `RELAY_MEMORY_ALLOWED_WORKDIRS` scoping. Blocks until the client disconnects (or SIGINT/SIGTERM); diagnostics on stderr, stdout reserved for protocol framing. No flags. Started by the MCP client (Claude Code, Claude Desktop, Cursor, ...), not by hand — registration recipe and security posture in [docs/mcp.md](./mcp.md).
Example `.mcp.json` entry: `{"mcpServers": {"relay": {"command": "relay", "args": ["mcp"]}}}`.

## relay history / diff / compare

### relay history
List recent runs. Flags: `--limit <N>` (default `10`), `--provider <P>`, `--status <ok|error|timeout>`, `--json` (NDJSON, one row per line).

### relay diff <run_id>
Show files_changed + diffs for a run. Flags: `--json`.

### relay compare <run_a> <run_b>
Side-by-side diff of two runs. Flags: `--json`.

## relay verify

### relay verify
End-to-end smoke test of the live surface. Runs memory remember, recall, context emit, the SessionStart hook script roundtrip, a direct DB roundtrip, a rolled-back control broker send (broker send → delivered, zero residue), and a Command Central read-model check that builds the bounded `ControlSnapshot` and reports the pending grant-request queue depth. Exit 1 if any critical check fails. Flags: `--json` (structured `{checks, summary, ok}`). Implementation in `src/cli/cmd-verify.ts`.
Example: `relay verify --json | jq '.checks[] | select(.name=="command-central")'`.

## relay info

### relay info
Overall status: binary version, DB stats (memory count, last write, total tokens), hook install state (per-project + global, SessionStart + SessionEnd), provider reachability summary, last activity timestamp, auto-extract log tail. Flags: `--json`. Implementation in `src/cli/cmd-info.ts`.
Example: `relay info`.
Example: `relay info --json | jq .hooks`.

## relay update

### relay update [--check] [--apply]
Check for or apply updates to the Relay binary. Default `--check` (notify-only — fetches latest tag, compares to local). With `--apply`, fetches the repo into a temp dir, runs `npm install + build`, and atomically swaps the symlink. Flags: `--check`, `--apply`, `--json`. Implementation in `src/cli/cmd-update.ts`.
Example: `relay update --check`.
Example: `relay update --apply`.

## relay pause / resume

### relay pause [--minutes <N>] [--global]
Block all Relay hooks (SessionStart injection + SessionEnd auto-extract) by writing the sentinel `~/.relay/paused`. Without `--minutes`, pauses indefinitely until `relay resume`. With `--global`, applies to all workdirs (default behavior — sentinel is global). Flags: `--minutes <N>`, `--global`, `--json`. Implementation in `src/cli/cmd-pause.ts`.
Example: `relay pause --minutes 30`.
Example: `relay pause` (until manually resumed).

### relay resume
Remove the pause sentinel. Flags: `--json`.
Example: `relay resume`.

## relay export

### relay export --safe [--workdir <path>] [--format <json|md>] [--out <file>]
Export memory for sharing. `--safe` (default behavior) excludes the `auto-extract` tag, the `private` tag, and any entry with trust tier `unverified`. Flags: `--safe` (default), `--workdir <path>`, `--format <json|md>` (default `json`), `--out <file>` (default stdout), `--json`. Implementation in `src/cli/cmd-export.ts`.
Example: `relay export --safe --format md --out memory.md`.
Example: `relay export --safe --workdir /Users/me/proj-a --format json`.

## relay setup

### relay setup --everything [--workdir <path>] [--lm-model <id>] [--yes]
Non-interactive wrapper that runs the full first-time install: `relay init --auto`, then both hooks installed globally, then auto-extract enabled for the given workdir. Flags: `--everything` (required marker), `--workdir <path>` (default cwd), `--lm-model <id>` (optional auto-extract model preset), `--yes` (skip the final confirm), `--json`. Implementation in `src/cli/cmd-setup.ts`.
Example: `relay setup --everything --yes`.
Example: `relay setup --everything --workdir /Users/me/proj --lm-model qwen/qwen3-coder-next`.

## relay setup-llm

### relay setup-llm <codex|lmstudio|openrouter|anthropic> [--write]
Per-LLM init helper. Probes the named LLM, prints a recommended setup, and with `--write` applies it: for `codex`, appends a Relay-managed block to `AGENTS.md`; for `lmstudio`, writes a model preset note; for `openrouter`, probes the API key and lists available models; for `anthropic`, probes the API key. Flags: `--write`, `--json`. Implementation in `src/cli/cmd-setup-llm.ts`.
Example: `relay setup-llm codex --write`.
Example: `relay setup-llm openrouter` (dry-run, prints recommendation).

## relay init

### relay init [--auto|--quick] [--global] [--json]
Interactive first-run wizard. Probes providers, offers SessionStart + SessionEnd hook install (defaults to `--global`), offers per-workdir auto-extract consent, offers CC memory migration, ends with a verify step that runs `relay context emit --target cc` and parses the round-trip. `--auto` skips prompts (accepts sensible defaults). `--quick` writes an empty config and returns. Flags: `--auto`, `--quick`, `--global`, `--json`. Implementation in `src/cli/cmd-init.ts:82-201`.
Example: `relay init --auto`.

## relay doctor

### relay doctor
Probe provider + DB health. Includes the auto-extract status check (`~/.relay/auto-extract.log` 24h ok/skipped/error counts), the control-layer check (session / active / queued / blocked counts), and a Command Central check that reports the read-model snapshot health (built within its declared bounds) and the pending grant-request queue depth. Flags: `--json`. Implementation in `src/cli/cmd-doctor.ts`.
Example: `relay doctor --json`.

## relay completion

### relay completion <bash|zsh|fish>
Emit shell completion script for the named shell.
Example: `relay completion zsh > "${fpath[1]}/_relay"`.

