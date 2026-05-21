# Coverage Delta — Phase 5 (conflict detection) + Phase 7 (Figma REST tools)

**Baseline:** `.planning/COVERAGE-DELTA-PHASE-3-4.md` (last audit; 2 phases earlier).
**Audited paths (Phase 5):** `src/memory/{conflict-detection,conflict-thresholds,memory-store,memory-engine,types}.ts` + 8 conflict-* test files, `src/context/{layers,conflict-render.test}.ts`.
**Audited paths (Phase 7):** `src/tools/figma/{index,pat-loader,rest-client,scrub,list-layers,update-token}.ts` + 6 test files, `src/cli/{cmd-doctor-figma,cmd-doctor-figma.test}.ts`, `src/security/redaction{,.test}.ts` (figma_pat delta only), `src/workers/lmstudio-agentic{.ts,.test.ts}` (extraToolHandlers wire only), `src/cli/cmd-run.ts:75-144`.
**Method:** read implementation, mapped behaviour → tests; gaps = observable behaviours whose regression would NOT be caught by an existing assertion.

Severity: **P1** = silent prod bug or security/contract breach; **P2** = real but bounded failure; **P3** = nice-to-have.

---

## Phase 5 — conflict detection

### Pure helpers (P3)

- **GAP-5.1 (P3) `tagJaccard` numeric edge (one empty set).** `conflict-detection.ts:33-39` — `(empty, {a,b})` → `0 / 2 = 0`. Covered implicitly by "disjoint → 0" (`conflict-detection.test.ts:38`) but not as the asymmetric-empty case. **Suggest:** `tagJaccard(new Set(), new Set(['a','b']))` → 0.
- **GAP-5.2 (P3) Set with `''` (empty string).** `conflict-detection.ts:33-39` treats `''` as a tag. Indirectly relevant to malformed `tags_json`. **Suggest:** `tagJaccard(new Set(['']), new Set(['']))` → 1, document or guard.

### Write-time detection (P1/P2)

- **GAP-5.3 (P1) Atomicity claim ("reciprocal UPDATE rolls back with INSERT") NEVER asserted.** `memory-store.ts:702-746` wraps INSERT + `detectAndPersistConflicts` in `db.transaction(...)`. The comment at `:494-496` and PITFALL 3.2 promise atomicity, but no test forces a throw inside `detectAndPersistConflicts` and asserts the new row + peer updates ALL roll back. **Suggest:** monkey-patch `updateStmt.run` to throw on the SECOND call; assert (a) new row was not inserted (`getMemory(newId) === null`), (b) peer's `conflicts_with` unchanged from pre-call state. Without this test, a future refactor breaking the tx wrap silently leaves orphaned half-state.
- **GAP-5.4 (P2) Multiple-match write path.** `conflict-write.test.ts:184-210` (write cap) seeds many candidates but only asserts `≤ WRITE_CANDIDATE_CAP`. No test that seeds 2-3 same-workdir conflicting rows, then writes a fourth that conflicts with 2 of them, and asserts `newMem.conflicts_with` contains BOTH peer IDs AND both peers got reciprocal UPDATEs. SC#1 (`:42-78`) covers the 1-candidate case. **Suggest:** seed A, B (non-conflicting with each other via different content tokens), write C with tags overlapping both → assert `C.conflicts_with` length === 2, `A.conflicts_with.includes(C)`, `B.conflicts_with.includes(C)`.
- **GAP-5.5 (P2) Threshold boundary tag_jaccard = 0.5 exactly.** `conflict-detection.ts:77` uses strict `<=` (i.e. `tagJac <= TAG_JAC_MIN` returns false). Unit-level boundary covered at content side (`conflict-detection.test.ts:88-107` covers cosine 0.7 boundary) but no unit test for tagJac exactly 0.5. **Suggest:** `isConflictCandidate({tagJac: 0.5, contentJac: 0.2, sharedTagCount: 2})` → false (strict gate).
- **GAP-5.6 (P2) Threshold boundary content_jaccard = 0.3 exactly.** `conflict-detection.ts:78` uses strict `>=`. No boundary test. **Suggest:** `isConflictCandidate({tagJac: 0.6, contentJac: 0.3, sharedTagCount: 2})` → false.
- **GAP-5.7 (P2) Write-time skip when ZERO same-workdir candidates exist.** `memory-store.ts:561` early-returns when `candidates.length === 0`. No test seeds a single memory in a fresh workdir and asserts the detection path is a no-op (`conflicts_with = []` with no SQL UPDATE fired). Covered implicitly by all single-row inserts but no assertion pins the "no-op" contract. **Suggest:** spy on `updateStmt.run` count; insert one memory in fresh workdir; assert spy never called.
- **GAP-5.8 (P3) Detection skipped when peer is superseded.** `memory-store.ts:551` filters `superseded_by IS NULL`. No test seeds A, supersedes A via `upsert()`, then writes B with same tags → asserts B's conflicts_with is empty (A was superseded). **Suggest:** the inverse confirms that consolidated/superseded rows don't re-flag.

