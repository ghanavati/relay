# Cookbook — per-LLM setup recipes

Wire Relay's memory recall into any LLM front-end. Every recipe is a 1-paragraph
explainer + paste-ready bash + verification command + the literal output you
should see. All commands assume `relay` is on your `$PATH` (run `npm link` from
the repo or follow [docs/quickstart.md](./quickstart.md)).

The shared building block is `relay context emit --target <T>`, which prints the
recalled-memory markdown wrapped for one of four targets (`cc`, `codex`,
`lmstudio-http`, `lmstudio-cli`). Front-ends differ only in how that string is
delivered — system role vs. file vs. JSON envelope.

---

## 1. Claude Code

CC's `SessionStart` hook runs a shell command and forwards its
`hookSpecificOutput.additionalContext` field into the session as a system
reminder. Installing the hook globally fires it for every project you open in
CC, scoped to that project's workdir.

```bash
relay memory hook --install --global
```

Installs into `~/.claude/settings.json`. The hook command is exactly:

```text
relay context emit --target cc --workdir "${CLAUDE_PROJECT_DIR:-$PWD}" 2>/dev/null || true
```

Verify:

```bash
relay context emit --target cc --workdir "$PWD"
```

Expected (one line, JSON):

```json
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"## Recalled Lessons\n\n- ..."}}
```

If `additionalContext` is empty there are no memories matching the workdir yet —
add one with `relay memory remember 'test' --workdir "$PWD"` and re-run.

Confirm in a fresh CC session: open a new terminal, run `cc` (or `claude`),
issue any prompt, and look for a `<system-reminder>` containing your memory
text near the top of the model's first turn.

Uninstall:

```bash
relay memory hook --uninstall --global
```

---

## 2. Codex CLI

Codex doesn't read a session-start hook. Inject Relay's memory either by
appending to your global `AGENTS.md` (loaded on every Codex run) or by passing
a one-off file via `-c model_instructions_file=`. The file path goes through
TOML quoting, so prefer absolute paths and avoid spaces.

Option A — persistent block in `~/.codex/AGENTS.md`:

```bash
mkdir -p ~/.codex
cat <<'EOF' >> ~/.codex/AGENTS.md

## Relay-managed memory (regenerate before each session)
$(relay context emit --target codex --workdir "$PWD")
EOF
```

Re-run the heredoc whenever you want fresh memories baked in.

Option B — one-shot per Codex invocation:

```bash
RELAY_CTX="$(mktemp -t relay-codex-XXXXXX.md)"
relay context emit --target codex --workdir "$PWD" --token-budget 1200 > "$RELAY_CTX"
codex -c model_instructions_file="$RELAY_CTX" "<your task>"
```

Verify:

```bash
relay context emit --target codex --workdir "$PWD"
```

Expected — plain markdown, no JSON envelope, no trailing newline:

```text
## Recalled Lessons

- [lesson] never bypass the schema validator with `as never`
- [decision] use SQLite over Postgres because solo deployment
```

If Relay is also dispatching to Codex via `relay run --provider codex ...`, the
worker writes a tempfile and passes it via `-c model_instructions_file=`
automatically — no manual setup needed for that path.

---

## 3. LM Studio

LM Studio's `lms chat` CLI accepts a system prompt with `-s "<text>"`. The
shipped wrapper at `scripts/relay-llm.sh` runs `relay context emit --target
lmstudio-cli` and forwards the encoded payload as the system prompt. Install
the wrapper to `~/.local/bin/relay-llm` and call it like any other CLI.

```bash
bash scripts/install-relay-llm.sh
```

The installer copies `relay-llm` into `~/.local/bin/`, makes it executable, and
runs a smoke test. Make sure `~/.local/bin` is on your `$PATH`.

Use:

```bash
relay-llm qwen/qwen3-coder-next "summarise the last commit message"
```

Verify the wrapper resolves and the encoded context is non-empty:

```bash
which relay-llm
relay context emit --target lmstudio-cli --workdir "$PWD"
```

Expected — a single line of text with literal `\n` for newlines:

```text
## Recalled Lessons\n\n- [lesson] never bypass the schema validator...\n
```

The wrapper passes that string straight to `lms chat <model> -s "<text>" -p
"<task>"`. If `relay context emit` returns empty, the wrapper falls through and
runs `lms chat <model> -p "<task>"` with no system prompt.

For programmatic use against LM Studio's HTTP endpoint, swap the target:

```bash
relay context emit --target lmstudio-http --workdir "$PWD"
# {"role":"system","content":"## Recalled Lessons\n\n- ..."}
```

