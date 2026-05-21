---
doc_type: security_baseline
asvs_level: 2
baseline_for: v0.2 Phases 3-7
written_at: 2026-05-20
purpose: Snapshot of current security posture so post-execution audits can measure delta
written_by: gsd-security-auditor (read-only inspection of src/, no code changes)
---

# Relay Security Baseline (pre-Phase 3)

Snapshot of the privacy + injection + secret posture in `main` as of 2026-05-20.
Phase 3-7 audits MUST compare against this — net-new threat surface only.

Verification = direct read of `src/`. No claims about behaviour beyond what
the grep / file-read evidence supports.

Note on documentation hygiene: provider-specific token prefixes are referred to
by name (e.g. "Stripe-style test / live keys", "Anthropic-style sk-prefix
keys") rather than literal prefix strings, so that this baseline file itself
does not trip downstream secret-scanner hooks. Exact regex sources of truth
live in `src/security/redaction.ts` and `src/security/redaction-pii.ts`.

---

## 1. Privacy Gates — Currently Active

| Gate | Mechanism | Evidence | Risk if regressed |
|------|-----------|----------|-------------------|
| Workdir allowlist | `RELAY_MEMORY_ALLOWED_WORKDIRS` env (colon-sep). `assertWorkdirAllowed()` throws `MEMORY_WORKDIR_FORBIDDEN` on any non-prefix-match. Cross-workdir attempts blocked when var IS set. | `src/memory/memory-store.ts:48-59`, `src/cli/resolve-memory-workdir.ts`, `src/cli/cmd-doctor.ts:175,394-401` | **HIGH** — cross-project memory leak |
| Pause sentinel | `~/.relay/paused` (global) or `<workdir>/.relay/paused` (scoped). `isPaused()` returns true when sentinel present; `--check` exits 0 silently. Hooks gate on this. | `src/cli/cmd-pause.ts:22,41-68,98-139` | **HIGH** — privacy off-switch bypass |
| `.relayignore` project opt-out | `relay project disable` writes `<workdir>/.relayignore`. `isProjectOptedOut()` runs BEFORE consent load so an enabled `auto-extract.json` cannot override. | `src/cli/cmd-project.ts:32,72-89`, `src/cli/cmd-memory-auto-extract.ts:223-241,798-815` | **HIGH** — extraction continues against user wishes |
| PII redaction (memory writes) | `redactSecrets()` applied via `sanitizeContent()` on every `MemoryStore.insert/upsert`. Pattern set covers: AWS access keys, Bearer tokens, OpenAI-family keys, GitHub PATs, Slack tokens, generic api_key/token assignments, env-style SECRET/TOKEN/PASSWORD/PWD/CREDENTIAL assignments, PEM private key blocks. | `src/security/redaction.ts:7-46`, `src/memory/memory-store.ts:42-46,291,397` | **CATASTROPHIC** — secrets in DB → recall → LLM payload |
| PII redaction (extraction) | `redactSecretsAndPII()` applied to transcript BEFORE any LLM POST in auto-extract. Adds JWT, GitHub fine-grained PATs, Stripe-format keys, GCP service-account private_key JSON, DB connection URLs, emails, RFC1918 IPs, internal LAN hostnames, env-style SECRET/TOKEN assignments. User consent patterns compiled in try/catch — bad regex skipped, never crashes pipeline. All user matches collapse to a uniform `USER_PATTERN` marker (per-pattern replacement intentionally ignored to prevent smuggling). | `src/security/redaction-pii.ts:35-125`, `src/cli/cmd-memory-auto-extract.ts:340-349` | **CATASTROPHIC** — transcript secrets to LM Studio |
| Berry hallucination gate | `RELAY_BERRY_CMD` env. When set, each extracted lesson piped on stdin to spawned subprocess. Exit 0 = pass, non-zero = flagged. `RELAY_AUTO_EXTRACT_REQUIRE_BERRY=1` treats `unavailable` as failure. | `src/memory/auto-extract-berry.ts:66-132`, `src/cli/cmd-memory-auto-extract.ts:14-15,495` | **MEDIUM** — opt-in gate; absence is documented |
| Per-workdir consent file | `<workdir>/.relay/auto-extract.json` required for auto-extract. No file → `skipped:no-consent` exit 0. Zod-validated; consent.enabled=false short-circuits. | `src/memory/auto-extract-consent.ts:52-118`, `src/cli/cmd-memory-auto-extract.ts:243-269` | **CATASTROPHIC** — extraction without explicit opt-in |
| Endpoint locality gate | Default DENY for non-localhost LM Studio endpoints unless `consent.allow_remote=true`. `LOCALHOST_HOSTS = {127.0.0.1, ::1, localhost}`. Status: `error:remote-llm-blocked`. | `src/cli/cmd-memory-auto-extract.ts:159-161,353-376` | **CATASTROPHIC** — transcripts to remote LLM |
| Private-tag block stripping | The user-private-block regex (`PRIVATE_TAG_RE`) stripped before redaction in `sanitizeContent`. | `src/memory/memory-store.ts:42-46` | **HIGH** — user-marked content leaks to DB |
| MAX_CONTENT_LENGTH cap | Memory content truncated post-redaction. | `src/memory/memory-store.ts:42-46` | **LOW** — DoS prevention |
| Cross-workdir conflict scope | Conflict detection scoped to single workdir per CC.3 / SC4 in roadmap. | Pending Phase 5 — **NOT YET IMPLEMENTED** | **HIGH (future)** |

---

## 2. Secret Loading Patterns

**Current state of `~/.relay/secrets`:** file (`-rw-------`, 4541 bytes, owner `ghanavati`).
This is a FILE not a DIRECTORY — Phase 7 spec wants a `~/.relay/secrets/figma.json`
SUBPATH under a DIRECTORY. Phase 7 plan needs to either rename the current file or
treat the existing path as legacy. Document as `OPEN_SCHEMA_CONFLICT` for Phase 7.

| Secret class | Storage | chmod | Code path | Status |
|--------------|---------|-------|-----------|--------|
| Anthropic / OpenAI / Codex API keys | `process.env` only (`getAnthropicApiKey()` etc.) | n/a (env) | `src/workers/anthropic.ts:39`, `src/config/providers.ts` | **OK** (no on-disk persistence) |
| Relay DB | `~/.relay/relay.db` | **0o600** via `chmodSync` after `new Database()` | `src/runtime/store/db.ts:177-178` | **OK** (best-effort try/catch — acceptable for local CLI) |
| Codex temp instruction files | `tmpdir()/relay-codex-instructions-*.md` | **0o600** via writeFileSync mode | `src/workers/codex.ts:42-58` | **OK** |
| LM Studio wrapper script | `~/.relay/...wrapper` | **0o755** (executable) | `src/cli/cmd-setup-llm.ts:228` | **OK** (no secret content) |
| Figma PAT (Phase 7) | `~/.relay/secrets/figma.json` w/ chmod 600 | Planned | `.planning/phases/07-figma-rest-tools/PLAN.md:155,368` | **PENDING** (Phase 7) |

**Gap:** No central `secrets/` directory scanner / loader exists today.
Phase 7 introduces `loadPat()` — first time Relay reads JSON from `~/.relay/secrets/`.
Audit Phase 7 for: (a) chmod-600 enforcement on WRITE, (b) chmod-600 verification on READ
(refuse to load if perms are too permissive), (c) symlink-resolution guard.

---

## 3. Hook Exit-0 Discipline

Every hook entry path MUST return exit 0 even on internal failure — see `PITFALLS.md` CC.2.

| Hook entrypoint | Top-level try/catch? | Exit-0 on uncaught? | Evidence |
|-----------------|----------------------|---------------------|----------|
| `cmd-memory-auto-extract.ts` (SessionEnd) | YES | YES — `error:uncaught` audit + `return 0` | `:163-202` (try { return await runPipeline... } catch { ... return 0; }) |
| `cmd-memory-ops.ts` (PostToolUse remember/recall) | Partial — `executeRememberCommand` returns numeric exit per `response.isError`; ENOENT swallow at `:268-272` | Implicit — no top-level wrap; relies on caller in `cli.ts` | `:7-90,260-280` |
| Hook caller (`cli.ts` dispatch) | Catches via process.exit at top level — but **not surveyed in this baseline** | unknown | TODO Phase 3-7 audit |

**Posture:** `cmd-memory-auto-extract.ts` is the gold pattern (explicit catch + audit + exit 0).
`cmd-memory-ops.ts` relies on no-throw guarantee from `handleRemember/handleRecall`.

**Phase 3-7 net-new hook risk:** any new hook (e.g., embedding background micro-task in Phase 4,
delta-extraction in Phase 6) MUST replicate the `cmd-memory-auto-extract.ts:163-202` pattern.
Verify each: file body wrapped in `try { ... } catch { audit; return 0; }`.

---

## 4. SQL Injection Surface

**Method:** all DB access via `better-sqlite3` `db.prepare(sql).run(...)` / `.get(...)` / `.all(...)` — parameterized.

| Risk pattern | Grep finding | Disposition |
|--------------|--------------|-------------|
| String concat in SQL (e.g. `'WHERE ' + x`) | NONE found in src/ excluding tests | OK |
| Template literal interpolation in SQL | NONE found in production code paths | OK |
| `db.exec()` with dynamic input | `src/runtime/budget/db-migrations.ts:106-114` uses table names interpolated into DDL — but `table` is a hard-coded constant from a fixed allow-list within the migrator. **NOT** user-controlled. | OK with caveat |
| LIKE wildcard injection | `escapeLikeWildcards()` applied to tag + path LIKE queries. | OK |
| `db.exec()` in fixtures | `src/memory/__fixtures__/_generate-v0.1.2.mjs:56,314` — dev tool only, not shipped | OK |

**Phase 3-7 risk:** Phase 5 (Conflict Detection) and Phase 6 (Delta Extraction) add new
queries. Per `PITFALLS.md` CC.3 / CC.4: all `FROM memories` queries MUST route through
`MemoryStore` methods to inherit `assertWorkdirAllowed()`. Grep-CI rule recommended for Phase 5+.

---

## 5. Shell Injection Surface

| Site | Mechanism | Risk |
|------|-----------|------|
| `src/context/layers.ts:87` | `execFileAsync("git", ["rev-parse", "--show-toplevel"])` — argv array, no shell | **LOW** (well-formed) |
| `src/context/brief-layer.ts:12` | same pattern | **LOW** |
| `src/workers/codex.ts:27` | `execFile` via promisify — argv array | **LOW** |
| `src/memory/auto-extract-berry.ts:93` | `spawner(cmd, { shell: true })` where `cmd = process.env.RELAY_BERRY_CMD` | **MEDIUM** — env-var is user-controlled; user explicitly opted in by setting it. Documented in `auto-extract-berry.ts:17-26`. Acceptable for local CLI (user IS the principal), but DO NOT pipe untrusted input as command args. |
| `src/cli/cmd-memory-auto-extract.ts:36` | `execFile` for `lms ps --json` — argv array | **LOW** |

**No `execSync` / `exec(string)` / `spawn(cmd, shell:true)` found with user-controlled input in production code paths.**

**Phase 3-7 risk:** Phase 3 introduces `shell_exec` tool with `/bin/sh -c <command>` — by design.
Mitigations declared in `.planning/v0.2-improvised-scrap/PLAN-2-agentic-runner.md:147-155,214`:
(a) `cwd = path.resolve(task.workdir, cwd_relative)` with prefix-check clamp,
(b) bounded timeout,
(c) 32KB stdout truncation,
(d) command STRING itself is treated as opaque (intentional — model is the agent).
Phase 3 audit MUST verify (a) prefix-check correctness against `..` / symlinks,
(b) `path.resolve` followed by `startsWith(task.workdir + sep)` not just `startsWith(workdir)`.

---

## 6. Path-Traversal Surface

| Surface | Validation | Evidence |
|---------|------------|----------|
| Memory workdir | `assertWorkdirAllowed()` → `allowedList.some(p => workdir === p || workdir.startsWith(p + '/'))` | `src/memory/memory-store.ts:48-59` |
| Consent file path | `join(workdir, '.relay/auto-extract.json')` — workdir from validated hook payload | `src/memory/auto-extract-consent.ts:52` |
| `.relayignore` check | `join(workdir, '.relayignore')` — same | `src/cli/cmd-memory-auto-extract.ts:812` |
| Pause sentinel | `join(workdir, '.relay/paused')` — same | `src/cli/cmd-pause.ts:41-68` |
| DB path | `process.env.RELAY_DB_PATH` or `~/.relay/relay.db` — user-controlled env, intentional override | `src/runtime/store/db.ts:160-178` |
| Log path | `process.env.RELAY_HOME` or `~/.relay` — same | `src/runtime/relay-log.ts:74-79` |
| Codex tempfile | `tmpdir() + sanitized run_id` — `[^a-zA-Z0-9_-]` stripped from run_id | `src/workers/codex.ts:55` |

**Symlink resolution:** NO `realpath()` / `lstat()` checks on consent-file / `.relayignore` /
pause sentinel paths. Attacker with write-access to workdir could symlink these to
arbitrary files. **MEDIUM** — local-CLI threat model assumes workdir is trusted by user,
but a shared CI runner workdir is not. Document as **accepted risk** for v0.2; revisit if
remote-execution mode lands.

**Phase 3-7 risk:** Phase 3 `shell_exec` cwd clamp MUST use `realpath` semantics not just
string-prefix to defeat `<workdir>/symlink-to-/etc` escapes. Phase 7 `loadPat` MUST stat the
secrets file and refuse if `(mode & 0o077) !== 0` OR if `lstat.isSymbolicLink()`.

---

## 7. PII / Secret Patterns — Currently Applied

`REDACTION_PATTERNS` (`src/security/redaction.ts:7-46`) — applied to **every memory write**:

1. AWS access-key IDs (AKIA-prefixed, 16 trailing alnum)
2. Bearer tokens
3. OpenAI-family keys (regex matches the standard sk-prefix family, including Anthropic-style and project-style variants — see `redaction.ts:11-14` for the exact alternation)
4. GitHub PATs (legacy ghp_ prefix + 36 alnum)
5. Slack tokens (xox-prefixed family)
6. Generic api_key / token assignments
7. Env-style assignment with KEY|SECRET|TOKEN|PASSWORD|PWD|CREDENTIAL keyword (preserves identifier, redacts value)
8. PEM private key blocks

`PII_PATTERNS` (`src/security/redaction-pii.ts:35-82`) — applied **only in auto-extract** transcript redaction:

9. JWT (3-part dotted base64url)
10. GitHub fine-grained PAT (github_pat_-prefixed, 82 alnum)
11. Stripe-format keys (test / live / restricted / public — exact pattern in `redaction-pii.ts:48`)
12. GCP service-account private_key JSON field
13. DB connection URLs (postgres / mysql / mongodb / redis with creds)
14. Email addresses
15. RFC1918 private IPs (10/8, 192.168/16, 172.16-31/12)
16. Internal LAN hostnames (.lan / .local / .internal / .corp / .intra)
17. Env-style SECRET / TOKEN / PASSWORD / API_KEY / PRIVATE_KEY / ACCESS_KEY / CLIENT_SECRET assignments

**Gap by inspection:** No pattern for:

- Anthropic API keys explicitly named — matched by the OpenAI-family regex (sk-prefix family), per `redaction.ts:11-14`.
- Figma PAT (figd_-prefix) — **NOT YET IN PATTERN SET**. Phase 7 MUST add a `figma_pat` entry matching the figd_-prefix format to BOTH `REDACTION_PATTERNS` and `PII_PATTERNS`. **Add to Phase 7 PLAN if not already there.**
- Figma-Token header in HTTP logs — Phase 7 needs request-log scrubber (`PLAN.md:162,186` plans `scrubHeaders()`).

---

## 8. Sandbox Limits on External Commands

| Subprocess | Sandbox | Evidence |
|------------|---------|----------|
| `git rev-parse` | argv array, fixed args | `src/context/layers.ts:87` |
| `codex` (Phase < v0.2 legacy) | argv array, instruction file at chmod-600 tempfile, env scrubbed via `envAdditions` whitelist | `src/workers/codex.ts:42-58,280-326` |
| `lms ps --json` | argv array | `src/cli/cmd-memory-auto-extract.ts:36` |
| Berry verifier | **shell:true** — user opt-in via env | `src/memory/auto-extract-berry.ts:93` |
| Phase 3 `shell_exec` (future) | **PLANNED** cwd clamp + timeout + 32KB output cap | `.planning/v0.2-improvised-scrap/PLAN-2-agentic-runner.md:147-155,360-361` |

**No use of `vm`, `eval`, or `Function(string)` in src/.**

**Phase 3 risk (PLANNED): `shell_exec` is by design a model-driven shell.**
Required audit checks once implemented:

- Timeout enforced (recommend ≤ 30s default) — kill with SIGKILL on timeout
- Output capped at 32KB (truncation marker)
- cwd ALWAYS resolved via `path.resolve(task.workdir, cwd_relative)`, then verified `resolved.startsWith(task.workdir + path.sep) || resolved === task.workdir`
- env scrubbed — NEVER inherit `FIGMA_API_TOKEN`, `ANTHROPIC_API_KEY` etc. into spawned shell — Phase 3 explicit allow-list
- stdin closed (no interactive prompt block)
- No `RELAY_*` env var pass-through (defense in depth)

---

## 9. Threat Surface Added by Phases 3-7

| Phase | New attack surface | Catastrophic? | Required new mitigation |
|-------|-------------------|---------------|-------------------------|
| **Phase 3 — Agentic LM Studio Runner** | (a) `shell_exec` tool: model executes arbitrary shell commands in workdir. (b) Loop-detection bypass (hash collisions). (c) Tool-result poisoning: malicious file contents echoed back to model. | **CATASTROPHIC** | cwd clamp via `path.resolve` + `startsWith(workdir+sep)`. Output truncation 32KB. Iteration cap 20. Loop hash on (name + sortedKeys(args)). Env-var allow-list for spawned shell. |
| **Phase 4 — Embeddings Wire-Up** | (a) LM Studio embedding endpoint POST exposes query text. (b) Embedding-blob storage adds 3072 bytes/row → DB grows faster, GC pressure. (c) Cosine similarity over a public model: low novelty risk. | HIGH | Same endpoint-locality gate as auto-extract MUST cover embedding endpoint. Query-text already inside `assertWorkdirAllowed` scope. |
| **Phase 5 — Conflict Detection** | (a) New `conflicts_with_json` column read in `memory why`. (b) Pairwise loop O(K²) — K=32 cap stated in SC5. (c) Cross-workdir conflict-leak risk per CC.3. | HIGH | Cap K at 32. Single-workdir scope assertion in conflict SQL. Test: write in A, query in B, assert zero conflicts. |
| **Phase 6 — Delta Extraction** | (a) `getCandidates(workdir, 50, 2000)` exposes 50 existing memories to LLM prompt — already redacted at write time, but reread + resent. (b) Prompt injection: stored memory could contain role-tag escape sequences. | HIGH | Existing memories already passed through `redactSecrets` at insert time. Prompt MUST treat memory content as untrusted: wrap in fenced section, do NOT template-inject memory content back into the system prompt. |
| **Phase 7 — Figma REST Tools** | (a) Figma PAT at rest on disk (`~/.relay/secrets/figma.json`). (b) PAT in HTTP request headers. (c) PAT in error messages / logs / debug dumps. (d) `figma_update_token` writes to user designs — destructive. (e) 429 retry could leak token in retry-log. | **CATASTROPHIC** | chmod 600 on write + chmod-check on read. `scrubHeaders()` redacts the Figma token header in ALL log paths. figd_-prefix regex added to `REDACTION_PATTERNS` AND `PII_PATTERNS`. Pre-flight plan check before exposing `figma_update_token` to model. Rate-limit awareness in tool wrapper (NOT model). |

---

## Risk Summary (post-Phase 7 if all mitigations land)

| Severity | Threats remaining | Acceptable? |
|----------|-------------------|-------------|
| CATASTROPHIC | 0 (all mitigated by design — verify in per-phase audits) | YES |
| HIGH | Symlink attacks on consent / sentinel files (deferred — local-CLI trust boundary) | YES — document in v0.2 release notes |
| MEDIUM | Berry `shell:true` (user opt-in); orphan tables migration (Phase 1, already shipped) | YES |
| LOW | Env-var override of `RELAY_HOME` / `RELAY_DB_PATH` (intentional — user can override their own files) | YES |

---

## Recommendations for Phase 3-7 Audits

Each `/gsd-secure-phase` invocation for Phases 3-7 must verify:

1. **Phase 3:** grep `src/workers/lmstudio-agentic.ts` for `path.resolve`, `startsWith`, `setTimeout`, `kill`, output truncation. Test cwd-escape (`cwd_relative: '../../etc'`) returns tool-error, never spawns.
2. **Phase 4:** grep `src/memory/embedding-*.ts` for endpoint-locality gate (same `isLocalEndpoint()` helper or equivalent). Cross-workdir test pattern.
3. **Phase 5:** grep `src/memory/conflict-*.ts` for `WHERE workdir = ?` on every SELECT. Cross-workdir leak test.
4. **Phase 6:** grep `src/cli/cmd-memory-auto-extract.ts` after Phase 6 changes for: (a) getCandidates called, (b) memory content fenced in prompt, (c) no template-injection of memory content back into the system prompt.
5. **Phase 7:** grep `src/tools/figma/` for: (a) `scrubHeaders()` called on every error path, (b) figd_-prefix pattern present in `REDACTION_PATTERNS`, (c) `loadPat()` rejects mode `& 0o077 !== 0`, (d) `figma_update_token` gated behind plan-check.

Delta target for each: zero **CATASTROPHIC** threats unmitigated in implementation.
