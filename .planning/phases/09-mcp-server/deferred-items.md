# Phase 9 — Deferred Items

Out-of-scope discoveries logged during execution. Not fixed by the discovering executor (scope boundary: only auto-fix issues directly caused by the current plan's changes).

## [09-02] Pre-existing: control E2E time-bomb tests expired 2026-06-09T10:23:20Z

**Discovered during:** Plan 09-02 final full-suite verification (2026-06-09 ~19:10 UTC)
**File:** `src/control/control-e2e.test.ts` (Phase 8 artifact — in neither 09-01 nor 09-02 write set)
**Failing tests (2):**
- `LM Studio control-tool send reaches a fake target (with a grant)` — "granted llm send is allowed: false !== true"
- `repeated identical ping-pong is blocked as a loop` — "send 1 allowed: false !== true"

**Root cause (verified, deterministic — 3 identical isolated runs):**
- `control-e2e.test.ts:51` pins `const T0 = 1_781_000_000_000` = 2026-06-09T10:13:20Z (epoch ms).
- Both tests create grants AT `T0` with `ttl_ms: 600_000` → `expires_at` = 2026-06-09T10:23:20Z.
- The send path uses the real clock: `control/tools.ts:354` calls `broker.sendMessage` with no injected time; `broker.ts` `checkGrant(..., now = Date.now())` then `grant.expires_at <= now` → `{allowed:false, reason:'expired'}`.
- Tests were green at Phase 8 merge (2026-06-08) because real time was still before `T0 + 10min`. They detonated permanently at 10:23:20Z on 2026-06-09 and will fail for every run from now on, on every branch containing the Phase 8 test.

**Not caused by 09-02 / 09-01:** `git diff HEAD~1 HEAD -- package-lock.json` outside the `@modelcontextprotocol` tree is 0 lines; `src/control/` untouched by both executors; failure mechanism is pure wall-clock arithmetic.

**Suggested fix (for a follow-up fix plan, NOT this phase's scope):** derive the grant timestamps from `Date.now()` in the two grant-creating tests (or inject `now` through `registerControlTools` → `broker.sendMessage`), so grant validity is relative to test runtime, never a fixed epoch. The other 13 control-e2e tests pass; only the two grant-at-`T0` tests are affected.

**RESOLVED (09-05 housekeeping, 2026-06-10, commit f9e502e):** both grant-creating tests now pass `Date.now()` as the grant creation time — fixture timestamps only, no logic changes. Full suite back to green: 1897/1897.

## [09-01] Confirms the control E2E failures pre-date this plan

**Discovered during:** Plan 09-01 baseline full-suite run (2026-06-09 ~19:12 UTC, BEFORE any 09-01 change).
Baseline: 1819 tests / 1817 pass / 2 fail — the same two grant-expiry tests documented above by 09-02. Final 09-01 state: 1858 tests / 1856 pass / same 2 fail. No change in the failure set across the plan.

## [09-01] cmd-parallel.ts still carries its own closed provider union

**Discovered during:** Plan 09-01 Task 3 (registry swap in the run path).
**File:** `src/cli/cmd-parallel.ts` (`SpecTask.provider` union + `validProviders` + `httpProviders` sets), guarded by a source-grep test in `src/workers/lmstudio-agentic.test.ts` (T7).
**Why deferred:** the plan's must-have kills the closed union in the RUN path only ("cmd-run.ts resolves provider names through the registry"). `relay parallel` is a separate dispatch path, outside files_modified. A follow-up could route cmd-parallel through `resolveProvider` the same way, making env-declared providers usable in parallel specs.

## [09-01] `relay completion` PROVIDERS list is static

**Discovered during:** Plan 09-01 Task 3 read of `src/cli/cmd-completion.ts:38`.
**Detail:** `PROVIDERS = ['codex', 'lmstudio', 'openrouter', 'anthropic']` — already missing `lmstudio-agentic` before this plan; cannot know env-discovered names at completion-script generation time anyway. Tab completion still works for the listed builtins; dynamic provider names simply don't tab-complete. Cosmetic; out of scope.

## [09-oauth] GitHub Codex PR-bot findings on commit 742c289 (ad hoc post-09-05 commits, no plan doc)

**Discovered during:** `@chatgpt-codex-connector[bot]` automated PR review of commit 742c289, surfaced to the maintainer 2026-07-01. Not caused by, or in scope of, the ChatGPT-connector tunnel-durability fix being worked in `.worktrees/mcp-tunnel-durability` — logged here rather than fixed, per explicit maintainer scoping ("only fix what solves the problem we have now").

**1. (P2) `redactEnvelope` can corrupt JSON when redacting inside already-serialized text**
- **File:** `src/mcp/tools-memory.ts` (`redactEnvelope`), pattern lives in `src/security/redaction.ts` (env_assignment rule).
- **Issue:** `redactSecrets` runs over the fully-serialized JSON string. Its `env_assignment` pattern matches `\S+` for the value, which can consume the closing quote/comma of the JSON string it's sitting inside, producing malformed JSON. A memory whose content contains something shaped like `MY_SECRET=...` can make `relay_memory_recall`/`relay_memory_save` return unparsable tool text.
- **Suggested fix:** redact structured fields BEFORE `JSON.stringify`, or make the `env_assignment` pattern JSON-delimiter-safe (stop at an unescaped `"`).

**2. (P2) OAuth HTTP listener isn't closed when post-bind setup throws**
- **File:** `src/mcp/http-transport-oauth.ts`, `startOAuthHttpMcpServer` — `httpServer.listen()` succeeds before `publicUrl`/`issuerUrl` are parsed and before `mcpAuthRouter` validates the issuer.
- **Issue:** a bad `RELAY_MCP_PUBLIC_URL` (e.g. non-HTTPS non-loopback, or unparsable) throws AFTER the socket is already bound. The thrown startup error never closes `httpServer`, so the port stays occupied and the CLI can hang.
- **Relevance flag:** not today's failure (the configured `RELAY_MCP_PUBLIC_URL` was a well-formed https:// tunnel URL), but worth keeping in mind if the tunnel-durability fix auto-restarts relay with a freshly-parsed URL — a malformed URL from a bad restart could hang instead of failing cleanly.
- **Suggested fix:** wrap the post-bind setup in a try/catch that closes `httpServer` before rethrowing, or validate the URL before calling `.listen()`.

**3. (P1) Auto-extract's `disableTools: true` is not enforced for the Codex runner**
- **File:** `src/memory/extract-dispatch.ts` (sets `disableTools: true`) / Codex runner's `buildCodexInvocation` (never reads that field).
- **Issue:** auto-extract is documented as a sandboxed, tool-free transcript→JSON transform. Subprocess runners like `claude` honor `disableTools`; the Codex runner ignores it entirely and still builds a normal `codex exec` invocation with workspace-write/full-auto behavior. If a user configures Codex as their auto-extract backend, the SessionEnd hook can invoke Codex with full file/tool access instead of a constrained transform.
- **Unrelated subsystem:** auto-extract / SessionEnd hook, not the MCP OAuth connector — flagged P1 by the bot but explicitly out of scope for the current fix.
- **Suggested fix:** either make `buildCodexInvocation` honor `disableTools` (real sandboxed invocation) or reject/warn when Codex is selected as the auto-extract extractor until that's implemented.

## [09-oauth] Connector durability — OAuth state persistence + named tunnel (maintainer-authorized 2026-07-02)

**Decision:** maintainer approved fixing the two connector-breaking restart behaviors ("1+2 are ok, keep 3" — manual start stays, no launchd). Logged here because the remote/OAuth lane still has no plan doc — the D-06 pull-forward amendment remains outstanding.

- **DONE — OAuth state persistence:** every server restart wiped the in-memory client registrations, so ChatGPT came back to "Invalid client_id" and the connector had to be removed and re-added. Registered clients and token hashes now persist to `~/.relay/mcp-oauth-state.json` (owner-only 0600, atomic tmp+rename; corrupt file degrades to empty and self-heals; one-time auth codes stay memory-only). Pinned by `src/mcp/oauth-provider-persist.test.ts`.
- **PENDING — stable tunnel hostname:** `scripts/mcp-tunnel-supervisor.sh` rewritten for the named Cloudflare tunnel `relay` at `relay.ghanavati.dk`, so the connector URL stops changing on restart. Blocked on a maintainer domain decision: ghanavati.dk's nameservers are at one.com (live site + one.com mailpods), so the zone must move to Cloudflare — or a different Cloudflare-hosted domain must be picked — before `cloudflared tunnel create relay` can run. The script self-guards: it prints the one-time setup commands and exits until the tunnel exists.
