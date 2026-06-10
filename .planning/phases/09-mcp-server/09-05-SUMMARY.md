---
phase: 09-mcp-server
plan: 05
subsystem: mcp
tags: [mcp, integration-test, in-memory-transport, sdk-client, docs, security-posture, time-bomb-fix]

# Dependency graph
requires:
  - phase: 09-02
    provides: "SDK 1.29.0 pin + verified surface table (Client at client/index.js, InMemoryTransport.createLinkedPair at inMemory.js)"
  - phase: 09-03
    provides: "buildMemoryMcpTools — the exact two-tool surface the wire tests enumerate"
  - phase: 09-04
    provides: "startMcpServer({version, transport}) with injectable transport + handle.closed-on-disconnect contract"
provides:
  - "src/mcp/server.integration.test.ts — real SDK Client ↔ real startMcpServer over the linked in-memory pair: enumeration, save→recall round-trip, workdir gate over the wire"
  - "docs/mcp.md — the relay mcp reference: .mcp.json recipe, the two tools, reach, security posture"
  - "relay mcp coverage in docs/commands.md, README, CHANGELOG, SECURITY.md"
  - "control-e2e grant fixtures defused (runtime-relative timestamps) — full suite green again"
affects: [phase-completion, MCP-05-final-gate]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Integration tests import Client/InMemoryTransport directly from the SDK subpaths verified in 09-02 (resolveMcpSdk gates production code, not test drivers)"
    - "Linked-pair teardown contract asserted: client.close() must resolve handle.closed (raced against a timeout so a regression fails instead of hanging)"
    - "Test fixtures with expiry semantics must be runtime-relative (Date.now()), never a pinned epoch"

key-files:
  created:
    - src/mcp/server.integration.test.ts
    - docs/mcp.md
  modified:
    - docs/commands.md
    - README.md
    - CHANGELOG.md
    - SECURITY.md
    - src/control/control-e2e.test.ts
    - .planning/phases/09-mcp-server/deferred-items.md

key-decisions:
  - "In-memory linked-pair approach used (NOT the child-process stdio fallback) — InMemoryTransport.createLinkedPair() verified available in the installed SDK per 09-02"
  - "docs/mcp.md instead of the plan's docs/sessions/mcp.md — docs/sessions/ is gitignored transcript storage; the planned path was uncommittable (Rule 1 auto-fix)"
  - "CHANGELOG stale 'v0.4.0: skill packs...' planned line reconciled with the rescope so the new v0.4 Added entry doesn't contradict the adjacent roadmap note"

requirements-completed: [MCP-01, MCP-02]
# MCP-05's final criterion (live client round-trip) is the pending human gate below.

# Metrics
duration: ~25min
completed: 2026-06-10
---

# Phase 9 Plan 05: MCP Integration Test + Docs Summary

**Real SDK Client driving the real startMcpServer over InMemoryTransport.createLinkedPair — enumeration, round-trip, and the workdir gate proven over the actual protocol — plus the full relay mcp doc set and the control-e2e time-bomb fix; suite 1897/1897, live MCP-05 gate pending the maintainer**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-06-10T12:16:42Z
- **Completed:** 2026-06-10T12:42:00Z
- **Tasks:** 2/2 auto + housekeeping fix; Task 3 (checkpoint:human-verify) set up, NOT self-approved
- **Files modified:** 8 (2 created, 6 modified)

## Integration approach (recorded per plan output spec)

**In-memory linked pair — not the child-process fallback.** `InMemoryTransport.createLinkedPair()` and `Client` were verified shipped in the installed `@modelcontextprotocol/sdk@1.29.0` (09-02 surface table; re-probed live before writing the test). One end goes to `startMcpServer({ version, transport })`, the other to an SDK `Client` — both real protocol objects, no mocks on either side.

Three tests in `src/mcp/server.integration.test.ts`:

1. **Enumeration (MCP-01):** `tools/list` over the wire returns exactly `[relay_memory_recall, relay_memory_save]` (sorted deepStrictEqual — nothing extra can hide), each with a description and a converted JSON-schema `inputSchema`. Also pins the 09-04 teardown contract: `client.close()` resolves `handle.closed` (raced against a 2s timeout so a regression fails loudly instead of hanging the runner).
2. **Round-trip (MCP-02):** `relay_memory_save` then `relay_memory_recall` through the client; the saved memory comes back over the wire. The row is also read back via the shared `getDb()` connection with `memory_source='worker-mcp'` — same store, MCP provenance pinned.
3. **Scoping over the wire (MCP-02):** with `RELAY_MEMORY_ALLOWED_WORKDIRS` excluding the requested workdir, recall returns `isError` with code `MEMORY_WORKDIR_FORBIDDEN` and the seeded canary content does not cross.

