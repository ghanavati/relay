---
doc_type: security_delta_audit
audit_for: v0.2 Phase 5 (conflict detection) + Phase 7 (Figma REST tools) + Wave A fixes
baseline_refs:
  - ./SECURITY-BASELINE.md
  - ./SECURITY-DELTA-PHASE-3-4.md
audited_at: 2026-05-21
auditor: gsd-security-auditor (read-only inspection of src/, no code changes)
asvs_level: 2
---

# Security Delta — Phase 5 + Phase 7 + Wave A (post-merge to main)

Net-new threat surface vs. the Phase 3+4 delta. Implementation files are READ-ONLY.

---

## Risk Summary

| Severity | Phase 5 | Phase 7 | Wave A regression check | Action |
|----------|---------|---------|-------------------------|--------|
| CATASTROPHIC | 0 | 0 | 0 (3+4 catastrophic gaps both CLOSED) | — |
| HIGH | 0 | 0 | 0 | — |
| MEDIUM | 1 (P5-G1 cosine on `decodeEmbedding` self side is silent NaN guard, on candidate side gate is bypassed when peer blob absent — Jaccard-only verdict; documented contract) | 1 (P7-G1 figma_pat regex permits 1-char "figd_X" partial-leak masquerade — minor sentinel pollution risk in logs) | 0 | DOC; no action |
| LOW | 5 verified mitigations | 8 verified mitigations | 4 REGRESSION-FREE | — |

**Headline:** Wave A fixes for the two Phase 3+4 CATASTROPHIC gaps are present and structurally correct. Phase 5 + 7 introduce no new ship-blocking threats. Audit clears v0.2 ship.

---

## Wave A Confirmations (the two Phase 3+4 CATASTROPHIC gaps)

### W-A1. shell_exec env allow-list — REGRESSION-FREE
- **Site:** `src/workers/lmstudio-agentic.ts:213-221` (`SHELL_EXEC_ENV_ALLOW`), `:224-233` (`buildShellExecEnv`), `:245` (`env: buildShellExecEnv(process.env)` passed to `execFile`)
- **Evidence:** `execFile('/bin/sh', ['-c', args.command], { cwd, timeout, maxBuffer, env: buildShellExecEnv(process.env) })`. Allow-list = `{PATH,HOME,USER,LANG,LC_ALL,TERM,TMPDIR}` plus `RELAY_*` namespace. Everything else (ANTHROPIC_API_KEY, OPENROUTER_API_KEY, LMSTUDIO_API_KEY, GITHUB_TOKEN, **FIGMA_API_TOKEN — including the brand-new Phase 7 secret**) is stripped at process boundary. Phase 7 merge did NOT regress this — no later code path replaces `env:`.
- **Verdict:** CLOSED (Phase 3+4 P3-G1 resolved). Importantly, `FIGMA_API_TOKEN` falls outside the allow-list, so even when registerFigmaTools is active the shell-exec sandbox does NOT inherit the Figma PAT. Defense-in-depth holds.

### W-A2. Embedding endpoint locality gate — REGRESSION-FREE (BOTH sites)
- **Sites:**
  - Write path: `src/memory/memory-store.ts:16` (import), `:319-328` (gate in `scheduleEmbed`)
  - Recall path: `src/memory/semantic-similarities.ts:21` (import), `:137-146` (gate in `computeSemanticSimilarities`)
  - Shared helper: `src/memory/endpoint-locality.ts:17-29`
- **Evidence:** Both call sites import `isLocalEndpoint` from `src/memory/endpoint-locality.ts` (NOT from `cmd-memory-auto-extract`) and short-circuit BEFORE any fetch is issued when the endpoint is non-local. The shared helper is fail-closed: any unparseable URL returns false. `LMSTUDIO_ENDPOINT=https://attacker.example.com` now silently degrades to word-overlap recall + emits one deduped stderr warning per reason.
- **Caveat:** The auto-extract path `src/cli/cmd-memory-auto-extract.ts:826` still defines its OWN copy of `isLocalEndpoint` (functionally identical — same `LOCALHOST_HOSTS` set, same brace-stripping, same fail-closed semantics). Code duplication, not a security defect. Cosmetic cleanup: collapse the auto-extract copy into a re-export from `memory/endpoint-locality.ts`. **NOT a blocker.**
- **Verdict:** CLOSED (Phase 3+4 P4-G1 resolved).