### Workdir leak regression (P1)

- **GAP-5.9 (P1) "Workdir A pre-seed, Workdir B write" regression NOT explicitly tested.** `conflict-workdir-isolation.test.ts:36-56` writes BOTH rows in the same store call without explicit pre-seed. The grep guard (`:81-110`) is static — it prevents `workdir IS NULL OR workdir = ?` from creeping in but doesn't catch a runtime regression where, e.g., the SQL params get reordered and workdir filtering breaks. **Suggest:** seed 5 memories in `/p-A` (all conflicting tag sets), then write 1 memory in `/p-B`; assert (a) `/p-B`.conflicts_with === [], (b) ALL 5 `/p-A` rows still have empty conflicts_with (no retroactive cross-workdir UPDATE). Behavioural counterpart to the grep guard.
- **GAP-5.10 (P2) Global (null workdir) ↔ global cross-flag.** `conflict-workdir-isolation.test.ts:58-79` covers global vs scoped (no flag), but not global vs global (SHOULD flag — both null workdirs match `workdir IS NULL`). **Suggest:** two memories with `workdir: null` and conflicting tags → BOTH should reciprocally flag (verifies the null branch at `memory-store.ts:525` works symmetrically).

### Pairwise pass / engine integration (P1/P2)

- **GAP-5.11 (P2) K cap respect at engine boundary.** `conflict-recall.test.ts:129-172` correctly tests rows beyond K stay un-annotated, but uses pinned high-score top-K to force the conflicting pair out. A more direct test: feed exactly RECALL_K_CAP+1 mutually-conflicting rows in score order, assert the (K+1)-th row's annotations === undefined while the first K interact normally. Current test mixes pinned ordering with K-cap behaviour. **Suggest:** dedicated test with RECALL_K_CAP rows of score 0.9 each (no conflicts) + 1 extra row at score 0.5 (declared conflict with row #0); assert row[0] and row[K] are not annotated.
- **GAP-5.12 (P3) Pairwise performance test (`conflict-detection.test.ts:262-274`) uses 100ms cap.** Acceptable but CI-variable on slow runners. **Suggest:** lower cap to 50ms or add `process.env['CI']` guard with looser 250ms on CI.
- **GAP-5.13 (P2) Precedence: equal trust + equal score + equal recency.** `conflict-detection.test.ts:172-193` covers each tiebreak in isolation. When ALL three are equal, `compareByPrecedence` returns 0 (`memory-store.ts:104-110` → `compareByPrecedence` in conflict-detection.ts:104-110) — the `if (cmp >= 0) edges.push({ winner: i ...})` branch at `conflict-detection.ts:167` makes `i` (lower index) win. No test pins this lexicographic-fallback contract. **Suggest:** two identical-precedence rows in input order [A, B] → A wins; in input order [B, A] → B wins. Documents the implicit input-order tiebreak.
- **GAP-5.14 (P2) `drop-all-conflicts` policy untested at engine boundary.** `conflict-detection.ts:203-215` handles this policy with pinned exception logic. Pure tests only cover `'annotate'` and `'drop-lower-trust'` (`conflict-detection.test.ts:145-220`). `conflict-recall.test.ts` likewise. **Suggest:** at least one pure + one engine test for `'drop-all-conflicts'` — neither pinned → both dropped, both pinned → both kept with annotation, mixed → only the non-pinned dropped.

