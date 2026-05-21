# Coverage Delta — Phase 3 (lmstudio-agentic) + Phase 4 (embeddings wire-up)

**Baseline:** no `COVERAGE-GAPS.md` found at `.planning/`. Audit performed from scratch against Phase 3 + Phase 4 source + tests merged to `main`.
**Audited paths:** `src/workers/lmstudio-agentic{.ts,.test.ts}`, `src/memory/{semantic-similarities,memory-store,memory-engine}.ts` + 4 Phase-4 test files, `src/tools/{recall,memory_search}.ts` + `recall-embed.test.ts`, `src/cli/{cmd-run,cmd-parallel}.ts`, `src/cli.ts`.
**Method:** read implementation, mapped behavior → tests; gaps = behaviors with no failing-on-regression test.

Severity: **P1** = silent prod bug or security/contract breach; **P2** = real but bounded failure; **P3** = nice-to-have.

---

## Phase 3 — lmstudio-agentic

### Tool loop (P1/P2)

- **GAP-3.1 (P2) Loop iterations 4-19 untested.** `lmstudio-agentic.test.ts:512-528` covers iter=20 cap, `:488-510` covers iter=2, `:474-486` covers iter=1. Iter 3-19 with mix of tool calls + final never exercised. **Suggest:** test iter=5 (3 tool calls + final at 4) verifies messages[] grows monotonically and no early termination.
- **GAP-3.2 (P3) Hash-loop abort already covered.** `:644-664` and `:685-704` — green.

### shell_exec (P1/P2/P3)