### W-A3. Model capture in scheduleEmbed (no race) — REGRESSION-FREE
- **Site:** `src/memory/memory-store.ts:317` (capture `process.env['RELAY_EMBEDDING_MODEL']` BEFORE `queueMicrotask`)
- **Evidence:** `const model = process.env['RELAY_EMBEDDING_MODEL']; if (!model) return;` happens synchronously in the caller's stack BEFORE the microtask is queued. The captured `model` is closed over by the `.then()` callback at `:337`, which passes it verbatim to `updateEmbedding(memoryId, result.vector, model)`. Even if `RELAY_EMBEDDING_MODEL` mutates between INSERT and microtask drain (impossible during a single tick but defensive), the stored row reflects the model that was active at write time. Cross-model rejection at `semantic-similarities.ts:181` will then correctly match or reject this row.
- **Verdict:** CLOSED (race window structurally eliminated).

### W-A4. Semantic similarities wired into context/layers + cmd-tui — REGRESSION-FREE
- **Sites:** `src/context/layers.ts:219,235`, `src/cli/cmd-tui.ts:86,93`, plus `src/tools/recall.ts:32`, `src/tools/memory_search.ts:41`
- **Evidence:** Every recall surface that calls `budgetedRecall` now precomputes `similarities = await computeSemanticSimilarities(store, query, candidates)` at the impure boundary and passes the ReadonlyMap as the 4th arg. Engine purity invariant (memory-engine.ts imports only ./types) preserved.
- **Verdict:** CLOSED. Note: when `query.query` is empty (cmd-tui top-N recall with no query string), the helper short-circuits at `semantic-similarities.ts:131-132` and returns an empty Map — zero embed calls, zero PII risk. Locality gate is still applied even on empty-query paths (gate runs after the empty-query short-circuit, which is fine: no query → no embed → no exfil).

---

## Phase 5 — Conflict Detection

### P5-1. Cross-workdir conflict-detection leak — VERIFIED MITIGATED
- **Site:** `src/memory/memory-store.ts:525` (`workdirClause = workdir === null ? 'workdir IS NULL' : 'workdir = ?'`), `:549` (used in detection SQL)
- **Evidence:** Strict equality. Null-workdir rows match only other null-workdir rows; named-workdir rows match only exact-string `workdir = ?` peers. There is NO `workdir IS NULL OR workdir = ?` branch in `detectAndPersistConflicts` — that pattern appears elsewhere in memory-store (`:903,931,955,1072`) at READ paths where global+scoped merging is intended, but is correctly absent here. CONFLICT-05 / SC#4 satisfied. A workdir-`/foo` write cannot create conflicts against `/bar` rows nor against global (NULL) rows.
- **Verdict:** CLOSED.

### P5-2. Reciprocal UPDATE transactional consistency — VERIFIED MITIGATED
- **Sites:** `src/memory/memory-store.ts:705-746` (`rememberTx = db.transaction(...)` wraps INSERT + detect+UPDATE), `:818-867` (`upsertTx` does the same)
- **Evidence:** Both write paths wrap the INSERT and the `detectAndPersistConflicts` call (which issues `UPDATE memories SET conflicts_with_json = ? WHERE memory_id = ?` for each peer at `:623,630`) inside a single `db.transaction(() => ...)`. better-sqlite3's `transaction()` wrapper uses `SAVEPOINT` internally; ANY thrown error inside the closure rolls back EVERY statement atomically. No orphaned peer references can accumulate even if the loop body throws mid-iteration. PITFALL 3.2 satisfied.
- **Caveat (LOW):** `updateStmt.run(...)` could in principle hit a SQLITE_BUSY on a heavily-contended DB; that throws and rolls back the whole INSERT. The new row never exists, so no stale forward pointers — correct fail-closed behavior.
- **Verdict:** CLOSED.

