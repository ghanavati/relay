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

## Workdir isolation

The `RELAY_MEMORY_ALLOWED_WORKDIRS` env var allows you to restrict which workdirs can write memory. Set it for multi-project setups where you don't want one project's writes affecting another.

## What you should never do

- Don't pipe untrusted input into `relay memory remember` without inspecting it.
- Don't run Relay as root.
- Don't expose `~/.relay/relay.db` over a network share or sync it via cloud storage with multi-device write (corruption risk + secrets leak).
- Don't pass `--workdir` to a path you don't control.

## Audit trail

Every `relay run` and `relay parallel` creates a row in the `runs` table with the full input + output. This is your audit trail. It's not signed or tamper-evident in v0.1.0; trust the local filesystem.