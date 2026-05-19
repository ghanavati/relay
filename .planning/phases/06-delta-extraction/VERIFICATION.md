# Phase 6 Plan Verification — Delta Extraction

**Verdict:** PASSED with 2 warnings (both non-blocking).

Plan 06-01 covers all four DELTA REQ-IDs, preserves backward compatibility via byte-equal legacy path, formalizes the hook-exit-0 invariant via queue-and-detach, and gates the Phase 5 dependency through a PRAGMA probe so Phase 6 ships independently. Execution can proceed.

## Coverage Matrix — ROADMAP Phase 6 Success Criteria

| SC | Roadmap claim | Plan task(s) | Evidence |
|----|---------------|--------------|----------|
| SC-1 | Workdir with 50 memories → "Existing known patterns" block injected, zero re-extracted duplicates | T2, T4, T7 Test 1 | T4 slices to 50 (DELTA-02); T2 builds block; T7 asserts count unchanged |
| SC-2 | Contradictions → `memory_source='delta-contradiction'`, propagate into `conflicts_with_json` | T1, T8 Tests 1+3 | T1 extends union; T8 Test 1 asserts source; T8 Test 3 `skipIf` gates Phase 5 |
| SC-3 | Clean workdir → structurally-equivalent prompt to pre-DELTA | T2 Test 1 (byte-equal), T7 Test 3 (fixture compare) | Byte-equal invariant locked at unit + integration levels |
| SC-4 | `getCandidates(workdir, limit=50, tokenBudget=2000)` exactly once before `buildPrompt()` | T4 Test 1 | Spy on `deps.memoryStore.getCandidates` asserts single call |

## REQ-ID Coverage (DELTA-01..04)

| REQ-ID | Plan section | Status |
|--------|--------------|--------|
| DELTA-01 (buildPrompt accepts existingMemories, T10 template injects block) | T2 action steps 2-6 | COVERED |
| DELTA-02 (getCandidates limit=50 tokenBudget=2000 before buildPrompt) | T4 action step 2 (`token_budget: 2000`) + slice(0, 50) | COVERED |
| DELTA-03 ('delta-contradiction' MemorySource value) | T1 union extension + T8 Test 1 write-time assertion | COVERED |
| DELTA-04 (backward compat — empty existingMemories collapses) | T2 Test 1 byte-equal + T7 Test 3 fixture compare | COVERED |

All 4 DELTA REQ-IDs appear in the plan frontmatter `requirements: [DELTA-01, DELTA-02, DELTA-03, DELTA-04]` and each has at least one test enforcing it.

## Risk Coverage

| Risk requested | Plan coverage |
|----------------|---------------|
| Model ignores "extract only deltas" instruction | Risk register row 1 + T7 Test 1; mitigation cites content_hash 60s dedup at memory-store.ts:296-302 |
| Prompt-size overflow on large workdirs | Risk register row 2 + T5 (pre-flight `error:prompt-too-large` at 80% contextLimit) |
| Hook blocks CC when LM Studio slow | Risk register row 3 + T6 (`RELAY_AUTO_EXTRACT_DETACH=1` queue-and-detach, 5s budget test, top-level try/catch returns exit 0) |
| Format-drift on `delta-contradiction` literal | Risk register row 4 + recommendation to lock string in constants module if T1 reveals churn |

All four explicitly requested risks are in the register with mitigation + verifying test.

## Hook-Non-Blocking Check (CC.2 invariant)

Plan formalizes the exit-0 contract at multiple layers:
- **T4 step 6:** "every error/skipped path still returns exit 0 (CC.2 invariant)"
- **T5 step 6:** Maps `error:prompt-too-large` → `skipped:prompt-too-large` (skipped:* exits 0)
- **T6 step 4:** Wraps `runMemoryAutoExtract` body in top-level try/catch returning 0
- **T6 Test 4:** Envelope-write failure → `skipped:queue-write-failed` exit 0
- **T6 Test 1:** 5s budget enforcement via Promise.race with fake timers
- **Verification step 5:** `grep -nE "throw new Error" src/cli/cmd-memory-auto-extract.ts` audit — every throw must be inside try/catch returning 0