### Annotation render (P1/P2)

- **GAP-5.15 (P2) Reordered set after failure-first sort.** `context/layers.ts:249-264` builds `idToIndex` from the FINAL sorted order (post failure-first sort). `conflict-render.test.ts:35-81` covers the happy path but no test where memory A has the `failure` tag and B does NOT → failure-first sort puts A first → `#1`/`#2` references must reflect the swap, not the engine's score order. **Suggest:** Seed A (failure tag, low score) + B (no failure tag, high score) with mutual conflict; assert rendered output has A at `1.` with `CONFLICTS WITH #2` (or vice versa per precedence), and the annotation index matches the failure-first sorted position, not the score-sorted position. This is the central two-pass-correctness test the plan called out.
- **GAP-5.16 (P2) Dangling reference (peer filtered by MIN_RELEVANCE_SCORE).** `context/layers.ts:282` "Drop annotations whose peer is not in the rendered list". `conflict-render.test.ts` doesn't construct a scenario where engine flags A↔B mutual but query-score filtering removes B from the rendered list, leaving A with an annotation pointing to a no-longer-rendered peer. The render loop SHOULD drop A's annotation; if it didn't, `idToIndex.get` returns undefined and the marker is silently skipped — but no test asserts the marker is missing from A's line. **Suggest:** seed two conflicting rows with very different query relevance (B has near-zero overlap); assert B filtered out AND A's line has NO `CONFLICTS WITH` marker.
- **GAP-5.17 (P2) Non-UUID conflicts_with value passes through the regex unsafely.** `context/layers.ts:279` `match(/^(⚠ ...) ([0-9a-fA-F-]{36})$/)`. If a row had `conflicts_with: ['short-id']`, the regex would not match and the marker silently disappears (correct behavior). But if a row had `conflicts_with: ['00000000-0000-0000-0000-000000000000-suffix']` (36 chars + extra), the regex anchors to `$` and the trailing chars would fail the match. No test pins this. **Suggest:** edge-case test — engine emits a malformed annotation; renderer skips silently with no exception.

### Cosine gate (P1/P2)

- **GAP-5.18 (P1) "Cosine just below 0.7 vs just above" NOT directly tested at write integration.** `conflict-cosine.test.ts:61-186` documents that the integration test can't easily exercise the gate because of the scheduleEmbed-after-tx timing (`:138-155` comment confirms). Pure tests cover the gate (`conflict-detection.test.ts:88-115`) but the integration → SQL → cosine decode → gate path has no end-to-end pin. **Suggest:** test that uses raw INSERT to pre-populate two rows with embeddings set (cosine 0.69 vs 0.71), then a third raw INSERT also pre-embedded, then call `detectAndPersistConflicts` directly via a small test-only export OR manually invoke via reflection. If detection can't be tested without scheduleEmbed timing, mark the gate as "unit-only" in the plan. Current cosine tests at integration level mostly assert "no crash".
- **GAP-5.19 (P2) Cross-model cosine gate.** `memory-store.ts:604` requires `selfModel === cand.embedding_model`. No test seeds two rows with DIFFERENT embedding_model strings (e.g. nomic vs minilm) and asserts cosine is NOT applied → Jaccard verdict stands. **Suggest:** raw INSERT seed two rows with different models; trigger detection; assert Jaccard verdict (not cosine-gated suppression).
- **GAP-5.20 (P3) selfRow lookup race.** `memory-store.ts:572-574` reads `selfRow` from DB AFTER its own INSERT — relies on tx-scoped visibility. No test asserts that within the rememberTx, the newly INSERTed row is visible to the SELECT. Better-sqlite3 transactions are synchronous so this should always work; documenting the invariant is enough.