### P5-3. K=32 cap bypass / DOS via O(K²) at recall — VERIFIED MITIGATED
- **Site:** `src/memory/conflict-detection.ts:143-145` (`cap = Math.min(memories.length, RECALL_K_CAP)`), `src/memory/conflict-thresholds.ts:63` (`RECALL_K_CAP = 32`), `src/memory/memory-store.ts:535` (`params.push(WRITE_CANDIDATE_CAP)` → SQL `LIMIT ?`)
- **Evidence:** Two-layer defense. Write-time: detection SQL at memory-store.ts:557 enforces `LIMIT WRITE_CANDIDATE_CAP=50`, so an attacker writing 1000 same-tagged memories produces at most 50 candidate pairs per write — O(50) per insert, NOT O(1000²). Recall-time: `resolveConflicts` slices the input at `RECALL_K_CAP=32` (`:144`); rows beyond rank 32 pass through un-annotated and un-dropped at `:231`. Test `conflict-detection.test.ts:262-273` asserts K=32 worst case completes <100ms.
- **Caveat (LOW):** An attacker who writes 1000 memories CAN reach 1000 rows in storage, paying disk + storage cost. That's a rate-limit issue, NOT a conflict-detection DOS. Existing rate-limiter at `memory-store.ts:635-649` caps writes per run_id (`RELAY_MEMORY_MAX_WRITES_PER_RUN`, default 10/5min) blunts this.
- **Verdict:** CLOSED.

### P5-4. Pinned memory bypass via conflict resolution — VERIFIED MITIGATED
- **Site:** `src/memory/conflict-detection.ts:194-196,204-211` (drop policies inspect `loser.pinned` / `winner.pinned`)
- **Evidence:** Under `drop-lower-trust`: if `loser.pinned` is true, the loser is annotated AND KEPT (`:195-196`); only non-pinned losers are dropped (`:198`). Under `drop-all-conflicts`: BOTH sides check pinned and pinned rows are annotated-and-kept (`:204-211`), non-pinned drop. Under `annotate`: nobody is dropped, pinned irrelevant. Invariant: pinned memories are NEVER absent from `kept` regardless of policy. CONFLICT-03 / DELTA-MEM-CONFLICT.md §10 Q2 satisfied.
- **Verdict:** CLOSED.

### P5-G1. Cosine gate misuse (NaN/Infinity/>1.0) — VERIFIED MITIGATED (with caveat)
- **Sites:**
  - Cosine math: `src/memory/memory-store.ts:469-488` (`cosine()` clamps to [0,1] at `:485-487`, returns 0 on zero-magnitude at `:481`)
  - All-finite guard: `src/memory/memory-store.ts:452-456` (`decodeEmbedding` rejects any non-finite value, returns null)
  - Length-mismatch guard: `:470` returns 0
  - Cosine gate predicate: `src/memory/conflict-detection.ts:79` (`inputs.cosine !== undefined && inputs.cosine >= COSINE_GATE_MAX`)
- **Evidence:** `decodeEmbedding` walks the entire Float32Array and returns NULL on the first NaN/Infinity (`:455`). Returning null causes the caller at `:604-606` to NEVER assign `cosine`, leaving it `undefined`. `isConflictCandidate` treats `undefined` cosine as "Jaccard-only verdict" (`:79`). So NaN/Infinity inputs degrade gracefully — never reach the `>= COSINE_GATE_MAX` comparison.
- **Caveat (MEDIUM, hygiene only):** When candidate side has no embedding OR embedding_model differs, cosine is skipped entirely (`:604` guard) and the verdict falls back to Jaccard-only. This is the documented contract (DELTA-MEM-CONFLICT.md §4 W4 / PITFALL 2.5), but it means a paraphrase-pair-without-embeddings will get flagged as a conflict even though semantically they're equivalent. The fix is operational (run the embedding backfill), not a code defect.
- **Verdict:** CLOSED.