Drop that JSON object straight into the `messages` array of any
`/v1/chat/completions` POST.

---

## 4. OpenRouter

OpenRouter is a hosted aggregator that proxies any frontier model behind a
single OpenAI-compatible endpoint. Set `OPENROUTER_API_KEY`, then `relay run
--provider openrouter --model <id>` ships your task — and the recalled memory
markdown rides along as a `system`-role message at the head of the array, which
also primes prompt caching.

```bash
export OPENROUTER_API_KEY="<your-openrouter-key>"
relay run "review src/cli.ts for unhandled errors" \
  --provider openrouter \
  --model anthropic/claude-haiku-4.5
```

`WorkerTask.contextPrefix` (the recalled-memory layer) is injected as the first
`system` message regardless of provider — same shape for OpenRouter, Anthropic
direct, and LM Studio HTTP. Workers do not concatenate it into the user
message; the system role keeps it cache-friendly and out of the way of the user
turn.

Verify the key is reachable and Relay can list memory:

```bash
relay doctor --json | jq '.[] | select(.name == "openrouter")'
relay memory show-context "openrouter" --token-budget 800
```

Expected `relay doctor` row:

```json
{"name":"openrouter","status":"ok","detail":"OPENROUTER_API_KEY is set"}
```

Browse models at <https://openrouter.ai/models>; pass any of them to `--model`.
Set a per-request budget cap with `relay budget set openrouter <usd>` (when
the budget command lands in v0.2.x).

---

## 5. Anthropic API direct

Anthropic's Messages API takes a top-level `system` field; Relay's slim
Anthropic worker maps `WorkerTask.contextPrefix` straight into that field, so
your recalled memory shows up exactly as it does on OpenRouter — first, system
role, no concatenation into the user message.

```bash
export ANTHROPIC_API_KEY="<your-anthropic-key>"
relay run "describe the architecture of src/memory/" \
  --provider anthropic \
  --model claude-opus-4-5
```

The slim worker is text-only (no tool-use loop). For agentic Claude with shell
+ tools, route via OpenRouter using `--provider openrouter --model
anthropic/claude-opus-4-5` — Relay still injects the system prefix the same way.

Verify:

```bash
relay doctor --json | jq '.[] | select(.name == "anthropic")'
```

Expected:

```json
{"name":"anthropic","status":"ok","detail":"ANTHROPIC_API_KEY is set"}
```

---

## 6. Multi-LLM workflow

The point of Relay is that all of the above front-ends share one memory store.
A typical solo loop:

- **Claude Code** drives the session — orchestrates, reviews, decides.
  SessionStart hook auto-injects every project's lessons.
- **Codex CLI** runs single-file edits and tests-from-spec, called as
  `relay run --provider codex` from CC. The Codex worker writes
  `model_instructions_file` automatically.
- **LM Studio** absorbs cheap parallel work — bulk file generation,
  schema-shaped output. Use `relay-llm <model> "<task>"` for one-shot calls or
  `relay parallel spec.json --max-concurrency 8` for fan-out.

End-to-end example:

```bash
# 1. Capture an architectural decision in CC
relay memory remember "use SQLite over Postgres because solo deployment" \
  --type decision --pinned

# 2. Hand a refactor to Codex with the same context
relay run "split src/cli.ts into per-command modules" --provider codex

# 3. Fan out test generation to LM Studio
echo '[{"task":"write tests for src/cli/cmd-init.ts","provider":"lmstudio","model":"qwen/qwen3-coder-next"}]' > /tmp/spec.json
relay parallel /tmp/spec.json
```

Every worker reads the same `~/.relay/relay.db` and gets the same lessons
injected. Shared memory, three different cost profiles.

---

## 7. Auto-extract setup

`auto-extract` is the SessionEnd-driven pipeline that distills lessons from a
just-finished CC session and stores them as low-trust (`unverified`) memories.
It's **off by default** and **opt-in per workdir** — there is no global toggle.
The extractor runs against your local LM Studio (no remote call) unless you
explicitly enable `--allow-remote`.

```bash
# 1. Install the SessionEnd hook (once, globally)
relay memory hook --install --session-end --global

# 2. Opt in for this workdir
cd ~/Projects/myapp
relay memory auto-extract --enable
```

`--enable` writes `<workdir>/.relay/auto-extract.json` with `enabled: true`,
`allow_remote: false`, `max_bytes: 32768`, `min_confidence: 0.6`. Re-running
preserves any custom values you've edited.

Verify the consent file and run the pipeline against a fake transcript:

