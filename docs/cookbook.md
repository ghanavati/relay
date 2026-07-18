# Cookbook — verified per-LLM recipes

Every recipe is copy-paste ready and validated against the v0.1.0 surface (CLI commands actually wired in `src/cli.ts`). Each block: what + why, install, verify, sample output, common gotcha.

> Recipes assume Relay has already been provisioned and is on `$PATH`, with
> `RELAY_DB_PATH=$HOME/.relay/relay.db` (default).

---

## 1. Claude Code — SessionStart memory injection

**What:** install a CC `SessionStart` hook so every new session in a project auto-receives recalled lessons + decisions + facts via Relay's MemoryStore. Stops the "re-explain context every session" tax.

**Install:**
```bash
cd /path/to/your/project
relay memory hook --install
```

**Verify:**
```bash
cat .claude/settings.json | grep -A2 SessionStart
```

**Sample output:**
```json
"SessionStart": [
  {
    "hooks": [
      { "type": "command", "command": "relay memory recall --token-budget 800 --type lesson --type fact --type decision --json 2>/dev/null || true" }
    ]
  }
]
```

**Gotcha:** the hook is per-project (writes to `<workdir>/.claude/settings.json`). Run it once per repo. Re-running is idempotent — old entries get cleaned out before the new one is appended.

---

## 2. Codex CLI — managed `AGENTS.md` block

**What:** Codex CLI reads `AGENTS.md` (project root) on every invocation. Promote a Relay memory entry into a "Promoted Memory Rules" section so Codex sees it on every dispatch — not just when the recall layer happens to surface it.

**Install:**
```bash
# 1. Save the rule via Relay
relay memory remember 'Always emit a single git commit at end of task' \
  --type decision --tag codex --pinned

# 2. Find its memory_id
relay memory recall codex --json | jq -r '.memories[0].memory_id'

# 3. Promote it to AGENTS.md (Codex's default rules file)
relay memory to-rules <memory_id> --rules-file AGENTS.md
```

**Verify:**
```bash
grep -A3 'Promoted Memory Rules' AGENTS.md
```

**Sample output:**
```
## Promoted Memory Rules

- [decision] Always emit a single git commit at end of task
```

**Gotcha:** `to-rules` appends, never deletes. If you promote the same entry twice, the command silently no-ops (matches the entry text). If you edit and re-save the memory, the old line stays in `AGENTS.md` — clean it manually.

---

## 3. LM Studio (local) — `lms chat -p` wrapper

**What:** dispatch to a locally-loaded LM Studio model via Relay. Zero per-token cost; ideal for parallel test generation, mechanical schema work, or anything you'd otherwise pay frontier rates for.

**Install:**
```bash
# 1. Start LM Studio app, load a model, start the local server (default :1234)
# 2. Confirm it's reachable
curl -sS http://localhost:1234/v1/models | head -20

# 3. Dispatch via Relay
relay run 'write a unit test for src/auth/session.ts' \
  --provider lmstudio --model zai-org/glm-4.7-flash
```

**Verify:**
```bash
relay doctor
```

**Sample output (relevant lines):**
```
codex        [OK]  codex 0.128.1
lmstudio     [OK]  http://localhost:1234 (3 models loaded)
openrouter   [--]  OPENROUTER_API_KEY not set
```

**Gotcha:** model preset matters. For `qwen3-coder` always use the LM Studio in-app preset (temp=1.0, top_k=40, top_p=0.95). Override via `--model` flag ONLY; don't pass arbitrary sampling params via curl — Relay sets sensible defaults.

---

## 4. OpenRouter — env var + system message via curl

**What:** Use OpenRouter's chat-completions surface to reach any model on the catalog (Claude, DeepSeek-R1, Gemini, etc.). Relay's `openrouter` provider wraps this; the curl example below is what Relay sends under the hood, useful for one-off testing without spawning a worker.

**Install:**
```bash
export OPENROUTER_API_KEY="<YOUR_OPENROUTER_KEY>"

# Dispatch via Relay (recommended — captures audit trail)
relay run 'critique src/auth/ for SQL injection risk' \
  --provider openrouter --model anthropic/claude-opus-4-5

# Raw curl equivalent (no audit trail)
curl -sS https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"anthropic/claude-opus-4-5","messages":[{"role":"user","content":"ping"}]}'
```

**Verify:**
```bash
relay doctor
```