### P5-5. Annotation UUID injection via render layer — VERIFIED MITIGATED
- **Site:** `src/context/layers.ts:277-279` (regex anchored to `⚠ CONFLICTS WITH` / `⚠ CONTRADICTED BY` prefix + 36-char UUID pattern)
- **Evidence:** Engine-layer annotations carry raw `memory_id` UUIDs (`conflict-detection.ts:189-211`). Render layer translates via strict regex `^(⚠ (?:CONFLICTS WITH|CONTRADICTED BY)) ([0-9a-fA-F-]{36})$`. Any annotation that doesn't match this exact shape is preserved verbatim, but the regex blocks injection of fake `⚠ CONFLICTS WITH` annotations from user content (user content goes through `redactSecrets` BEFORE storage and never directly produces an `annotations` array — those are computed by `resolveConflicts` from `conflicts_with` which the user cannot directly populate).
- **Verdict:** CLOSED.

### P5-6. Conflict-detection helper purity (no DB/HTTP/fs creep) — VERIFIED MITIGATED
- **Site:** `src/memory/conflict-detection.ts:20-27` (import list = `./types.js` + `./conflict-thresholds.js` ONLY)
- **Evidence:** Module imports exactly two files. No `better-sqlite3`, no `node:fs`, no `node:http`, no `fetch`. No `async` / `Promise`. No `console.*`. Input arrays returned by-reference when no annotation applies (`:227`), copies returned when annotations apply (`:225`) — input never mutated. `conflict-workdir-isolation.test.ts` (per the file's own comment at `:17`) enforces this via a grep guard.
- **Verdict:** CLOSED.

---

## Phase 7 — Figma REST Tools

### P7-1. PAT leak in logs (Wave A figd_ regex layered correctly) — VERIFIED MITIGATED
- **Sites:**
  - Always-on layer: `src/security/redaction.ts:25-28` (`figma_pat` pattern `/figd_[A-Za-z0-9_-]+/g`)
  - Precise layer: `src/tools/figma/scrub.ts:30` (`FIGMA_PAT_RE`), applied via `scrubPat`/`scrubHeaders`/`scrubError`
- **Evidence:** Two-layer defense. Every Figma REST error message at rest-client.ts:34-100 routes through `scrubPat()` in its `FigmaApiError` superclass constructor (`:37` → `super(scrubPat(message))`). Network-layer exceptions at rest-client.ts:227 use `scrubError(err)` which scrubs message + stack + cause. Headers are immutable-copy scrubbed at scrub.ts:56-70. Defense-in-depth: even if a future code path forgets to call `scrubPat`, the always-on redaction layer in `src/security/redaction.ts` catches it on any production log write (memory writes, worker stdout, debug dumps).
- **Verdict:** CLOSED.

### P7-2. PAT leak in error messages (any exception path that includes the token) — VERIFIED MITIGATED
- **Sites:** `src/tools/figma/rest-client.ts:170-185` (all status-mapped errors run through `scrubPat(bodyText)` at `:171`), `:227-228` (network-error path uses `scrubError`), `:234` (JSON-parse failure path uses `scrubError`)
- **Evidence:** The PAT is set as `X-Figma-Token` header at `:214` — it is NOT in the URL, NOT in the body, NOT in the path. Figma's API spec confirms PATs are header-only, so the response body has no PAT echo. Even so, every error message that gets thrown is double-scrubbed (precise layer at throw + always-on layer at log write). The error message format `Figma <status> <kind>: <scrubbed body>` cannot reach the caller with a raw PAT.
- **Spot check:** The PAT IS passed verbatim into the `headers` object at `:213-215`. If a future developer adds a `console.log(headers)`, that log entry would print the PAT — but the always-on redaction in `src/security/redaction.ts:25-28` would catch it on serialization. Also: no debug-dump in current rest-client.ts.
- **Verdict:** CLOSED.

### P7-3. Rate-limit retry storm (429 → silent infinite retry) — VERIFIED MITIGATED
- **Site:** `src/tools/figma/rest-client.ts:248-260` (`doRequestWithRetry`)
- **Evidence:** Single-retry semantics. First request → if 429, sleep `Retry-After` (clamped 1-60s at `parseRetryAfter:152-165`), then `await doRequest(opts)` once more. The second attempt's result is RETURNED unchanged — no further loop, no exponential backoff escalation. If the second attempt is ALSO 429, the FigmaRateLimitError propagates to the handler, which returns it as `ERROR: <msg>` via executeToolCall's catch (lmstudio-agentic.ts:349-354). The model receives a structured error and can self-correct or give up; the runner's iteration cap at `:571` (`maxIterations <= 20`) is an orthogonal second-layer cap.
- **Caveat (LOW):** The model COULD emit `figma_list_layers` repeatedly across iterations, each call producing a 429+retry (2 attempts × 1-60s sleep). Worst case: 20 iterations × 2 attempts × 60s = 40 minutes of wall-clock, but the runner's `task.timeout_ms` AbortController (lmstudio-agentic.ts:550-551) caps total wall-clock at the caller-specified timeout (default 300s in cmd-parallel.ts:134). Combined ceiling is bounded.
- **Verdict:** CLOSED. No silent infinite retry possible.

### P7-4. Endpoint locality (REST goes to api.figma.com — intended; no local-only gate erroneously applied) — VERIFIED CORRECT
- **Site:** `src/tools/figma/rest-client.ts:26` (`FIGMA_BASE_URL = 'https://api.figma.com'`)
- **Evidence:** Figma REST is INTENTIONALLY non-local (only available at api.figma.com). The `isLocalEndpoint` gate from `src/memory/endpoint-locality.ts` is NOT applied to Figma calls — and correctly so. The gate's purpose is to prevent embedding-of-memory-content leaks; Figma REST calls do not transmit memory content (they transmit file_key + token_name + value, supplied by the model from user prompt). No local-only check incorrectly applied.
- **Threat-model context:** Phase 7 PLAN §T-07-08 declares that PAT-bearing requests to api.figma.com are an ACCEPTED data flow (user explicitly opts in by setting FIGMA_API_TOKEN). The accepted risk is documented and the implementation conforms.
- **Verdict:** CLOSED (correct by design).

### P7-5. PAT file permissions (chmod 600 enforced) — VERIFIED MITIGATED
- **Site:** `src/tools/figma/pat-loader.ts:28` (`GROUP_OTHER_MASK = 0o077`), `:48-64` (stat + mask check)
- **Evidence:** `statSync(filePath).mode & 0o077` — non-zero means group OR other has ANY of (read|write|execute). On non-zero, loader writes one stderr warning at `:59-62` and returns null. The agentic runner gets `null` from `registerFigmaTools` and skips Figma tool registration entirely. A 0644 file (world-readable) → 0o044 & 0o077 = 0o044 ≠ 0, refused. A 0600 file → 0o000 & 0o077 = 0, accepted.
- **Caveat (LOW):** Race window: if file is chmod'd from 0600→0644 between statSync and readFileSync, the read still proceeds. The window is ~microseconds and requires local-attacker write access to the user's home dir — at that point, the attacker has bigger problems (e.g. can edit `~/.bashrc`). Out-of-scope per local-CLI threat model. TOCTOU is documented as accepted risk in baseline.
- **Verdict:** CLOSED.

### P7-6. Tool registration leak when FIGMA_API_TOKEN unset — VERIFIED MITIGATED
- **Site:** `src/tools/figma/index.ts:66-67` (`if (!pat) return null;`), `src/cli/cmd-run.ts:90-101` (`extraToolHandlers` is undefined when figmaHandlers is null), `src/cli/cmd-run.ts:140-143` (tools[] only includes figma defs when figmaHandlers non-null)
- **Evidence:** `registerFigmaTools` returns `null` when both env AND file resolution fail. cmd-run/cmd-parallel branch on null: handlers omitted from `extraToolHandlers`, tool ToolDefs omitted from `tools[]`. The model literally never sees `figma_list_layers` or `figma_update_token` in its tool inventory when PAT is absent. If the model nevertheless emits `figma_list_layers` (out of curiosity or trained behavior), `executeToolCall` at lmstudio-agentic.ts:337 finds no match in extraToolHandlers, then no match in SHELL_EXEC_NAMES → `ERROR: unknown tool figma_list_layers` (`:358`).
- **Verdict:** CLOSED.

### P7-7. extraToolHandlers injection — Wave A env allow-list still covers figma_* tools — VERIFIED MITIGATED
- **Site:** `src/workers/lmstudio-agentic.ts:336-355` (named-handler dispatch path) — NOT a shell_exec branch
- **Evidence:** The figma_* tools never go through `defaultShellExec` / `execFile`. They dispatch to `extra.handle(parsedArgs, { workdir, pat: extra.pat })` which calls `handleListLayers` / `handleUpdateToken` directly. Those handlers issue `fetch()` to api.figma.com — no subprocess spawn. So the SHELL_EXEC_ENV_ALLOW allow-list at `:213-221` does NOT apply to Figma tools because they're not in the shell path. **But this is the correct behavior** — Figma handlers need ctx.pat (the FIGMA_API_TOKEN value), which is passed via the `pat` field on NamedToolHandler (`:124`). They do NOT inherit `process.env`. The PAT reaches the fetch via the explicit ctx.pat path, never via env.
- **Threat-model contrast:** A malicious caller of `LmStudioAgenticRunner` could pass `extraToolHandlers: [{name: 'eval_arbitrary', handle: badFn, pat: ''}]`. This would let `badFn` run with full Node.js privileges in the runner's process. But the only production callers are cmd-run.ts and cmd-parallel.ts, both of which ONLY pass handlers returned by `registerFigmaTools`. No third-party code path injects arbitrary handlers. Trust boundary: caller of LmStudioAgenticRunner is trusted code; the model is not.
- **Verdict:** CLOSED. The Wave A env allow-list correctly DOES NOT apply to non-shell dispatch (they're a different threat surface).

### P7-8. cmd-doctor --figma output sanitization (PAT scrubbed in --json envelope) — VERIFIED MITIGATED
- **Site:** `src/cli.ts:725-737` (dispatch), `src/cli/cmd-doctor-figma.ts:79,90-113` (render via formatFigmaProbeOutput)
- **Evidence:** `relay doctor --figma` does NOT support a `--json` flag — the dispatch at `cli.ts:728-734` only invokes the probe + plain-text formatter, then returns. There is NO JSON envelope path for the Figma probe. The plain-text output (`formatFigmaProbeOutput`) routes every line through `scrubPat` at lines 100,101,103,105 — REST detail, user handle, and any error message all get the precise PAT scrub. The always-on layer in `src/security/redaction.ts` is the catch-all even if scrubPat were forgotten.
- **Caveat:** `--figma` is mutually-exclusive with the standard `--json` doctor path (cli.ts:728's `if` short-circuits before reaching cmd-doctor.ts at `:735`). Users wanting JSON envelopes get the non-Figma doctor, which doesn't probe Figma at all — zero PAT exposure surface. Good design.
- **Verdict:** CLOSED.

### P7-G1. figma_pat regex 1-char minimum partial-leak (MEDIUM, cosmetic) — DOCUMENT
- **Site:** `src/security/redaction.ts:26` (`/figd_[A-Za-z0-9_-]+/g`), `src/tools/figma/scrub.ts:30` (same)
- **Defect:** Pattern accepts `figd_X` (1+ token chars). A user-generated string `figd_X` in normal text — say, a code comment "// see figd_X documentation" — gets mangled to `[REDACTED:FIGMA_PAT]` / `figd_***SCRUBBED***`. Reverse direction: a 2-char partial-leak fragment `figd_AB` (e.g. someone pasted truncated logs) also masks correctly. Tradeoff: false-positive on rare benign strings, true-positive on partial PAT leaks. Per `scrub.ts:22-24` this is intentional ("broad, fail-loud"). Real Figma PATs are 40+ chars.
- **Impact:** LOW false-positive risk in normal logs (no project source mentions `figd_<chars>` outside PAT contexts). HIGH defensive value for partial-leak detection. NET POSITIVE.
- **Verdict:** DOCUMENT (intentional design; not a defect). No remediation needed.

---

## Verification Method

Direct read of `src/` + grep across known mitigation sites. No code changes. All claims trace to file:line citation in this report.

---

## Threats: status table (all)

| ID | Surface | Phase | Disposition | Verdict |
|----|---------|-------|-------------|---------|
| W-A1 | shell_exec env allow-list | Wave A | mitigate | CLOSED (REGRESSION-FREE) |
| W-A2 | Embedding endpoint locality (write + recall) | Wave A | mitigate | CLOSED (REGRESSION-FREE) |
| W-A3 | scheduleEmbed model capture race | Wave A | mitigate | CLOSED (REGRESSION-FREE) |
| W-A4 | Semantic similarities wire-up (layers + tui) | Wave A | mitigate | CLOSED (REGRESSION-FREE) |
| P5-1 | Cross-workdir conflict-detection leak | 5 | mitigate | CLOSED |
| P5-2 | Reciprocal UPDATE transactional consistency | 5 | mitigate | CLOSED |
| P5-3 | K=32 cap DOS via O(K²) | 5 | mitigate | CLOSED |
| P5-4 | Pinned memory drop bypass | 5 | mitigate | CLOSED |
| P5-G1 | Cosine NaN/Infinity/>1.0 | 5 | mitigate | CLOSED (hygiene caveat documented) |
| P5-5 | Annotation UUID injection | 5 | mitigate | CLOSED |
| P5-6 | conflict-detection.ts purity | 5 | mitigate | CLOSED |
| P7-1 | PAT leak in logs (layered figd_ regex) | 7 | mitigate | CLOSED |
| P7-2 | PAT leak in error messages | 7 | mitigate | CLOSED |
| P7-3 | 429 retry storm | 7 | mitigate | CLOSED |
| P7-4 | Endpoint locality (api.figma.com intended) | 7 | accept | CLOSED (correct by design) |
| P7-5 | PAT file chmod 600 | 7 | mitigate | CLOSED |
| P7-6 | Tool registration when PAT absent | 7 | mitigate | CLOSED |
| P7-7 | extraToolHandlers + env allow-list interaction | 7 | mitigate | CLOSED |
| P7-8 | cmd-doctor --figma sanitization | 7 | mitigate | CLOSED |
| P7-G1 | figd_ regex 1-char minimum | 7 | accept | DOCUMENT (intentional) |

---

## Required Actions Before v0.2 SHIP

NONE. All Phase 3+4 CATASTROPHIC gaps are CLOSED by Wave A. Phase 5 + 7 introduce no new ship-blocking threats.

## Suggested Follow-ups (non-blocking)

1. **Cleanup duplication:** delete `isLocalEndpoint` from `src/cli/cmd-memory-auto-extract.ts:826-836`; re-export from `src/memory/endpoint-locality.ts` to maintain single source of truth.
2. **Hygiene:** add a chmod-600 self-heal hint to the cmd-doctor `--figma` output ("File mode N detected — run: chmod 600 <path>") so users discover the silent skip from PAT loader.
3. **Track:** P3-G2 (EMPTY_ID_SENTINEL) and P4-G2 (Number.isFinite on cosine clamp) from the Phase 3+4 delta remain OPEN as "cosmetic / hygiene" follow-ups. Neither blocks ship.