```bash
cat ~/Projects/myapp/.relay/auto-extract.json
relay memory tail --filter auto-extract --since 24h
```

Expected consent file:

```json
{
  "enabled": true,
  "enabled_at": 1714975200000,
  "allow_remote": false,
  "max_bytes": 32768,
  "min_confidence": 0.6,
  "extra_redaction_patterns": []
}
```

Privacy notes:

- LM Studio is **local-only** by default. `auto-extract.json` must explicitly
  set `allow_remote: true` before any remote provider can be used. The
  pipeline blocks remote calls when `allow_remote === false` regardless of
  CLI flags.
- Pre-LLM redaction strips API keys, JWTs, Stripe tokens, database URLs, and
  RFC1918 IPs. If redaction empties the window, the pipeline returns
  `skipped:empty-window` without calling out.
- Auto-extracted memories are tagged `auto-extract` and trust-tier-fenced —
  `markRecallSuccess()` will not auto-pin them no matter how many times they
  recall. Use `relay memory recall ... --min-trust provisional` to exclude
  them from queries entirely.

---

## 8. Privacy operations

Relay surfaces three layers of privacy control: per-project `.relayignore`,
per-memory wipe, and a global pause sentinel.

Disable Relay for a single workdir (writes `.relayignore`, offers to add it to
`.gitignore`):

```bash
cd ~/Projects/secret
relay project disable
```

Audit what would leak from the current workdir if you committed everything:

```bash
relay project audit
```

Expected — counts of installed hooks (via committed `.claude/settings.json`)
and workdir-scoped memories that `to-rules` promotion would surface into
`CLAUDE.md`:

```text
Relay audit for /Users/me/Projects/secret
  hooks_in_committed_settings: 1 (relay-memory-session-start)
  workdir_memories_at_risk: 3
```

Per-project memory wipe (GDPR-style). Soft-delete is the default; use
`--hard` to permanently erase. The `--confirm` phrase is required:

```bash
relay memory wipe --workdir ~/Projects/secret \
  --confirm "WIPE /Users/me/Projects/secret"
# or
relay memory wipe --workdir ~/Projects/secret --hard \
  --confirm "WIPE HARD /Users/me/Projects/secret"
```

Global off-switch — pauses every hook-driven path (recall + auto-extract) by
writing `~/.relay/paused`:

```bash
relay pause --minutes 60   # auto-resumes after 60 min
relay resume               # cancel early
```

Sharable export, filters out `auto-extract`, `private`, and `unverified`
entries:

```bash
relay export --safe --workdir ~/Projects/myapp --format md --out export.md
```

Re-enable a previously-disabled workdir:

```bash
cd ~/Projects/secret
relay project enable
```

---

## 9. Observability

Three commands cover almost every diagnostic question.

`relay info` — single-screen summary of binary version, DB stats, hook install
state, providers reachable, last activity timestamp:

```bash
relay info
```

Expected:

```text
relay v0.2.0
  db:           ~/.relay/relay.db (412 entries, 1.3 MB)
  hook (cc):    installed in ~/.claude/settings.json
  hook (cc-end): installed in ~/.claude/settings.json
  providers:    codex [ok]  lmstudio [ok]  openrouter [missing key]  anthropic [ok]
  last activity: 2 minutes ago (recall, /Users/me/Projects/myapp)
```

`relay doctor` — health probes (recall round-trip, hook subprocess shape, env
consistency, auto-extract last-24h status, providers):

```bash
relay doctor
```

Output is a colour-coded table of probe rows. Pipe `--json` for scripting.

`relay memory tail` — readable view of `~/.relay/relay.ndjson`. Filter by
event substring or window with `--since`:

```bash
relay memory tail --filter recall --since 1h
relay memory tail --filter auto-extract --since 24h --json
```

Expected (default human format):

```text
[2026-05-09T22:14:01Z] recall            cwd=/Users/me/Projects/myapp ok=true  meta={"matches":4}
[2026-05-09T22:14:55Z] hook-roundtrip    cwd=/Users/me           ok=true  meta={"target":"cc"}
[2026-05-09T22:18:32Z] auto-extract      cwd=/Users/me/Projects/myapp ok=true  meta={"status":"ok","lessons":2}
```

Score a single recall result — explains why a memory ranked where it did:

```bash
relay memory why <memory_id>
```

Expected (composite score + per-component contribution):

```text
memory_id: 4f1a...
  score: 0.74
  components:
    recency:        0.92
    frequency:      0.61
    trust:          1.00 (trusted)
    query_match:    0.55 (FTS hit on "berry")
```
