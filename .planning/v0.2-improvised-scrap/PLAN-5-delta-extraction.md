# PLAN-5 — Delta Extraction in Auto-Extract (ROADMAP §6)

**Status:** Ready to implement
**Depends on:** ROADMAP §4 (conflict detection) — design contract from `.planning/v0.2/DELTA-MEM-CONFLICT.md`. **PLAN-3 (conflict-detection) does NOT yet exist** at `.planning/v0.2/`; this plan is implementable independently against the documented contract — emit-only contradiction flags now, wire to `conflicts_with_json` reciprocal column once §4 ships.
**Constraints:** NO Codex. TDD strict (RED → GREEN → REFACTOR per task). LM Studio call reuses `extractLessonsViaLmStudio` client.

---

## Goal

Before LM Studio extraction, load currently-recalled memories for the workdir and prepend them to the T10 prompt as known-state. Model is instructed to extract only what the transcript **ADDS, CONTRADICTS, or REFINES**. Contradictions surface as a new `memory_source` value (`delta-contradiction`) on emitted lessons; once PLAN-3 ships, the same flag triggers the reciprocal `conflicts_with_json` write.

**Non-goals:** Embedding-based ranking of existing memories (deferred to §5/embeddings). Auto-resolution of contradictions (handled by §4). Changing how the model formats `lessons[]` JSON output (additive only).

---

## Files to touch

| File | Change |
|---|---|
| `src/memory/auto-extract-runner.ts` | Extend `PROMPT_TEMPLATE` `:46-54` with `<<<EXISTING>>>` block. Change `buildPrompt(transcript)` `:65` → `buildPrompt(transcript, existing)`. Extend `ExtractionOptions` `:33-38` with `existingMemories?: readonly Memory[]`. Thread through `extractLessonsViaLmStudio` `:222` → call site `:246`. |
| `src/memory/auto-extract-transcript.ts` | Pipe `existingMemories` through any options-builder helper (verify shape; only touch if it owns `ExtractionOptions` assembly — likely it does not, but call site lives downstream of redaction pipeline). |
| `src/cli/cmd-memory-auto-extract.ts` | Before `extract({…})` at `:405-411`, call `new MemoryStore().getCandidates({ workdir: payload.value.cwd, token_budget: 2_000 })` and pass result through. Wire dependency-injection seam (`deps.loadExistingMemories?`) for tests. |
| `src/memory/auto-extract-validator.ts` (or wherever `cleanupAndValidate` `:439` lives) | Detect optional `delta_contradicts: string[]` field on each emitted lesson; map to `memory_source='delta-contradiction'` when persisted downstream. Schema-level only; persistence happens at the existing recorder. |
| `src/memory/auto-extract-runner.test.ts` (NEW) | Unit tests for `buildPrompt` signature + template injection. |
| `src/cli/cmd-memory-auto-extract.test.ts` (extend) | Integration tests T5 + T6 below. |

**Out of scope for this plan:** `MemoryStore.remember()` changes (handled by PLAN-3). `conflicts_with_json` column write-back (handled by PLAN-3). Type changes to `Memory` interface (no new fields required here).

---

## Task breakdown (TDD strict — write test, run, see RED, implement, see GREEN, refactor)