**Sample output (relevant line):**
```
openrouter   [OK]  OPENROUTER_API_KEY set (********4d2a)
```

**Gotcha:** OpenRouter bills per request to your account — set a budget cap before running parallel dispatch. Also: model IDs are case-sensitive (`anthropic/claude-opus-4-5`, not `Anthropic/...`).

---

## 5. Anthropic API — env var + native Messages API

**What:** Direct Anthropic Messages API. Relay's `anthropic` worker is text-only (no agentic tool-loop in v0.2). For tool-use Claude, route via OpenRouter using `--model anthropic/claude-...` instead.

**Install:**
```bash
export ANTHROPIC_API_KEY="<YOUR_ANTHROPIC_KEY>"

# Dispatch via Relay
relay run 'summarize this diff in one sentence' \
  --provider anthropic --model claude-opus-4-5

# Raw curl equivalent (Relay uses this exact shape internally)
curl -sS https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-opus-4-5","max_tokens":4096,"messages":[{"role":"user","content":"ping"}]}'
```

**Verify:**
```bash
relay doctor
```

**Sample output (relevant line):**
```
anthropic    [OK]  ANTHROPIC_API_KEY set (********e3c1)
```

**Gotcha:** `--model` is required. The Anthropic worker errors with `INVALID_ARGS: model is required when provider is anthropic` if you forget. Frontend-friendly model IDs (e.g. `claude-opus-4-5`) — not the long API IDs.

---

## 6. Multi-LLM — all four providers, one shared DB

**What:** Use Codex for cross-file refactors, LM Studio for parallel mechanical work, OpenRouter for frontier critique, Anthropic for direct text Q&A — all writing to one `~/.relay/relay.db` so `relay history` and memory recall span the lot.

**Install:**
```bash
export OPENROUTER_API_KEY="<YOUR_OPENROUTER_KEY>"
export ANTHROPIC_API_KEY="<YOUR_ANTHROPIC_KEY>"
export LMSTUDIO_ENDPOINT="http://localhost:1234"
export RELAY_DB_PATH="$HOME/.relay/relay.db"

# One run per provider — DB and memory are shared
relay run 'refactor src/auth.ts to use new session model' --provider codex
relay run 'write test for src/auth.ts'                     --provider lmstudio --model zai-org/glm-4.7-flash
relay run 'critique architectural choice in src/auth.ts'   --provider openrouter --model deepseek/deepseek-r1
relay run 'one-line summary of src/auth.ts behaviour'      --provider anthropic --model claude-opus-4-5
```

**Verify:**
```bash
relay history --limit 4
```

**Sample output:**
```
RUN_ID     PROVIDER     MODEL                     STATUS    DURATION
r-7a4f9c   anthropic    claude-opus-4-5           success    1.2s
r-7a4f9b   openrouter   deepseek/deepseek-r1      success   18.4s
r-7a4f9a   lmstudio     zai-org/glm-4.7-flash     success    4.1s
r-7a4f99   codex        gpt-5.3-codex             success   42.6s
```

**Gotcha:** SQLite is single-writer. Don't run two `relay` processes against the same DB simultaneously — the second one will block on the write lock or error. For parallel dispatch, use `relay parallel` (v0.2) or sequence single-shot calls.

---

## 7. Verify any setup — `relay doctor` walkthrough

**What:** End-to-end smoke test. Probes every provider (codex CLI version, LM Studio reachability, env keys for OpenRouter/Anthropic) plus the local SQLite DB. Run before a long session or after upgrading a provider.

**Install:** (already shipped — no install)

**Run:**
```bash
relay doctor
```

**Sample output (all providers configured):**
```
relay doctor

codex        [OK]  codex 0.128.1
openrouter   [OK]  OPENROUTER_API_KEY set (********4d2a)
lmstudio     [OK]  http://localhost:1234 (3 models loaded)
anthropic    [OK]  ANTHROPIC_API_KEY set (********e3c1)
db           [OK]  ~/.relay/relay.db (142 runs)

All checks passed.
```

**Sample output (partial setup, exit 0):**
```
codex        [OK]  codex 0.128.1
openrouter   [--]  OPENROUTER_API_KEY not set
lmstudio     [--]  http://localhost:1234 unreachable (timeout 3s)
anthropic    [OK]  ANTHROPIC_API_KEY set (********e3c1)
db           [OK]  ~/.relay/relay.db (142 runs)

2 ok, 2 missing (informational).
```