Note on TDD shape: the implementation pre-exists (09-04), so there was no RED phase against missing functionality — the deliverable IS the test. Failure sensitivity comes from exactness assertions (exact name set, exact error code, content-presence checks). All 3 pass: `node --test dist/mcp/server.integration.test.js` → 3/3.

## Bonus evidence: live stdio smoke (real StdioServerTransport path)

The integration test exercises the in-memory transport; the real stdio path was smoked directly: piping framed `initialize` → `notifications/initialized` → `tools/list` into `node dist/cli.js mcp` produced **only protocol JSON on stdout** (serverInfo `{name:"relay", version:"0.1.2"}`, then the two tools with full schemas), **only the startup notice on stderr**, and a clean exit 0 on stdin EOF. Stdout discipline holds on the real wire.

## Docs shipped (Task 2)

- **docs/mcp.md** — what `relay mcp` is; the exact `.mcp.json` block (`command: "relay"`, `args: ["mcp"]`, `env.RELAY_MEMORY_ALLOWED_WORKDIRS` colon-separated allowlist note); Claude Desktop config pointer; the two tools with one-line descriptions; reach notes (stdio = any MCP client app: Claude Desktop/Code, Cursor, Codex, Windsurf + harnesses like Conductor; ChatGPT/web = deferred v2 remote + OAuth); plain security posture (scoping, boundary redaction, stderr-only logs, stdio trusts the OS user, no dispatch/shell/control). Cites `@modelcontextprotocol/sdk@1.29.0` exact-pinned.
- **docs/commands.md** — `## relay mcp` section in the house heading style, both tool names, inline example `.mcp.json` one-liner.
- **README.md** — one Documentation-list pointer to docs/mcp.md, existing voice, no banned words.
- **CHANGELOG.md** — `### Added — MCP memory server (Phase 9, v0.4 lean core)` under Unreleased.
- **SECURITY.md** — `## MCP server (relay mcp)` subsection: stdio inherits the OS-user trust boundary (a local process piping into `relay mcp` stdin acts as the user), scoping, boundary redaction as a second layer over redact-on-save, stdout discipline, dispatch/control structurally absent, remote transports + auth out of scope until v2.

## Housekeeping: control-e2e time bombs defused

`src/control/control-e2e.test.ts` pinned grant creation to absolute epoch `T0 = 1_781_000_000_000` (2026-06-09T10:13:20Z) with `ttl_ms: 600_000`, while `broker.checkGrant` compares against real `Date.now()` — both grants expired permanently at 10:23:20Z on 2026-06-09 (full forensics in deferred-items.md, 09-02 entry, now marked RESOLVED). Fix: the two grant-creating tests pass `Date.now()` as creation time (fixture timestamps only; session registrations keep `T0`; zero logic changes). control-e2e: 15/15.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Plan's doc path `docs/sessions/mcp.md` is inside a gitignored directory**
- **Found during:** Task 2 commit (`git add` refused: `.gitignore:13 docs/sessions/`)
- **Issue:** `docs/sessions/` is local session-transcript storage, deliberately untracked. The canonical user-facing doc placed there could never be committed, failing the plan's own must-have ("a user can find the .mcp.json registration entry … from the docs") — and force-adding gitignored content is prohibited.
- **Fix:** doc relocated to `docs/mcp.md` (next to memory.md/providers.md); all four cross-references (commands.md, README, CHANGELOG, SECURITY.md) point there. Plan's verify gate re-run against the corrected path: PASS.
- **Files modified:** docs/mcp.md + the four referrers
- **Commit:** 28fc3a6

**2. [Rule 2 - Docs coherence] CHANGELOG planned-roadmap line contradicted the new entry**
- **Found during:** Task 2 (CHANGELOG edit)
- **Issue:** the Unreleased "Beyond v0.2 (planned)" block still said `v0.4.0: skill packs (slim), relay run --pipe, …` — directly contradicting the new `Added — … (Phase 9, v0.4 lean core)` section three lines above it (the v0.4 rescope killed that list).
- **Fix:** one line reworded to `later: skill packs … (v0.4.0 was rescoped to the lean core shipped above — see .planning/RELAY-V04-SCOPE.md)`. The v0.3.0 planned line (also partly stale re cost rollups) was left alone — it doesn't collide with this plan's entry; roadmap pruning belongs to the maintainer.
- **Files modified:** CHANGELOG.md
- **Commit:** 28fc3a6