Berry gate explicitly enforced for delta-contradiction in T8 Test 4 (PRIV-06 invariant — "regardless of memory_source"). Risk register row 6 codifies "do NOT add `if (memory_source === 'delta-contradiction') skipBerry()`".

## Phase 5 Dependency Handling

Plan correctly treats Phase 5 as soft dependency that does NOT block Phase 6 shipping:

1. **PRAGMA probe (T6 step 6):** `hasConflictsWithJsonColumn(db)` runs `PRAGMA table_info(memories)` once, cached. Detects Phase 5 absence at runtime.
2. **No-crash guarantee:** When column absent, runner writes `memory_source='delta-contradiction'` row WITHOUT setting `conflicts_with_json` — no SQL error.
3. **Forward compatibility:** Once Phase 5 ships, Phase 5's `MemoryStore.remember()` CONFLICT-02 detection automatically wires reciprocal `conflicts_with_json` when it sees `memory_source='delta-contradiction'` — no extra Phase 6 code needed.
4. **Test gating (T8 Test 3):** `it.skipIf(!hasConflictsWithJsonColumn(db))` — test auto-skips today, starts passing the moment Phase 5 lands. Closes the dependency loop declaratively.

Verified independently: `grep "conflicts_with_json" src/memory/memory-store.ts` returns 0 matches — Phase 5 has NOT shipped, plan's PRAGMA gate is required.

## Verified Plan Claims (spot-checked against codebase)

| Plan claim | Evidence | Status |
|------------|----------|--------|
| T10 template at auto-extract-runner.ts:46-54 | Lines 46-54 are `PROMPT_TEMPLATE` with `<<<TRANSCRIPT>>>` placeholder | ACCURATE |
| MemorySource at types.ts:11 currently `'human' \| 'auto-run-recorder' \| 'worker-mcp' \| 'unknown'` | Verified verbatim at line 11 | ACCURATE |
| `getCandidates(query: RecallQuery): Memory[]` at memory-store.ts:585 | Confirmed at line 585 | ACCURATE |
| `estimateTokens` exists in memory-engine.ts:18 | Confirmed at line 18 (`(text: string): number`) | ACCURATE |
| Berry call site `checkLessonViaBerry` from `auto-extract-berry.js` | Imported at cmd-memory-auto-extract.ts:61 | ACCURATE |
| `conflicts_with_json` column not yet present | 0 matches in memory-store.ts | ACCURATE (justifies PRAGMA probe) |
| `jaccard` private at memory-store.ts:178 | Actual call sites at 217 and 1260 — definition elsewhere | MINOR INACCURACY (line number off, but fallback plan "inline a 6-line copy" is sound) |

## Gaps (Warnings — Non-Blocking)

**W1 — recall_count bump matcher relies on substring/Jaccard heuristic (T7 Test 2).** Plan acknowledges this with "If this matcher isn't ready, ship a stub that logs the intent and create a TODO; the test asserts the call, not the side-effect, for now." This is acceptable for the integration test gate but the success criterion "Pre-existing patterns re-stated bump recall_count instead of creating duplicates" depends on the model also returning empty `lessons:[]`. If the model re-emits a known pattern, dedup falls to content_hash 60s window at memory-store.ts:296-302 — which IS the real mitigation. Recommend executor leave a clear TODO comment marking the heuristic as best-effort and document the content_hash dedup as the actual safety net.

**W2 — Plan references `jaccard` at memory-store.ts:178 but actual call sites are :217 and :1260.** Line number is off; the function exists but is private. T7 step 2 fallback ("inline a 6-line copy in cmd-memory-auto-extract.ts") sidesteps the issue. Executor should locate the actual `jaccard` definition (likely a local helper) when implementing T7, not trust the line number.

**Neither warning blocks execution.** Both are cosmetic — the plan's escape hatches handle them.

## Summary

8 tasks, 6 files modified, single plan (wave 1, depends on Phase 5 declaratively but gated via PRAGMA probe so it ships independently). All 4 REQ-IDs covered, all 4 SCs traced to tests, all 4 named risks in register with mitigations, hook-exit-0 invariant locked at 5 separate enforcement points, Berry gate explicitly preserved for delta-contradiction rows. Backward compat invariant (`buildPrompt(transcript, [])` byte-equals legacy) defended at unit + integration levels.

Recommend proceeding with `/gsd-execute-phase 06`.
