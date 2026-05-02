<!-- layer:worker_constraints hash:16df65d2 chars:755 -->
## Troubleshooting

### LM Studio: 'No models loaded'

**Symptom:** `relay run --provider lmstudio` returns 400 with 'No models loaded'.

**Cause:** LM Studio's `/v1/models` endpoint returns *registered* models, but `lms ps` shows what's actually in RAM. They disagree when models are registered but not loaded.

**Fix:** Open LM Studio app, go to Models tab, click load on the model you want. Or run `lms load <model-id>` from terminal. Verify with `lms ps`.

### Codex: 'You've hit your usage limit'

**Symptom:** Codex dispatch fails with `error: You've hit your usage limit. Try again at HH:MM PM.`

**Cause:** OpenAI account-level quota.

**Fix:** Wait until reset time (shown in error). Or set up billing for higher limits at https://platform.openai.com/account/billing. While waiting, route to LM Studio or OpenRouter for non-codex tasks.

### tsconfig.json: 'Invalid value for --ignoreDeprecations'

**Symptom:** `npx tsc` fails with `tsconfig.json(N,N): error TS5103: Invalid value for '--ignoreDeprecations'`.

**Cause:** TypeScript version mismatch (tsconfig set for TS 6.0 but installed version is 5.x).

**Fix:** Edit tsconfig.json: change `"ignoreDeprecations": "6.0"` to `"ignoreDeprecations": "5.0"`. Or pass `--ignoreDeprecations 5.0` on command line.

### Memory: 'MEMORY_WORKDIR_FORBIDDEN'

**Symptom:** `relay memory remember` throws `MEMORY_WORKDIR_FORBIDDEN: Workdir not in RELAY_MEMORY_ALLOWED_WORKDIRS: /path/...`

**Cause:** Env var `RELAY_MEMORY_ALLOWED_WORKDIRS` is set but the current workdir isn't in the allowlist.

**Fix:** Either (a) `unset RELAY_MEMORY_ALLOWED_WORKDIRS` for the session, or (b) prepend your project root to the allowlist: `export RELAY_MEMORY_ALLOWED_WORKDIRS=$RELAY_MEMORY_ALLOWED_WORKDIRS:/Users/you/project`.

### Memory: 'MEMORY_WRITE_RATE_EXCEEDED'

**Symptom:** Bulk write loop fails after 10 entries with rate-limit error.

**Cause:** Per-source-run-id write rate limit (default 10 per 5 minutes).

**Fix:** Don't pass `--source-run-id` on bulk writes — the limiter is keyed on it. Solo CLI users normally skip this flag.

### better-sqlite3: native build error on install

**Symptom:** `npm install -g github:ghanavati/relay` fails compiling better-sqlite3.

**Cause:** Missing build tools or unsupported Node version.

**Fix:** Verify Node 20+ (`node --version`). On macOS install Xcode CLT (`xcode-select --install`). On Linux install `build-essential python3`. Re-run install.

### CC SessionStart hook not injecting memory

**Symptom:** Installed `relay memory hook --install` but new CC sessions don't show recalled-lessons block.

**Cause:** Hook output requires a non-empty recall result. With an empty memory store, the hook silently no-ops.

**Fix:** Verify with `relay memory recall '' --token-budget 800` — if empty, populate via `relay memory remember` or run the migration script (see docs/memory.md).

### RELAY_DB_PATH issues

**Symptom:** `relay memory recall` returns no results despite having data.

**Cause:** Different invocations using different DBs (default `~/.relay/relay.db` vs project-local `./relay.db`).

**Fix:** Set `RELAY_DB_PATH=$HOME/.relay/relay.db` consistently in your shell rc file.