### Migration idempotency (P2)

- **GAP-5.21 covered** — `conflict-migration.test.ts:54-67` runs migration twice, asserts column count unchanged. Green.
- **GAP-5.22 (P2) Migration on existing v0.1 data.** `conflict-migration.test.ts:69-109` covers legacy 18-col INSERT + DEFAULT `'[]'`. No test seeds the `__fixtures__/v0.1.2-baseline.db` (referenced in baseline GAP-4.15), migrates, asserts existing rows have `conflicts_with_json === '[]'` and are otherwise byte-identical. **Suggest:** seed real fixture DB (if it exists) or hand-craft a 14-col legacy row, migrate, assert column added, default applied, existing data preserved.

---

## Phase 7 — Figma REST tools

### PAT loader (P1/P2)

- **GAP-7.1 covered** — `pat-loader.test.ts` covers env present, env+file priority, chmod 600 happy, chmod 644 refuse, file absent, JSON parse error, empty token, whitespace-only env. All 8 PLAN cases green. Workdir loader covered separately.
- **GAP-7.2 (P2) Chmod boundary: chmod 640 (group-read only).** `pat-loader.ts:58` uses mask `0o077`. Chmod 644 covered (`pat-loader.test.ts:66-75`). 640 (group read but no other) is functionally identical security-wise but not tested. **Suggest:** chmod 640 → refused with same warning. Pins the mask semantics.
- **GAP-7.3 (P3) stat() throws something other than ENOENT** (e.g., EACCES on the parent dir). `pat-loader.ts:49-55` swallows all stat errors via `try/catch` and returns null. No test forces a non-ENOENT stat error. **Suggest:** mock `statSync` to throw EACCES; assert null returned (graceful), no warning emitted (current contract: ONLY chmod violations warn).
- **GAP-7.4 (P2) loadPat called with `homeDir = ''` or undefined.** `pat-loader.ts:47` uses `join(homeDir, ...)`. Empty homeDir would yield a relative path. No defensive test. **Suggest:** `loadPat({}, '')` → null (relative path doesn't exist or stat fails). Pins the contract: garbage homeDir → null, no crash.

### scrub.ts (P2/P3)

- **GAP-7.5 covered** for happy path, multi-occurrence, multi-line, no-PAT, headers, error wrapping. All 6 PLAN cases green. Plus bonus `Authorization: Bearer figd_...` cross-leak via scrubPat in other header values.
- **GAP-7.6 (P2) Authorization header value with figd_ prefix.** `scrub.ts:65-66` scrubs non-x-figma-token values via scrubPat. Test `:75-81` checks lowercase header KEY is masked, but no test with `Authorization: Bearer figd_xyz` (KEY not `x-figma-token`, VALUE contains figd_). **Suggest:** `scrubHeaders({'Authorization': 'Bearer figd_secretpat'})` → masked via scrubPat fallback path.
- **GAP-7.7 (P3) scrubError with `cause` chain.** `scrub.ts:88-91` recursively scrubs error.cause. No test asserts cause chain scrubbing. **Suggest:** `new Error('outer figd_x', { cause: new Error('inner figd_y') })` → both message and cause.message scrubbed.
- **GAP-7.8 (P3) scrubPat with non-string input.** `scrub.ts:40` early-returns when not a string. No test pins this. Edge of defensive contract. **Suggest:** `scrubPat(null as any)` returns null; `scrubPat(42 as any)` returns 42.

### rest-client (P1/P2)

- **GAP-7.9 covered** for 200/400/403 (4 kinds)/404/413/429 (single retry + double 429)/500/network reject/PAT-in-body scrub. Excellent coverage at `rest-client.test.ts:76-291`.
- **GAP-7.10 (P2) "Network timeout" path NOT tested.** Task brief lists "network timeout" but the test suite has no timeout-specific case — `rest-client.ts` does not enforce a timeout (it relies on fetch's default). Either: (a) the contract is "no explicit timeout enforced, AbortSignal must be supplied" and a test pins it, OR (b) the code is missing a timeout. **Suggest:** test that fetchImpl returns a promise that NEVER resolves; assert call hangs (or AbortController integration is documented as future work).
- **GAP-7.11 (P2) Malformed JSON response on a 2xx.** `rest-client.ts:230-235` catches `res.json()` failure and throws scrubbed `Figma response not valid JSON`. No test asserts this branch. **Suggest:** scripted fetch returns 200 with non-JSON body (`'not json at all'`); assert thrown error message includes "not valid JSON".
- **GAP-7.12 (P3) 502/503/504 mapping.** `rest-client.ts:184` maps any non-listed status to FigmaServerError. Only 500 tested (`:209-216`). **Suggest:** parametric test for 502/503/504 → FigmaServerError with correct .status.
- **GAP-7.13 (P2) parseRetryAfter with negative integer.** `rest-client.ts:152-165` matches `/^\d+$/` so negatives fall to HTTP-date fallback (1s). No test pins this. **Suggest:** parseRetryAfter('-5') === 1000.
- **GAP-7.14 (P2) Retry-After=0.** `:158-161` parses 0 to 0ms, clamped to MIN_RETRY_AFTER_MS=1000. **Suggest:** parseRetryAfter('0') === 1000.
- **GAP-7.15 (P3) buildUrl with query params having `null` value.** `rest-client.ts:203-206` skips undefined AND null. No test for null. **Suggest:** `figmaGet('/x', {pat, query: {a: null as any}})` → URL has no `a=` param.

### list-layers (P2)

- **GAP-7.16 covered** for happy + 5-level nesting + empty children + page_id route + depth route + zod error + 404. 8 PLAN cases green.
- **GAP-7.17 (P2) "Invalid file_key" gives a path-style error (not 404).** `list-layers.ts:113,117` use `encodeURIComponent(file_key)` so a file_key with `/` becomes `%2F`. No test for a weird file_key (`'a/../../etc/passwd'`) → encoded safely AND Figma returns 404. **Suggest:** assert encoding happens (URL contains `%2F`, never raw `/`).
- **GAP-7.18 (P3) Response shape variant: response has BOTH `document` and `nodes` keys.** `list-layers.ts:135-145` prefers `nodes` then falls back to `document`. No test asserts the precedence. **Suggest:** fixture with both keys; assert nodes wins.
- **GAP-7.19 (P3) Node with non-string id.** `list-layers.ts:90` guards `typeof (child as ...).id === 'string'`. No test pins malformed children skipping silently.

### update-token (P2)

- **GAP-7.20 covered** for CREATE+UPDATE paths, all 3 type mappings (color/spacing/typography), zod validation, 403 PLAN_REQUIRED graceful, 403 TOKEN_EXPIRED throws, GET-fails-no-POST. 9 PLAN cases green.
- **GAP-7.21 (P2) tempIdToRealId mapping missing in 200 response.** `update-token.ts:198` falls back to `existing?.id ?? variableId`. Test `:170-194` covers UPDATE returning existing id, but no test for CREATE where `meta.tempIdToRealId` is missing entirely (e.g. empty `meta:{}`). **Suggest:** CREATE flow, scripted 200 with `body: {meta: {}}`; assert `node_id === 'temp:<token_name>'` (the fallback). Pins the failure-mode behavior.
- **GAP-7.22 (P2) mode_id resolution: collection_id not in local.meta.variableCollections.** `update-token.ts:165` falls back to `'1:0'`. No test forces a missing collection AND no caller-provided mode_id. **Suggest:** GET local returns empty `variableCollections: {}`; call with no mode_id; assert POST body modeId === `'1:0'` (default fallback).
- **GAP-7.23 (P2) 500 from POST after successful GET.** `update-token.ts:192-213` only catches FigmaForbiddenError with kind PLAN_REQUIRED. A FigmaServerError thrown by POST propagates unchanged. No test asserts the propagation. **Suggest:** GET 200 → POST 500; assert FigmaServerError propagates.

### registry index.ts (P2)

- **GAP-7.24 covered** for env-empty → null, env-set → 2 handlers, file chmod 600 → 2 handlers, file chmod 644 → null+warn, deferred const has 2 names, deferred names NOT exported as functions, registered names exclude deferred. Excellent.
- **GAP-7.25 (P2) handlers exposed match a strict allow-list (defense against rogue addition).** `index.test.ts:115-125` asserts registered names exclude DEFERRED_FIGMA_TOOLS. No test asserts the POSITIVE complement: registered names are EXACTLY `['figma_list_layers', 'figma_update_token']` (no third tool snuck in). **Suggest:** `assert.deepEqual(sortedNames, ['figma_list_layers', 'figma_update_token'])`. Pins the surface area.

### doctor --figma (P2)

- **GAP-7.26 covered** for PAT absent, PAT present + 200, PAT present + 403 expired (scrubbed), chmod 600 vs 644 flip, deferred const rendered. 6 PLAN cases green.
- **GAP-7.27 (P2) "Sample REST call" in task brief.** The task brief mentions "sample REST" — `cmd-doctor-figma.ts:55` does GET /v1/me as the sample. Test `:56-67` covers it. Green.
- **GAP-7.28 (P2) "Plan-tier" probe explicitly NOT done.** Brief says "plan-tier" but `cmd-doctor-figma.ts:1-17` deliberately defers: "plan-tier inference from /v1/me is not reliable per VERIFICATION.md W1". This is a documented deferral, not a gap — `formatFigmaProbeOutput` doesn't emit a Plan line. No test pins the deferral choice (i.e. asserts output does NOT contain a "Plan:" line). **Suggest:** `assert.doesNotMatch(out, /^Plan:/m)` to lock the deferral against accidental re-introduction.
- **GAP-7.29 (P2) Network error during probe.** `cmd-doctor-figma.ts:67-82` catches FigmaForbiddenError / FigmaApiError / generic Error. No test asserts a non-FigmaApiError generic Error → `restStatus: 'failed'` with `restDetail` carrying the scrubbed message. **Suggest:** scripted fetch that rejects with `new Error('ECONNREFUSED figd_x')`; assert restStatus 'failed', restDetail does NOT contain raw PAT.

### Wire-up: lmstudio-agentic extraToolHandlers (P1)

- **GAP-7.30 covered** for executeToolCall routing to extra handler, unknown tool → ERROR, extra handler throw → ERROR pass-through, shell_exec still routed correctly when extras present. `lmstudio-agentic.test.ts:1407-1494`. Green for the dispatch contract.
- **GAP-7.31 (P1) Env allow-list is shell_exec-specific — verify Figma handler does NOT bypass it.** `lmstudio-agentic.ts:223` `buildShellExecEnv` is only applied at shell spawn, NOT at Figma fetch. The Figma handler uses node's `fetch` directly with PAT in header — that's correct (figd_ scrubbing covers logs). But there's no test asserting that when Figma is enabled, the shell_exec env allow-list still strips ANTHROPIC_API_KEY. The integration concern: future regression might inject env into Figma handler dispatch context, breaking the per-tool isolation. **Suggest:** dispatch a shell_exec AFTER a figma_list_layers in the same loop; assert env allow-list still applies to the shell process. Reuses `:1333-1400` pattern with mixed tool sequence.
- **GAP-7.32 (P2) Malformed JSON in figma handler arguments.** `lmstudio-agentic.ts:339-344` catches JSON.parse failure and returns 'ERROR: arguments not valid JSON'. Test for shell_exec covered at `:1289-1306` (similar branch); no test for Figma branch. **Suggest:** call executeToolCall with `name: 'figma_list_layers', arguments: 'not json{'` and a fake handler → returns ERROR message; handler NEVER invoked.
- **GAP-7.33 (P2) Non-Error throw from extra handler.** `lmstudio-agentic.ts:352` String(err) cast for non-Error throws. No test forces a non-Error throw (e.g., handler throws a string or object literal). **Suggest:** handler that throws `'string error'`; assert content === `'ERROR: string error'`.
- **GAP-7.34 (P1) Wire-up at cmd-run.ts NOT tested.** `cmd-run.ts:83-101` (runner construction) AND `:131-144` (tools[] composition) are the two integration points. Neither has an end-to-end test that asserts: (a) `FIGMA_API_TOKEN=figd_x` env → cmd-run constructs LmStudioAgenticRunner with extraToolHandlers AND DEFAULT_AGENTIC_TOOLS gets figma tool defs appended; (b) no env → no extras, no figma defs in tools[]. The handler-dispatch tests at `lmstudio-agentic.test.ts:1407-1494` exercise the unit-level dispatch but not the env-gated end-to-end wire-up. **Suggest:** integration test using `executeRunCommand` (or `cli(['run', ...])`) with `FIGMA_API_TOKEN=figd_test`; stub LmStudioAgenticRunner.prototype.run; assert constructor received extraToolHandlers AND tools[] includes figma_list_layers/figma_update_token. Without this, a refactor that drops the wire-up at `cmd-run.ts:90` would silently disable Figma in prod — both Phase 7 unit tests pass and the regression is invisible.

### redaction.ts figma_pat (P2)

- **GAP-7.35 covered** for single figd_ + multi figd_ + pattern registered. Green.
- **GAP-7.36 (P2) figd_ pattern interaction with `Bearer` pattern.** `redaction.ts:9` matches `Bearer\s+[A-Za-z0-9...]+`. If a log line says `Bearer figd_xxx`, the bearer pattern fires first and yields `Bearer [REDACTED]` — figma_pat is never reached because the figd_ portion is already replaced. Acceptable but not tested. **Suggest:** `redactSecrets('Bearer figd_x')` → assert output does NOT contain `figd_x` (either redacted form is acceptable; the test pins the no-leak invariant regardless of which pattern wins).

---

## Summary

| Phase | P1 gaps | P2 gaps | P3 gaps | Total |
|-------|---------|---------|---------|-------|
| 5     | 4       | 14      | 4       | 22    |
| 7     | 3       | 18      | 7       | 28    |

**Top priorities to fill before next milestone:**
1. **GAP-5.3** — transaction-rollback atomicity claim never asserted (PITFALL 3.2 promise)
2. **GAP-5.9** — workdir-leak runtime regression (only static grep guard, no behavioral counterpart)
3. **GAP-5.15** — annotation render after failure-first reorder (central two-pass correctness gap)
4. **GAP-5.18** — write-time cosine gate integration test impossible due to scheduleEmbed timing (either fix or formally mark "unit-only")
5. **GAP-7.34** — Figma wire-up at `cmd-run.ts:83-144` is end-to-end untested; silent disable is the failure mode
6. **GAP-7.31** — env allow-list still strips secrets when Figma handlers are active (defense-in-depth integration)

**Phase 5 has higher P1 density (4 vs 3) because three of them touch atomicity/isolation contracts** — claims in comments and PITFALL files that no test would catch if violated. The grep guard at `conflict-workdir-isolation.test.ts:81-110` is a strong defense but doesn't substitute for behavioural assertions.

**Phase 7's coverage is unusually thorough at the unit level (8/8 PAT loader, 9+ rest-client, 6/6 doctor, 6/6 registry).** The remaining P1s are integration-level — the wire-up at `cmd-run.ts` and the cross-tool env-isolation guarantee. The codebase reads as if the test author optimized for unit purity and assumed integration would catch up; it didn't.