### Out-of-scope observation (not fixed)

09-01 shipped `relay providers` + dynamic dispatch with no CHANGELOG entry of its own; this plan's CHANGELOG addition covers only the MCP server per its scope. A one-bullet dispatch entry under the same Phase 9 heading would complete the picture — left to the maintainer/phase close.

## Test Count vs Baseline

- Baseline (post-09-04, per orchestrator): **1894 tests / 1892 pass / 2 fail** (the time bombs)
- Final: **1897 tests / 1897 pass / 0 fail** — delta +3 = this plan's integration tests; the 2 pre-existing failures fixed by the housekeeping task. First fully-green full suite since the bombs detonated.
- Targeted: `dist/mcp/server.integration.test.js` 3/3; `dist/control/control-e2e.test.js` 15/15.

## CLI surface: additive-only confirmation

`git diff main..HEAD -- src/cli.ts` → **+21/−5**. All 5 removals are 09-01's planned closed-union kill in the run dispatcher (its must-have; same numbers the orchestrator verified in 09-04). The mcp + providers contributions are purely additive: two help sections + two lazy dispatch branches. `relay --help` retains every prior section (USAGE, MEMORY, CONTEXT, DELEGATION, SESSION, PROJECT, SETUP, EXPORT, PRIVACY, GENERAL, DOCS) plus MCP SERVER.

## MCP-05 final gate: status = pending-human

All four automated gates PASS (full results in the checkpoint message returned to the orchestrator):