- **GAP-3.3 (P2) Non-zero exit_code untested.** `lmstudio-agentic.ts:198-202` derives exit_code from err.code. `:355-365` only asserts the zod error on empty command; no test asserts exit_code 1 / 127 / signal-derived rendering in `formatShellResult`. **Suggest:** stub `shellExec` → `{stdout:'', stderr:'cmd: not found', exitCode: 127}`; assert content matches `EXIT: 127`.
- **GAP-3.4 (P2) stderr-only path untested.** `formatShellResult` (`:242-246`) interpolates both streams. Test at `:274-289` stubs `stdout='hi\n'` only; no test where `stderr` non-empty AND `stdout` empty. **Suggest:** stub `{stdout:'', stderr:'warn: deprecated\n', exitCode:0}`; assert `STDERR:\nwarn:` segment present.
- **GAP-3.5 (P2) Real `defaultShellExec` execFile path zero tests.** `:189-220` only ever exercised through injection stub. Timeout (30s in execFile opts), `maxBuffer: 64KB`, and the EXEC stderr-as-Buffer branch (`:213-216`) are dead in test coverage. **Suggest:** integration test using `defaultShellExec` directly with `command:'sleep 0.05 && echo ok'` and `command:'cat /dev/urandom | head -c 100000'` (overflows maxBuffer).
- **GAP-3.6 (P2) Missing command (ENOENT) untested.** No test forces an execFile ENOENT. **Suggest:** real `defaultShellExec` with `command:'__definitely_no_such_bin_xyz'`; assert `exitCode === 1` (err && !err.code path, `:200-202`) and stderr surfaces the message.
- **GAP-3.7 (P3) cwd outside workdir.** Test `:305-315` covers MODEL-emitted cwd being dropped. There is no test where a malicious `..`/`/etc` is requested AND the executor receives it (which it can't — schema strips via passthrough). State of test: green for design intent. No fix needed unless schema policy changes.
- **GAP-3.8 (P3) 32KB stderr truncation untested.** `:317-335` covers stdout truncation only. `formatShellResult` calls `truncateBytes` for BOTH streams (`:243-244`). **Suggest:** stub stderr=50KB, assert `STDERR:` segment includes `…[TRUNCATED:` marker.
- **GAP-3.9 (P2) Multibyte truncation boundary.** `:226-236` `truncateBytes` slices the UTF-8 buffer mid-codepoint and accepts U+FFFD per comment. No test asserts behavior for 32768th byte landing inside a 4-byte emoji. **Suggest:** stdout = `'A'.repeat(32766) + '🎯'`; assert no throw and marker present.

### Tool errors (P1/P2)

- **GAP-3.10 (P2) Unknown tool name covered** — `:249-260` green.
- **GAP-3.11 (P2) Malformed JSON args covered** — `:262-272` green.
- **GAP-3.12 (P1) Tool execution throw untested at the wrapper level.** `executeToolCall` `:287-293` catches throws from `executeShellExec`. The schema reject path is tested (`:359-365`) but the inner `shellExec` rejection — e.g., spawn EACCES — is not. **Suggest:** inject `shellExec = async () => { throw new Error('spawn EACCES'); }`; call `executeToolCall`; assert returned `ToolCallMessage` has `content: 'ERROR: spawn EACCES'`, `tool_call_id` echoed.
- **GAP-3.13 (P2) ToolCall id missing.** `:601-609` synthesizes `__missing__` sentinel for empty id. Covered by `:1204-1242`. **`tc.id` set to non-string (e.g., number)** — `typeof tc.id !== 'string'` guard fires. No test asserts this branch.

### LFM2 nudge (P2)

- **GAP-3.14 covered** — `:190-210` covers positive (lfm2 prefix), negative (qwen/gpt-oss/empty/undefined), case-insensitive, mixed-context integration (`:734-801`).

### Capability probe (P1/P2)

- **GAP-3.15 (P2) /v1/models 200 with capabilities array covered** — `:1059-1095` green.
- **GAP-3.16 (P2) /v1/models 200 without capabilities + /api/v0/models fallback success not tested.** `lmstudio-agentic.ts:351-360, 377-388` aggregate capabilities across both endpoints. Test `:1118-1134` covers BOTH endpoints lacking capabilities (fail-closed), but the **happy fallback** (`v1` no caps, `v0` has `tool_use`) is uncovered. **Suggest:** scripted fetch returns `v1` with `{id,object}` only, `v0` with `{id,capabilities:['tool_use']}`; assert `status==='success'` and chat POST fired.
- **GAP-3.17 (P2) /v1/models 404 fallback to /api/v0/models success not tested.** When `/v1/models` returns HTTP 404 (not "not loaded" but truly missing endpoint), `needV0Fallback` fires per `:354-358`. Currently no test forces v1 → 404 with v0 → 200. **Suggest:** scripted fetch with v1 → `{kind:'status',status:404}` analog inside `fetchCapsAt`, v0 → 200 with `tool_use`.
- **GAP-3.18 (P2) Both endpoints unreachable → PROVIDER_ERROR retryable** untested. `:362-365`. Only single-endpoint network failures via `fetchCapsAt` exist implicitly. **Suggest:** scripted fetch throws `new Error('ECONNREFUSED')` for BOTH `/v1/models` AND `/api/v0/models`; assert `error.code==='PROVIDER_ERROR'`, `retryable===true`.
- **GAP-3.19 (P2) Probe AbortSignal timeout.** `:329-335` passes `signal` to fetch. No test verifies abort fires when `task.timeout_ms` elapses DURING the probe (vs during chat). **Suggest:** scripted fetch for `/v1/models` returns `{kind:'never'}` analog; assert `status==='timeout'` with `timeout_ms:50`.

### Dispatch (P1/P2)

- **GAP-3.20 (P2) cmd-run runtime dispatch tested only via source-regex** — `lmstudio-agentic.test.ts:817-822, 871-875`. Regex assertion is brittle to refactor (rename `HTTP_PROVIDERS` → fails); no runtime test invokes `executeRunCommand` with `provider:'lmstudio-agentic'` and asserts the `LmStudioAgenticRunner` was instantiated and called. **Suggest:** hermetic test that imports `executeRunCommand`, stubs `LmStudioAgenticRunner.prototype.run`, asserts the stub fires.
- **GAP-3.21 (P2) cli.ts top-level validator covered** by `:883-888` (regex match against the exact array literal — brittle to whitespace/ordering changes). **Suggest:** runtime test that calls `cli(['run','--provider','bogus','--model','x','--task','y'])` and asserts stderr "unsupported --provider: bogus".

---

## Phase 4 — embeddings wire-up

### queueMicrotask race (P1)

- **GAP-4.1 (P1) Row deleted between INSERT and UPDATE.** `memory-store.ts:284,317-322` claim "best-effort: silent no-op if row deleted". `memory-store-embed.test.ts` has no test that forgets/wipes a row WHILE the microtask is in-flight. **Suggest:** mock `embedClient` returns delayed Promise; between `remember()` and microtask resolution, call `store.forget(id, {hard:true})`; assert no throw, no row.
- **GAP-4.2 (P1) Failure DURING write (`updateEmbedding` throws).** `memory-store.ts:298-301` catches via inner try/catch. The throw path (e.g., SQLITE_BUSY) has no test. **Suggest:** stub `db.prepare(UPDATE).run` to throw once; assert process does not crash and row stays NULL.
- **GAP-4.3 (P2) Microtask after `closeDb()`.** Tests `closeDb()` in afterEach. If a microtask is in flight when DB closes, `updateEmbedding` will fail. Test isolation correctness — currently no assertion that pending microtasks are awaited / drained before close. **Suggest:** call `remember()`, immediately `closeDb()`, run microtasks; assert no unhandled promise rejection (`process.on('unhandledRejection')`).

### Cosine (P2)

- **GAP-4.4 covered** — `semantic-similarities.test.ts:121-164` tests 1.0, 0.0, -1.0, non-unit, zero-magnitude (NaN-safe). Green.
- **GAP-4.5 (P3) NaN/Infinity input to `cosineSimNormalized`.** A blob with `Infinity` or `NaN` floats would produce NaN. `:99` only guards zero-magnitude. **Suggest:** `a=[NaN,0,0], b=[1,0,0]`; assert finite result (current impl returns NaN — possible P2 if untrusted blobs reach this).

### embedding_model column (P1)

- **GAP-4.6 covered** for cross-model rejection in `semantic-similarities.test.ts:288-310`. `recall-embed.test.ts:270-353` covers end-to-end cross-model. Green.
- **GAP-4.7 (P2) embedding_model written by `updateEmbedding` is the env at UPDATE time, not at INSERT.** `memory-store.ts:298` reads `model` from `scheduleEmbed` closure (`model = process.env['RELAY_EMBEDDING_MODEL']` at line 287). If env changes between `remember()` and microtask resolution, the closure wins — undocumented invariant. **Suggest:** test: set env=A, call `remember()`, change env=B, flush microtasks; assert `getRawEmbedding(id).model === 'A'`. Lock the contract.

### Backward compat (P2)

- **GAP-4.8 covered** — `recall-embed.test.ts:114-147` exercises NULL `embedding_blob` rows via word-overlap, no errors. Green.
- **GAP-4.9 (P2) Mixed corpus: SOME rows with embedding, SOME NULL, RELAY_EMBEDDING_MODEL set.** `semantic-similarities.test.ts:253-286` tests this for the helper, but no test exercises the FULL `handleRecall` path with mixed-embedding corpus AND asserts the embedded rows score higher than the NULL ones for a zero-overlap query. **Suggest:** 2 embedded rows + 2 NULL rows, query with zero overlap; assert embedded rows rank above NULL.

### Wire-up paths (P1)

- **GAP-4.10 (P1) `cmd-tui.ts:89` calls `budgetedRecall` WITHOUT similarities.** `budgetedRecall(candidates, query, Date.now())` — no 4th arg. TUI memory pane silently uses word-overlap only even when `RELAY_EMBEDDING_MODEL` is set. **Either a bug or an intentional omission** — no comment explaining. **Suggest:** test asserts TUI uses similarities (would fail today → implementation bug → ESCALATE) OR add a comment justifying the omission and a test pinning the behavior.
- **GAP-4.11 (P1) `src/context/layers.ts:231` calls `budgetedRecall` WITHOUT similarities.** This is the SessionStart context-emit path — agents reading via `relay context-emit` get word-overlap only. **High impact: this is the primary consumer of semantic recall in agent loops.** **Suggest:** wire `computeSemanticSimilarities` into `layers.ts:218-231`; failing test for current behavior to pin the regression.
- **GAP-4.12 (P2) `cmd-memory-ops.ts:54-55` → `handleRecall` is wired, covered transitively by `recall-embed.test.ts`.** Green via T6 wire-up.
- **GAP-4.13 (P2) `cmd-verify.ts:85-96` → `handleRecall` is wired, covered transitively.** Green.

### Migration (P1)

- **GAP-4.14 (P1) Idempotent re-run covered** — `embeddings-migration.test.ts:61-74, 186-200`. Green for both `embedding_blob` and `embedding_model`.
- **GAP-4.15 (P2) Existing data preserved across migration not directly tested.** Both migration tests start with `:memory:` DB. No test seeds a v0.1.x DB with rows, runs migrate, asserts the existing rows are intact with NULL embedding columns. **Suggest:** use the `__fixtures__/v0.1.2-baseline.db` fixture; copy, migrate, assert all original rows readable with `embedding_blob=NULL, embedding_model=NULL`.
- **GAP-4.16 (P2) Migration order under partial-failure unspecified.** `migrateMemoryTables` is called multiple times (`db-migrations.ts`). If column-add succeeds but DDL trigger creation fails, no rollback semantics tested. **Suggest:** mock `db.exec` to throw on second call; verify added column persists OR fully rolls back. Likely fine but unverified.

---

## Summary
| Phase | P1 gaps | P2 gaps | P3 gaps | Total |
|-------|---------|---------|---------|-------|
| 3     | 1       | 12      | 4       | 17    |
| 4     | 4       | 8       | 1       | 13    |

**Top priorities to fill before next milestone:**
1. **GAP-4.10 / 4.11** — TUI + context-emit wire-up gaps (likely IMPLEMENTATION BUGS, not test gaps; ESCALATE)
2. **GAP-4.1 / 4.2** — queueMicrotask race + UPDATE-throw paths (claimed in comments, not asserted)
3. **GAP-3.12** — `executeToolCall` swallows inner shellExec throws (claimed, not tested)
4. **GAP-3.16 / 3.17** — capability-probe fallback happy paths (only failure paths tested)
5. **GAP-3.5 / 3.6** — real `defaultShellExec` zero coverage; ENOENT path is the only way to assert the err-without-code branch