**Gotcha:** `[--]` for missing env keys / unreachable LM Studio is informational only — exit code stays 0. Only hard failures (codex CLI version mismatch, DB unwritable) return exit 1. If `db` shows `failed`, check `RELAY_DB_PATH` permissions before debugging anything else.

---

## 8. Inspect a memory entry before promoting it

**What:** Before pushing a memory to a static rules file (`AGENTS.md`, `.claude/CLAUDE.md`), inspect what's actually stored — content, type, tags, trust level. Memory IDs change between sessions; recall by query first, then `get` by ID.

**Install:** (already shipped)

**Run:**
```bash
# 1. Find candidates
relay memory recall 'codex commit rule' --json | jq '.memories[] | {memory_id, content, trust_level}'

# 2. Inspect one in full
relay memory get mem_8f2a1b9c --json | jq

# 3. Promote if it looks right
relay memory to-rules mem_8f2a1b9c --rules-file .claude/CLAUDE.md
```

**Sample output (`get`):**
```json
{
  "memory_id": "mem_8f2a1b9c",
  "content": "Always emit a single git commit at end of task",
  "memory_type": "decision",
  "tags": ["codex", "workflow"],
  "pinned": true,
  "trust_level": "trusted",
  "created_at": 1715040000000,
  "last_accessed_at": 1715126400000,
  "success_recall_count": 4
}
```

**Gotcha:** `trust_level` is computed at read time — `trusted` requires `human + pinned` OR `success_recall_count >= 3`. An auto-extracted entry with one recall is `provisional` and probably not worth promoting yet.

---

## 9. Preview what workers see — `show-context`

**What:** Workers (Codex/LM Studio/OpenRouter) receive a `Recalled Lessons` block prepended to every dispatched task when `RELAY_RECALLED_LESSONS=1`. This recipe shows you the exact text the worker will see, so you can debug "why did the model not follow rule X" without dispatching.

**Install:** (already shipped)

**Run:**
```bash
RELAY_RECALLED_LESSONS=1 \
  relay memory show-context 'how do I fix the failing test in src/auth/' \
  --type lesson --type decision --token-budget 800
```

**Sample output:**
```
## Recalled Lessons (read before starting — learned from past failures)

1. FAILED: Berry verifier needs gpt-4.1-nano direct OpenAI not OpenRouter
2. Always emit a single git commit at end of task
3. [UNVERIFIED] LM Studio timeouts > 180s usually mean prefill saturation
```

**Gotcha:** the layer is OFF by default. Workers won't see anything until `RELAY_RECALLED_LESSONS=1` is exported. Add to your shell rc file once you've validated the lessons are useful — turning it on for unverified entries can mislead a frontier model.

---

## 10. Memory housekeeping (v0.2 — planned)

The following memory ops are implemented in `src/memory/` (consolidation, gc, lint, rollback) but NOT yet wired to CLI subcommands in v0.1.0:

| Operation | v0.1.0 workaround | v0.2 command |
|---|---|---|
| Find duplicate / contradicting entries | `sqlite3 ~/.relay/relay.db "SELECT memory_id, content FROM memories WHERE content LIKE '%foo%';"` | `relay memory lint` |
| Prune stale non-pinned entries | Auto-runs on every `remember` write | `relay memory gc --max-age-days 30` |
| Merge entries with shared tags | `relay memory get` each one, manually re-`remember` consolidated | `relay memory consolidate --min-shared-tags 2` |
| Roll back a bad migration / auto-extract | `UPDATE memories SET superseded_by='rollback' WHERE tags_json LIKE '%"migration:2026-05-02"%';` | `relay memory rollback --tag migration:2026-05-02` |

Ship target: v0.2. Until then, the auto-GC on `remember()` writes (`gcByTokenBudget`) and `purgeSuperseded()` keep the store from unbounded growth — manual housekeeping is rare.

---

## See also

- [docs/quickstart.md](quickstart.md) — install + first run in 5 minutes
- [docs/providers.md](providers.md) — full per-provider setup
- [docs/memory.md](memory.md) — memory model, trust levels, GC
- [docs/recipes/morning-startup.md](recipes/morning-startup.md) — the 5-command daily kickoff
- [docs/recipes/parallel-with-lmstudio.md](recipes/parallel-with-lmstudio.md) — 16-lane parallel dispatch rules