| Gate | Result |
|---|---|
| `npm run build && npm test` | 1897/1897 green |
| `git diff main..HEAD -- src/cli.ts` additive-only | PASS (+21/−5; removals = 09-01's planned union kill) |
| `relay --help` contains mcp + providers, prior sections intact | PASS |
| `relay providers` key-safety (synthetic `RELAY_PROVIDER_DEMO_URL`/`_KEY`) | PASS — demo listed as `env`-source, key column shows the env-var name + (set), never a value |
| (extra) live stdio smoke: initialize + tools/list into `relay mcp` | PASS — protocol-only stdout, stderr-only diagnostics, clean exit 0 |

**Pending (human, NOT self-approved):** live round-trip from a real MCP client — enumerate the two tools, save→recall through the shared store, confirm via `relay memory recall` from the CLI, no stdout corruption. Resume signal: "approved" or a failure description.

## Task Commits

1. **Task 1: MCP integration test** — `79f5490` (test)
2. **Task 2: relay mcp doc set** — `28fc3a6` (docs)
3. **Housekeeping: time-bomb fixture fix** — `f9e502e` (fix)

## Known Stubs

None — no placeholder values, no TODO/FIXME, no unwired surfaces in the shipped files.

## Threat Model Outcomes

- **T-09-15 (docs under-specifying workdir scoping):** mitigated — docs/mcp.md shows the scoping env in the registration block and explains the posture; integration Test 3 proves the gate holds over the wire.
- **T-09-16 (regression/CLI drift):** mitigated — full suite green + additive-only diff verified above; human gate re-confirms live.

No new threat surface introduced (test + docs + test-fixture fix only).

## Next Phase Readiness

- Phase 9 code + docs complete; the only open item is the human MCP-05 live gate.
- STATE.md / ROADMAP.md / REQUIREMENTS.md deliberately untouched per orchestrator instruction — requirement check-offs (MCP-01/02, and MCP-05 after the gate) belong to the orchestrator.

## Self-Check: PASSED

- `src/mcp/server.integration.test.ts` — FOUND
- `docs/mcp.md` — FOUND
- Commits `79f5490`, `28fc3a6`, `f9e502e` — FOUND in git log
- Plan Task 2 verify gate (relocated path): PASS
- Full suite re-confirmed at completion: 1897/1897

## Review fixes (Codex round 1)

Six Codex code-review findings fixed on `phase-9-v04`, one atomic commit per finding, TDD (failing test first) for each behavior change. Suite went 1897 → 1915, all green.

| # | Severity | Finding | Fix | Commit |
|---|----------|---------|-----|--------|
| 1 | HIGH | `relay providers` printed `p.url` raw (table + `--json`) — userinfo / secret-named query params leaked despite key-column masking | `redactDisplayUrl` in `cmd-providers.ts`: targeted scrub of secret-named query params + `redactSecrets` (userinfo via `dsn_credentials`). Display-only | `9f9545a` |
| 2 | HIGH | `generic-http-runner.ts` returned provider error bodies raw as `output` and embedded raw in `error.message` — echoed auth headers leaked into CLI output and persisted via run-record `error_message` | `redactSecrets` on non-OK bodies, missing-text-block raw bodies, and fetch-failure messages (default + custom). Same pattern also fixed in `anthropic.ts` (same-pattern sweep). Success-path output stays byte-identical (pinned by test) | `f0ec0b9` |
| 3 | MEDIUM | `cmd-parallel.ts` `store.complete()` passed only `token_usage`, dropping `prompt_tokens`/`completion_tokens` of the uniform receipt (DISPATCH-04) | Both fields added; parallel run rows now match cmd-run's receipt | `3b90ff0` |
| 4 | MEDIUM | MCP `relay_memory_save` reused the full remember schema — clients could set `pinned:true` (score boost + GC/conflict protection) and spoof `source_run_id`, amplifying memory poisoning | Save schema derived via `RememberArgsSchema.omit({pinned, source_run_id})` (single-source kept by reference) + handler field whitelist forcing `pinned:false`. Verified against real SDK 1.29.0. `docs/mcp.md` posture updated | `b0921f9` |
| 5 | LOW | `listProviders()` silently filtered env providers colliding with builtin names while `resolveProvider` throws `PROVIDER_NAME_CONFLICT` — inconsistent | Colliding env definitions listed as own row with `conflict:true`; `relay providers` renders a red CONFLICT row (exit stays 0); resolve still throws | `b626921` |
| 6 | LOW | `mcp/server.ts` `shutdown()` swallowed ALL `server.close()` errors | Only the SDK 1.29.0 already-closed signal (`Error('Not connected')`) is swallowed; real failures reject `shutdown()` (`closed` still resolves), `cmd-mcp` prints to stderr and exits 1 | `564b729` |

Verification: `npm run build && npm test` → 1915/1915 green. Live smoke: `relay providers` with a synthetic credentialed `RELAY_PROVIDER_DEMO_URL` shows `[REDACTED:DSN]@` + redacted query param in table and `--json`; builtin-name collision renders the CONFLICT row with exit 0.

## Review fixes (Codex round 2)

Two Codex round-2 findings fixed on `phase-9-v04`, one atomic commit per fix, TDD (failing test first) for both. Suite went 1915 → 1935, all green.

| # | Severity | Finding | Fix | Commit |
|---|----------|---------|-----|--------|
| 1 | HIGH (residual) | Worker error paths redacted provider error bodies with pattern matching only (`redactSecrets`) — a provider/proxy echoing request headers leaks secrets whose VALUES match no pattern: arbitrary `RELAY_PROVIDER_<NAME>_HEADER_*` values, short x-api-key strings in JSON echoes like `"x-api-key":"short-secret"` | `scrubKnownValues(text, values)` in `redaction.ts` (≥4-char guard, escaped literal match, longest value first, `[REDACTED:KNOWN]`). Runners scrub the exact values they sent — resolved key + custom header values via `getSensitiveValues` in `runnerFromProviderConfig`, `apiKey` in `AnthropicRunner.post` — BEFORE pattern redaction (a pattern can partially consume a value and leave a fragment) on all four error paths: non-OK bodies, parse-failure raw bodies, fetch-failure messages, `error.message`. Success-path output stays byte-identical (pinned by test) | `418e1ac` |
| 2 | LOW (regression) | `listProviders()` called `envProviderConfig()` unguarded for builtin-colliding names — an invalid `RELAY_PROVIDER_<NAME>_TYPE` threw CONFIG_ERROR and crashed `relay providers` instead of rendering the CONFLICT row | Listing path wraps per-name resolution; on error the entry carries safe fallbacks + an `error` note naming the offending var (conflict flag preserved). `relay providers` renders the row with an appended ERROR note and exits 0; `--json` carries `error` (null on healthy rows). `resolveProvider()` unchanged — still throws PROVIDER_NAME_CONFLICT / CONFIG_ERROR | `46eb66b` |

Verification: `npm run build && npm test` → 1935/1935 green (baseline 1915 + 20 new tests). Live smoke: `RELAY_PROVIDER_LMSTUDIO_URL=http://elsewhere.example:9999 RELAY_PROVIDER_LMSTUDIO_TYPE=bogus relay providers` exits 0 and renders the lmstudio env row with both the CONFLICT and ERROR notes.

---
*Phase: 09-mcp-server*
*Completed: 2026-06-10*
