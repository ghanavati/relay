# Troubleshooting

> Install Relay from GitHub Releases, not npm. Start with the archive and
> checksum steps in [install.md](./install.md).

Symptom-first guide for users who installed Relay and something is wrong.
Start at the top, work down.

> Wave 4 commands referenced below (`relay verify`, `relay setup`,
> `relay setup-llm`, `relay info`, `relay memory auto-extract`) ship in the
> Wave 4 release. On earlier builds the underlying probes are still
> available via `relay doctor` and direct file inspection.

## 1. First step always: `relay verify`

End-to-end smoke test , exercises provider probes, DB write/read, hook fire,
and memory recall. Reports the first thing that breaks.

```bash
relay verify
relay verify --json     # scriptable
```

Green → install is healthy; the problem is in your usage (wrong provider,
wrong workdir, stale binary). Red → fix the failing check first using the
matching section below.

## 2. Doctor deep dive: `relay doctor --json`

When `relay verify` is not specific enough, run `relay doctor` to see each
check independently.

```bash
relay doctor
relay doctor --json
```

Checks (defined in `src/cli/cmd-doctor.ts`):

| Check | Probes | "ok" | "missing" / "failed" |
|---|---|---|---|
| `codex` | `codex --version` (5s) | CLI on PATH | CLI missing or shadowed |
| `openrouter` | `OPENROUTER_API_KEY` env | Set | Not set |
| `lmstudio` | GET `${LMSTUDIO_ENDPOINT\|http://localhost:1234}/v1/models` (3s) | Reachable; reports model count | Endpoint down or wrong port |
| `anthropic` | `ANTHROPIC_API_KEY` env | Set | Not set |
| `db` | Opens SQLite at `RELAY_DB_PATH ?? ~/.relay/relay.db`, counts rows in `runs` | DB readable, schema valid | File locked, corrupt, schema mismatch |

Wave 4 adds an `auto_extract` check (consent file + log staleness).

## 3. Common failures

### Hook never fires
Installed `relay memory hook --install` but new CC sessions show no
recalled-lessons block.

Causes: duplicate hook entries, or recall returned empty (silent no-op).

```bash
# Inspect , look for duplicates
jq '.hooks.SessionStart' ~/.claude/settings.json

# Wave 4: clean reinstall
relay setup --clean
relay memory hook --install --global

# Or re-run install (idempotent , strips stale entries)
relay memory hook --install

# Confirm recall returns content
relay memory recall '' --token-budget 800 --type lesson --type fact --type decision
```

`executeMemoryHookCommand()` in `src/cli/cmd-memory-ops.ts` strips legacy
`{id, run}` shapes and current-format entries whose inner `hooks[]` matches
the canonical `HOOK_SCRIPT`. If duplicates persist, your file's command
string does not match `HOOK_SCRIPT` exactly , copy-paste it. Empty recall
means an empty memory store; populate via `relay memory remember` or run
the migration in `docs/memory.md`.

### Auto-extract not running
New lessons are not appearing after CC sessions complete.

Causes: missing consent file (opt-in), or extractor failed silently (LM
Studio model unloaded).

```bash
# Wave 4: enable consent
relay memory auto-extract --enable

# Tail centralized log (Wave 4)
tail -f ~/.relay/relay.ndjson | jq 'select(.event | startswith("auto_extract"))'

# Pre-Wave-4 / Wave-4a legacy log
tail -f ~/.relay/auto-extract.log
```

If the log shows `model_not_loaded`, see LM Studio below. If the log is
empty, the hook is not firing , re-check `relay memory hook --install`.

### Memories not surfacing in CC sessions
Hook fires (visible in `~/.relay/relay.ndjson`), but the recalled-lessons
block is empty or missing entries you know exist.

Causes: hook's `--type` filter excludes them, `--min-trust` filter excludes
them, or workdir mismatch.

```bash
# Inspect hook command , defaults: --type lesson --type fact --type decision
grep -A1 SessionStart ~/.claude/settings.json

# Recall with no filters
relay memory recall '' --token-budget 800 --json | jq '.entries | length'

# Re-run hook's exact query
relay memory recall --token-budget 800 --type lesson --type fact --type decision
```

To widen the hook permanently, edit `.claude/settings.json` and add more
`--type` flags (e.g. `--type context`).

### `MEMORY_WORKDIR_FORBIDDEN`
`relay memory remember` or `recall` throws
`MEMORY_WORKDIR_FORBIDDEN: Workdir not in RELAY_MEMORY_ALLOWED_WORKDIRS: /path/...`

Cause: `RELAY_MEMORY_ALLOWED_WORKDIRS` is set (SHIP-70 sandboxing) but the
hook command is missing `--workdir` or the cwd is not in the allowlist.

Fix , pick one:
```bash
# (a) Unset for this shell
unset RELAY_MEMORY_ALLOWED_WORKDIRS

# (b) Append your project root
export RELAY_MEMORY_ALLOWED_WORKDIRS=$RELAY_MEMORY_ALLOWED_WORKDIRS:/Users/you/project

# (c) Pass --workdir explicitly in the hook command
relay memory recall --workdir /Users/you/project --token-budget 800 --type lesson
```

Definition: `assertWorkdirAllowed` in `src/memory/memory-store.ts`.

### Stale relay binary version
A flag from a recent release returns `error: unknown option`.
`relay --version` is older than `package.json`.

```bash
cd /path/to/relay
npm run build
which relay
relay --version
Re-provision the evaluation runtime if its executable path is stale.
```

### LM Studio extraction fails
`relay run --provider lmstudio` returns 400 with `No models loaded`. Or the
auto-extract log shows `model_not_loaded`.

