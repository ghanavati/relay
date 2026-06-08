# Security policy

## Reporting a vulnerability

If you find a security issue in Relay, please email the maintainer privately rather than opening a public issue. Email is in the LICENSE file or git log.

DO NOT post security issues, exploits, or PoCs in public GitHub issues, discussions, or pull requests.

Response target: best-effort within 7 days. This is a solo project; no SLA.

## What's in scope

- Memory contents leaking across sessions or workdirs
- API key exposure in logs, stdout, or audit trail
- Prompt injection from memory content into worker dispatch
- Filesystem path traversal in `--workdir` arguments
- SQL injection via FTS5 queries (better-sqlite3 should prevent this, but report anyway)
- Race conditions in concurrent CLI invocations

## What's NOT in scope

- Vulnerabilities in upstream dependencies (better-sqlite3, zod, Node, etc.) — report directly to those projects.
- Vulnerabilities in worker providers (codex CLI, OpenRouter API, LM Studio) — report directly to those projects.
- Vulnerabilities in models themselves (jailbreaks, hallucinations, etc.) — report to the provider.
- Issues that require an attacker who already has shell access on the host (Relay runs as the user, by design).

## Secret handling in v0.1.0

Provider API keys live in environment variables only:
- `OPENROUTER_API_KEY` — OpenRouter API key
- `ANTHROPIC_API_KEY` — required when using `--provider anthropic`
- `LMSTUDIO_API_KEY` — only if LM Studio is behind a reverse proxy

Relay does NOT log API keys. The redactSecrets utility (src/security/redaction.ts) strips:
- AWS keys (`AKIA...`)
- OpenAI/Anthropic keys (`sk-...`, `sk-ant-...`)
- GitHub PATs (`ghp_...`)
- Slack tokens (`xox...`)
- Generic `api_key=<20+ chars>`
- PEM private keys

From memory content before storage. If you find a pattern that escapes redaction, please report.

## Database access

The SQLite database at `~/.relay/relay.db` (or `$RELAY_DB_PATH`) contains your memory entries, run history, and audit trail. It's stored unencrypted on the local filesystem. If the host is compromised, the DB is readable.

Recommendations:
- Set `chmod 600 ~/.relay/relay.db` (Relay attempts this on first create).
- Don't store API keys in memory entries (use env vars for keys).
- Use full-disk encryption (FileVault on macOS, LUKS on Linux).

## Memory content as attack surface

Memory entries are injected into worker prompts via the recalled_lessons context layer. A malicious memory entry could attempt prompt injection on workers ("ignore previous instructions and ...").

Mitigations:
- All memory writes go through `sanitizeContent()` which strips `<private>...</private>` blocks and redacts secrets.
- Workers are sandboxed (codex with --dangerously-bypass-approvals-and-sandbox runs in their own subprocess; lmstudio/openrouter are HTTP).
- Workers do not have direct memory write access — only the user does via CLI.

## Agentic shell_exec and the control layer

`relay run --provider lmstudio-agentic` (and the same provider under `relay parallel`) runs a local model in a tool loop with a `shell_exec` tool. That shell runs as you, in the task workdir. The control layer (`relay session ...`, the broker, grants) is meant to be driven by models only through the in-process `relay_session_*` tools, which are caller-bound and default-deny — never through the human `relay` CLI, which always acts as `kind: human`.

A model with `shell_exec` could otherwise shell out to `relay session send` / `grant` / `approve` to sidestep the broker's default-deny, or read the control DB directly. v0.1.x raises the bar with layered checks; it does NOT make this airtight:

- `shell_exec` blocks `relay` as a command head, the same way it blocks `curl` / `ssh`. This is a basename match only — it does not see `relay` hidden inside `sh -c "relay ..."` or a copied/renamed binary.
- The `shell_exec` child env drops the whole `RELAY_*` namespace (including `RELAY_DB_PATH`) and every secret-shaped variable, then force-sets `RELAY_AGENTIC_SANDBOX=1`.
- Mutating `relay session` subcommands (send, delegate, grant, revoke, approve, deny, pause, resume, spawn) refuse when `RELAY_AGENTIC_SANDBOX` is set. So even when a `relay` binary does run — via `sh -c`, an alias, or a copied path — it refuses, as long as it inherited the marker. Read-only `list` / `inspect` / `tail` stay allowed.

Residual bypasses, documented rather than claimed fixed:

- Unsetting the marker at exec time, e.g. `RELAY_AGENTIC_SANDBOX= relay session send ...` or `env -u RELAY_AGENTIC_SANDBOX relay ...`. Injecting the marker into the spawn env cannot stop a command string from clearing its own environment.
- Direct DB writes. `RELAY_DB_PATH` is stripped, but `HOME` is allowed, so a model can compute `$HOME/.relay/relay.db` and write it with `sqlite3` or any language runtime. The control DB is an unencrypted local file (see Database access).
- Any non-`relay` binary or in-process trick the basename blocklist does not cover.

This is mitigation, not a security boundary. A determined or prompt-injected local model with shell access can still reach `~/.relay/relay.db`. Treat `lmstudio-agentic` the way you would treat running any untrusted local script as your user. Airtight isolation — an OS sandbox (sandbox-exec / unshare), a separate control DB the agentic worker cannot open, or an unprivileged user — is future work, not in v0.1.x.

## Relay-owned process sessions

`relay session spawn` launches a child process Relay owns, tails its output as control events, and can write its stdin. Two safeguards keep that child's secrets out of the stored audit trail:

- The child gets a sanitized env: secret-shaped variables (provider API keys) and the `RELAY_*` control namespace are removed before spawn. A child that prints `env` cannot echo a provider key into a control event. A spawned CLI that needs an API key must read it from its own config file, not inherit it from Relay's environment.
- Output (stdout/stderr), injected stdin, the command/args text, and any spawn error are run through the same redactor as the broker (`REDACTION_PATTERNS`) before they are written to control events or session metadata. The live terminal mirror still shows you the child's real output.

The env-name sanitizer is delimiter-aware: it strips `_`-delimited credential names such as `AWS_ACCESS_KEY_ID`, `GOOGLE_APPLICATION_CREDENTIALS`, `SSH_AUTH_SOCK`, and `MYSQL_PWD`, not only names with a trailing keyword. Connection-string credentials live in the value rather than the name (a `DATABASE_URL` whose value embeds a user and password inside the URL userinfo), so a child can still inherit such a var to function; the redactor strips the userinfo credentials before any value reaches a stored event. Name-based stripping is necessarily incomplete — treat a secret printed by an owned child as redacted-in-storage, not as never-having-existed in the child's memory.

## Workdir isolation

The `RELAY_MEMORY_ALLOWED_WORKDIRS` env var allows you to restrict which workdirs can write memory. Set it for multi-project setups where you don't want one project's writes affecting another.

## What you should never do

- Don't pipe untrusted input into `relay memory remember` without inspecting it.
- Don't run Relay as root.
- Don't expose `~/.relay/relay.db` over a network share or sync it via cloud storage with multi-device write (corruption risk + secrets leak).
- Don't pass `--workdir` to a path you don't control.

## Audit trail

Every `relay run` and `relay parallel` creates a row in the `runs` table with the full input + output. This is your audit trail. It's not signed or tamper-evident in v0.1.0; trust the local filesystem.