### T1 — `buildPrompt` signature change (RED → GREEN)
- **Test (RED):** `auto-extract-runner.test.ts` — `buildPrompt('transcript', [])` returns the existing template unchanged (backward-compat baseline). `buildPrompt('transcript', [mem1, mem2])` contains both `mem1.content` and `mem2.content` between the `Output STRICTLY` line and the `Transcript:` line.
- **Implementation:** Change signature `:65` to `function buildPrompt(transcript: string, existing: readonly Memory[]): string`. When `existing.length === 0`, replace `<<<EXISTING>>>` with empty string (so template collapses to current shape — backward compat). When non-empty, format as numbered list capped at 50 entries (defensive against pathological cases — the call site already caps via `token_budget`).
- **Done when:** Test passes; existing 972 tests still pass (no other call site of `buildPrompt` — it's module-private).

### T2 — T10 template extension (RED → GREEN)
- **Test (RED):** `auto-extract-runner.test.ts` — given 3 existing memories, the rendered prompt contains the literal string `Extract only what the transcript ADDS, CONTRADICTS, or REFINES`, `Flag contradictions explicitly`, and `Do not re-extract known patterns`. The output-schema directive on `:51` is unmodified.
- **Implementation:** Extend `PROMPT_TEMPLATE` at `:46-54`. New shape:
  ```
  [lines 1-5 unchanged — role + extraction rules + output schema]
  + 'For each lesson, you MAY include "delta_contradicts": ["<verbatim quote from Existing known patterns>"] when the transcript contradicts a known pattern.'
  + ''
  + 'Existing known patterns:'
  + '<<<EXISTING>>>'
  + ''
  + 'New transcript:'
  + '<<<TRANSCRIPT>>>'
  + ''
  + 'Extract only what the transcript ADDS, CONTRADICTS, or REFINES relative to what is already known. Flag contradictions explicitly via "delta_contradicts". Do not re-extract known patterns.'
  ```
  Replace `Transcript:` line `:52` accordingly. Keep template inline (per `:42-44` comment — semantics change = code review).
- **Done when:** Prompt format snapshot test passes; template still renders deterministically (no clock/random injection).

### T3 — Call-site wiring in `cmd-memory-auto-extract.ts` (RED → GREEN)
- **Test (RED):** `cmd-memory-auto-extract.test.ts` — extend the existing happy-path test with a `deps.loadExistingMemories` mock returning `[fakeMem]`; assert the `deps.extractLessons` mock is invoked with `existingMemories: [fakeMem]`. Without the mock (or returning `[]`), assert backward-compatible behavior — `existingMemories: []` is passed.
- **Implementation:**
  - Add `loadExistingMemories?: (workdir: string) => Promise<readonly Memory[]>` to the `Deps` shape this file already uses for DI (search for `deps.extractLessons` pattern at `:405`).
  - Default impl: `async (workdir) => new MemoryStore().getCandidates({ workdir, token_budget: 2_000 })` — token budget is small because we only need top-K, not all.
  - Insert call BEFORE `extract({…})` at `:406`. Wrap in `try/catch` — failure to load existing memories must NOT break extraction. On error, log via the existing audit emit channel (status stays `ok`; emit a `note: 'existing-memories-load-failed: <err>'`) and pass `existingMemories: []`.
- **Done when:** Integration test passes; no existing test regresses.

### T4 — Parse contradiction flags into `memory_source='delta-contradiction'` (RED → GREEN)
- **Test (RED):** Locate the validator/cleanup module (probably `src/memory/auto-extract-cleanup.ts` per the import pattern at `cmd-memory-auto-extract.ts:439` — verify in implementation). Add test: input JSON `{"lessons":[{"content":"use camelCase","memory_type":"lesson","confidence":0.9,"delta_contradicts":["use kebab-case"]}]}` → validated output preserves `delta_contradicts` array on the lesson record AND maps to `memory_source='delta-contradiction'` when the downstream recorder serializes it.
- **Implementation:**
  - Extend the Zod schema (T11, downstream of T10) to accept optional `delta_contradicts: z.array(z.string()).max(5).optional()`.
  - In the recorder that writes the lesson (likely in `cmd-memory-auto-extract.ts` after `cleanup.ok` branch around `:460-500` — verify file:line during implementation), pass `memory_source: 'delta-contradiction'` to `MemoryStore.remember()` when `delta_contradicts` is non-empty; else default `memory_source: 'auto-extract'`.
  - **Type contract:** This requires `MemorySource` (`src/memory/types.ts:11`) to gain `'delta-contradiction'` as a union member. Currently: `'human' | 'auto-run-recorder' | 'worker-mcp' | 'unknown'` per MEMORY-MAP. Add it.
  - Store the raw contradicted quotes in the new memory's `sources` array (existing `sources_json` column) as `[ 'delta-contradicts:<sha256(quote)>' ]` for later PLAN-3 wiring to convert into `conflicts_with_json` memory_id references.
- **Done when:** Test passes; `MemorySource` exhaustiveness checks (if any in `computeTrustLevel` at `memory-store.ts:31`) still pass.

### T5 — Integration test: known patterns NOT re-extracted (RED → GREEN)
- **Test (RED):** `cmd-memory-auto-extract.test.ts` integration block.
  - Pre-seed `MemoryStore` with 3 memories (workdir-scoped): `"use kebab-case for CSS class names"`, `"prefer flexbox over float for centering"`, `"docker compose for local dev, not docker run"`.
  - Build a transcript that re-states all 3 in slightly varied wording.
  - Mock LM Studio (`deps.extractLessons`) to inspect the prompt: assert all 3 existing patterns appear in `Existing known patterns:` section.
  - Return a deterministic mock LM response: `{"lessons":[]}` (model correctly suppresses re-extraction).
  - **Assert:** zero new memories created; existing 3 untouched.
- **Implementation:** No production code change beyond T1–T4. This test validates the *system contract*, not new behavior. If it fails, the failure points back to T1–T4.
- **Done when:** Test passes; documented as the "no-re-extraction" regression guard.

### T6 — Integration test: contradiction flag propagates (RED → GREEN)
- **Test (RED):** Same harness as T5.
  - Pre-seed 1 memory: `"use kebab-case for CSS class names"`.
  - Transcript: a discussion concluding `"team switched to camelCase for CSS modules"`.
  - Mock LM response: `{"lessons":[{"content":"use camelCase for CSS classes","memory_type":"lesson","confidence":0.95,"delta_contradicts":["use kebab-case for CSS class names"]}]}`.
  - **Assert:** 1 new memory created; its `memory_source === 'delta-contradiction'`; its `sources` array contains a `delta-contradicts:` prefixed entry; the original kebab-case memory is **unchanged** (PLAN-3 owns reciprocal write).
- **Done when:** Test passes. Add `// PLAN-3 will extend this to also assert conflicts_with_json on both rows` as a forward comment.

---

## Acceptance criteria

1. All existing 972 tests pass (`npm test`). Verified via `npm test 2>&1 | tail -20`.
2. New tests T1, T2, T3, T4, T5, T6 all pass.
3. Re-extraction noise drops: T5 demonstrates 0 duplicates emitted when transcript restates all known patterns. Before this plan, the same input produces ≥1 duplicate.
4. Backward compat: `buildPrompt(transcript, [])` produces a prompt structurally equivalent to today's (same instructions, no `Existing known patterns:` block when empty). Verified by T1 baseline test.
5. `MemorySource` union extended; no exhaustiveness check anywhere in `src/` breaks (verify via `tsc --noEmit`).
6. Contradiction quotes preserved as `sources` entries — auditable now, machine-actionable once PLAN-3 lands.

---

## Runtime validation

After implementation, run end-to-end against real LM Studio (qwen3-coder per `feedback_lmstudio_routing`):

```bash
# Setup
TMPWD=$(mktemp -d)
cd "$TMPWD"
relay memory remember --content "use kebab-case for CSS class names" --type lesson --workdir "$TMPWD"
relay memory remember --content "prefer flexbox over float" --type lesson --workdir "$TMPWD"
relay memory remember --content "docker compose for local dev" --type lesson --workdir "$TMPWD"

# Run auto-extract on a synthetic transcript restating these
cat > /tmp/relay-test-transcript.txt <<'EOF'
[user] How should I name my CSS classes?
[assistant] We use kebab-case for CSS class names in this codebase.
[user] And for centering layouts?
[assistant] Flexbox is the preferred approach over float.
EOF
relay memory auto-extract --window 32k --transcript-file /tmp/relay-test-transcript.txt --workdir "$TMPWD"

# Verify no duplicates
relay memory list --workdir "$TMPWD" --json | jq '.[].content' | sort | uniq -c | awk '$1 > 1 { print "DUPLICATE:", $0; exit 1 }'

# Now run with a contradiction
cat > /tmp/relay-test-contradict.txt <<'EOF'
[user] We've decided to switch CSS naming.
[assistant] Confirmed — moving to camelCase for all new CSS modules going forward.
EOF
relay memory auto-extract --window 32k --transcript-file /tmp/relay-test-contradict.txt --workdir "$TMPWD"

# Assert: new memory with memory_source=delta-contradiction
relay memory list --workdir "$TMPWD" --json | jq '.[] | select(.memory_source == "delta-contradiction")' | grep -q camelCase || { echo "FAIL: contradiction not flagged"; exit 1; }
```

**Pass condition:** Both `jq` assertions exit 0.

If `relay memory auto-extract` does not yet accept `--transcript-file`, substitute by piping via the existing payload contract (verify the flag during implementation).

---

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Model ignores `Do not re-extract` instruction (qwen3-coder paraphrases known patterns anyway) | MEDIUM | Measure recall@k on a 10-transcript labeled corpus before/after. If duplicate rate > 20%, add a post-extraction dedup filter: drop emitted `lessons[]` entries whose normalized content (lowercase + strip punctuation + token-set comparison) has Jaccard ≥ 0.7 against any `existingMemories` entry. Land as T7 if needed. |
| Existing memory set blows token budget (>2k tokens for the `Existing known patterns:` block) | MEDIUM | Cap at `token_budget: 2_000` in `MemoryStore.getCandidates` call (T3). `budgetedRecall` already enforces this (`memory-engine.ts:215-222`). If even capped output is too verbose, also truncate each memory's content to 200 chars (the existing T10 directive at `:50` already caps emissions at 200 chars — symmetric). |
| Contradiction parsing brittle if model varies output format (e.g. emits `"contradicts": [...]` instead of `"delta_contradicts": [...]`) | MEDIUM | Zod schema in T4 makes `delta_contradicts` optional with a strict key name. If the model emits the wrong key, the field is silently dropped — fail-safe (lesson still emits, just without contradiction flag). Optionally: if LM Studio supports OpenAI `response_format: { type: 'json_schema', json_schema: {…} }`, use it to enforce the schema server-side. Verify support via LMSTUDIO-TOOL-API.md research artifact at `.planning/v0.2/`. If supported, add as T7. |
| Forgotten `MemorySource` union extension breaks `computeTrustLevel` switch at `memory-store.ts:31` or any exhaustive check | LOW | `tsc --noEmit` in CI catches this. T4 explicitly verifies. |
| Race condition: `getCandidates` reads stale state when another `relay` process is mid-write to the same DB | LOW | SQLite WAL mode handles this; reads see last committed state. Acceptable — auto-extract is best-effort, not transactional with concurrent writes. |
| Performance: extra `getCandidates` call adds ~10-50ms per `auto-extract` invocation | LOW | Acceptable — auto-extract is async, already takes 1-30s for the LM Studio call itself. |

---

## Sequencing note

This plan is **implementable now**, before PLAN-3 (conflict detection) lands. Outputs degrade gracefully:
- Today: `memory_source='delta-contradiction'` rows accumulate; `sources` array preserves contradicted quotes; no reciprocal write to old memory.
- After PLAN-3 ships: A post-hoc migration can convert `sources` entries with the `delta-contradicts:<sha>` prefix into `conflicts_with_json` `memory_id` references by resolving the quote against current store content. Or PLAN-3's `remember()` interception handles new writes inline.

Either way, PLAN-5 produces non-throwaway artifacts.