Cause: LM Studio's `/v1/models` returns *registered* models; `lms ps` shows
what is actually in RAM. They disagree when models are registered but not
loaded.

```bash
lms ps                     # confirm what is loaded
lms load <model-id>        # load from terminal
relay info --json          # Wave 4: confirm Relay sees the right endpoint
relay doctor               # confirm probe passes
```

If `relay info` shows the wrong endpoint, set `LMSTUDIO_ENDPOINT` (default
`http://localhost:1234`).

### Two SessionStart hooks firing
Recalled-lessons block appears twice, or appears to fight with another
hook for the same slot.

Cause: pre-Wave-4 install left a legacy entry, or
`relay memory hook --install` was run from two repos and global settings
collected both.

```bash
relay setup --clean                          # Wave 4: remove all relay hooks
relay memory hook --install --global         # reinstall once, globally
```

Pre-Wave-4 manual cleanup: edit `~/.claude/settings.json` by hand to dedupe
the SessionStart array.

### Codex won't pick up Relay context
Codex dispatches succeed but the recalled-lessons block is not visible to
the worker. CC sees it; Codex does not.

Cause: Codex reads `AGENTS.md`, not `.claude/settings.json`. The Relay
context block must be installed separately.

```bash
relay setup-llm codex --write     # Wave 4: install AGENTS.md block
```

Appends a `## Relay Context` section to `AGENTS.md` at the project root
(or `~/.codex/AGENTS.md` for global).

### DB locked / corrupted
Every `relay` command fails with `SQLITE_BUSY`, `SQLITE_CORRUPT`, or
`database disk image is malformed`.

Cause: two processes opened the DB in WAL mode and one crashed; or
filesystem corruption.

Back up first:
```bash
DB=${RELAY_DB_PATH:-$HOME/.relay/relay.db}
cp -p "$DB" "$DB.bak.$(date +%s)"
cp -p "$DB-wal" "$DB-wal.bak" 2>/dev/null || true
cp -p "$DB-shm" "$DB-shm.bak" 2>/dev/null || true

sqlite3 "$DB" 'PRAGMA integrity_check;'

# If integrity_check fails, dump-and-rebuild
sqlite3 "$DB" '.dump' > /tmp/relay-dump.sql
mv "$DB" "$DB.broken"
sqlite3 "$DB" < /tmp/relay-dump.sql
```

If still failing, move the broken DB aside and let Relay create a fresh
one , you lose history but keep the binary.

### `MEMORY_WRITE_RATE_EXCEEDED`
Bulk write loop fails after 10 entries.

Cause: per-source-run-id write rate limit (default 10 per 5 minutes;
`src/memory/memory-store.ts`).

Fix: don't pass `--source-run-id` on bulk writes , the limiter is keyed
on it. Solo CLI users normally skip this flag.

### Public installation
Download the platform archive and `SHA256SUMS.txt` from the
[Releases page](https://github.com/ghanavati/relay/releases), then follow the
checksum and setup commands in [install.md](./install.md).

### Codex: "You've hit your usage limit"
`error: You've hit your usage limit. Try again at HH:MM PM.`

Cause: OpenAI account-level quota.

Fix: wait for the reset shown in the error. While waiting, route to LM
Studio or OpenRouter for non-Codex tasks. Set up billing for higher limits
at https://platform.openai.com/account/billing.

### `tsconfig.json`: "Invalid value for --ignoreDeprecations"
`npx tsc` fails with `error TS5103: Invalid value for '--ignoreDeprecations'`.

Cause: TS version mismatch (tsconfig set for TS 6.0 but installed is 5.x).

Fix: edit `tsconfig.json` , change `"ignoreDeprecations": "6.0"` to
`"5.0"`. Or pass `--ignoreDeprecations 5.0` on the command line.

### `RELAY_DB_PATH` issues
`relay memory recall` returns no results despite having data.

Cause: different invocations using different DBs (default
`~/.relay/relay.db` vs project-local `./relay.db` vs `:memory:` from a
test shell).

```bash
# Set consistently in your shell rc
export RELAY_DB_PATH=$HOME/.relay/relay.db

# Verify which DB the current shell sees
relay doctor --json | jq '.checks[] | select(.name=="db")'
```

## 4. Log locations

| Path | Format | Lifecycle |
|---|---|---|
| `~/.relay/relay.ndjson` | NDJSON, one event per line | Centralized log, post Wave 4 , every dispatch, hook fire, memory write |
| `~/.relay/auto-extract.log` | Plain text | Legacy, removed in Wave 4b , use `relay.ndjson` and filter `event` field |
| `~/.relay/relay.db` | SQLite | DB itself; override with `RELAY_DB_PATH` |
| `<project>/.claude/settings.json` | JSON | Per-project hook config |
| `~/.claude/settings.json` | JSON | Global hook config (when installed with `--global`) |

Triage one-liners:
```bash
tail -20 ~/.relay/relay.ndjson | jq                              # last 20 events
jq 'select(.event=="hook_fire")' ~/.relay/relay.ndjson | tail    # hook fires only
jq 'select(.level=="error")' ~/.relay/relay.ndjson | tail        # errors only
```

## 5. When to file an issue

Gather first:
```bash
relay --version
relay doctor --json
relay verify --json 2>&1 | tee /tmp/relay-verify.txt
node --version
uname -a
tail -200 ~/.relay/relay.ndjson > /tmp/relay-tail.ndjson
```

Open an issue at the repo's bug tracker (link TBD , see project README).
Attach `/tmp/relay-verify.txt` and the tail. Redact any API keys before
sharing.
