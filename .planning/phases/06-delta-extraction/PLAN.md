---
phase: 06-delta-extraction
plan: 01
type: tdd
wave: 1
depends_on: [05-conflict-detection]
files_modified:
  - src/memory/types.ts
  - src/memory/auto-extract-runner.ts
  - src/memory/auto-extract-runner.test.ts
  - src/cli/cmd-memory-auto-extract.ts
  - src/cli/cmd-memory-auto-extract.test.ts
  - src/cli/cmd-memory-auto-extract.integration.test.ts
autonomous: true
requirements: [DELTA-01, DELTA-02, DELTA-03, DELTA-04]
must_haves:
  truths:
    - "Auto-extract on a workdir with existing memories injects them into the T10 prompt under an 'Existing known patterns' block"
    - "Pre-existing patterns re-stated in the transcript bump recall_count/accessed_at on the matching memory instead of creating duplicate entries"
    - "Contradictions surfaced by the model are written with memory_source='delta-contradiction' and (once Phase 5 ships) populate conflicts_with_json on the new memory reciprocally"
    - "buildPrompt(transcript, []) — empty existingMemories — produces a structurally-equivalent prompt to the pre-DELTA baseline (collapsed Existing block) so all current tests still pass"
    - "SessionEnd hook still returns exit 0 within 5s when LM Studio is slow; extraction work is queued to .relay/queue/pending-extraction-*.json instead of blocking the hook"
    - "Prompt-size pre-flight aborts with EXTRACT_PROMPT_TOO_LARGE before dispatch if injected+transcript+template tokens exceed contextLimit * 0.8"
    - "Berry hallucination gate (PRIV-06) still runs on every delta-extracted entry — including delta-contradiction rows — before MemoryStore.remember()"
  artifacts:
    - path: "src/memory/types.ts"
      provides: "MemorySource union extended with 'delta-contradiction'"
      contains: "'delta-contradiction'"
    - path: "src/memory/auto-extract-runner.ts"
      provides: "buildPrompt(transcript, existingMemories) signature + T10 template with Existing known patterns block + pre-flight prompt-size guard"
      exports: ["extractLessonsViaLmStudio", "stripJsonFences", "buildPrompt"]
    - path: "src/memory/auto-extract-runner.test.ts"
      provides: "RED-then-GREEN tests for buildPrompt overloads, prompt-size pre-flight, structural backward-compat with empty existing[]"
    - path: "src/cli/cmd-memory-auto-extract.ts"
      provides: "Calls MemoryStore.getCandidates(workdir, limit=50, tokenBudget=2000) before buildPrompt; queue-and-detach envelope writer; recall_count bump for re-stated patterns"
    - path: "src/cli/cmd-memory-auto-extract.integration.test.ts"
      provides: "No-re-extraction integration test + delta-contradiction propagation integration test"
  key_links:
    - from: "src/cli/cmd-memory-auto-extract.ts"
      to: "MemoryStore.getCandidates(workdir, {limit:50, token_budget:2000})"
      via: "fetched once per run, before extractLessonsViaLmStudio call site at cmd-memory-auto-extract.ts:405-411"
      pattern: "store\\.getCandidates\\(.*workdir"
    - from: "src/memory/auto-extract-runner.ts"
      to: "T10 template at auto-extract-runner.ts:46-54"
      via: "PROMPT_TEMPLATE extended with <<<EXISTING>>> placeholder above 'Transcript:' line; collapsed when existing[] empty"
      pattern: "<<<EXISTING>>>"
    - from: "auto-extract-runner.buildPrompt"
      to: "pre-flight size check"
      via: "tokens(prompt) < contextLimit * 0.8 OR return status:'error:prompt-too-large'"
      pattern: "EXTRACT_PROMPT_TOO_LARGE"
    - from: "cmd-memory-auto-extract.ts (SessionEnd hook)"
      to: ".relay/queue/pending-extraction-{ts}.json"
      via: "queue-and-detach when extraction is slow OR Phase 5 conflict wiring not yet ready"
      pattern: "pending-extraction-.*\\.json"
    - from: "delta-contradiction MemorySource"
      to: "Phase 5 conflicts_with_json column"
      via: "When Phase 5 has shipped, MemoryStore.remember() with memory_source='delta-contradiction' wires the new memory's conflicts_with_json reciprocally to the contradicted existing memory ID"
      pattern: "memory_source.*=.*'delta-contradiction'"
---

<objective>
Teach `auto-extract-runner.ts` to diff a new transcript against the workdir's existing memories so the local LLM extracts only what the transcript ADDS, CONTRADICTS, or REFINES — suppressing re-extraction of known patterns and surfacing contradictions as `memory_source='delta-contradiction'` rows that feed Phase 5's `conflicts_with_json` flow.

Purpose: Replace the current "extract every lesson on every session" pattern with delta semantics so the memory store doesn't grow with duplicates, and so the model sees the existing knowledge before deciding what's novel. Also fixes the hook-blocks-CC failure mode (Pitfall 4.3) by formalising the queue-and-detach pattern that the current hook implements ad-hoc.

Output: T10 template gains an "Existing known patterns" section, `buildPrompt` gains an `existingMemories` parameter, `cmd-memory-auto-extract.ts` prefetches via `MemoryStore.getCandidates`, `MemorySource` gains `'delta-contradiction'`, and a queue-and-detach envelope is written before the LM Studio dispatch so the hook is never blocked. Backward compat preserved — `buildPrompt(transcript, [])` is byte-equivalent to the v0.1 prompt minus a single collapsed empty block.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@/Users/ghanavati/ai-stack/Projects/Relay/.planning/ROADMAP.md
@/Users/ghanavati/ai-stack/Projects/Relay/.planning/REQUIREMENTS.md
@/Users/ghanavati/ai-stack/Projects/Relay/.planning/research/SUMMARY.md
@/Users/ghanavati/ai-stack/Projects/Relay/.planning/research/PITFALLS.md
@/Users/ghanavati/ai-stack/Projects/Relay/.planning/v0.2-improvised-scrap/MEMORY-MAP.md
@/Users/ghanavati/ai-stack/Projects/Relay/src/memory/auto-extract-runner.ts
@/Users/ghanavati/ai-stack/Projects/Relay/src/cli/cmd-memory-auto-extract.ts
@/Users/ghanavati/ai-stack/Projects/Relay/src/memory/types.ts
@/Users/ghanavati/ai-stack/Projects/Relay/src/memory/memory-store.ts

<interfaces>
<!-- Contracts the executor needs. No codebase exploration required. -->

From src/memory/types.ts:11 (CURRENT — must extend):
```typescript
export type MemorySource = 'human' | 'auto-run-recorder' | 'worker-mcp' | 'unknown';
```

After T1: union extended to:
```typescript
export type MemorySource = 'human' | 'auto-run-recorder' | 'worker-mcp' | 'unknown' | 'delta-contradiction';
```

From src/memory/types.ts:55-75 (Memory shape — unchanged by this plan):
```typescript
export interface Memory {
  readonly memory_id: string;
  readonly memory_type: MemoryType;
  readonly content: string;
  readonly tags: readonly string[];
  readonly workdir: string | null;
  readonly memory_source: MemorySource;
  // ... other fields
}
```

From src/memory/auto-extract-runner.ts:33-38 (CURRENT — must extend):
```typescript
export interface ExtractionOptions {
  transcript: string;
  endpoint: string;
  model: string;
  timeoutMs: number;
}
```

After T3: thread existing memories:
```typescript
export interface ExtractionOptions {
  transcript: string;
  endpoint: string;
  model: string;
  timeoutMs: number;
  existingMemories?: readonly Memory[];      // new — default []
  contextLimitTokens?: number;               // new — default 8192, used by pre-flight
}
```

From src/memory/auto-extract-runner.ts:65-67 (CURRENT signature — must extend):
```typescript
function buildPrompt(transcript: string): string;
```

After T2 (export + extend):
```typescript
export function buildPrompt(transcript: string, existingMemories: readonly Memory[] = []): string;
```

From src/memory/auto-extract-runner.ts:19-24 (status union — must extend):
```typescript
export type ExtractionStatus =
  | 'ok'
  | 'error:llm-down'
  | 'error:timeout'
  | 'error:parse'
  | 'error:empty';
```

After T5:
```typescript
export type ExtractionStatus =
  | 'ok'
  | 'error:llm-down'
  | 'error:timeout'
  | 'error:parse'
  | 'error:empty'
  | 'error:prompt-too-large';   // new — pre-flight guard
```

From src/memory/memory-store.ts:585 (existing — consumed unchanged):
```typescript
getCandidates(query: RecallQuery): Memory[];
// RecallQuery — types.ts:88-99 — { query?, tags?, types?, token_budget, workdir?, ... }
```

Call shape used by cmd-memory-auto-extract.ts after T4:
```typescript
const existingMemories = new MemoryStore().getCandidates({
  workdir: payload.value.cwd,
  token_budget: 2000,   // hard cap per ROADMAP §6 success criterion 4
});
// then slice to first 50 if length > 50 (DELTA-02 says limit=50)
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1 (RED→GREEN): Extend MemorySource union with 'delta-contradiction'</name>
  <files>src/memory/types.ts, src/memory/types.test.ts (or nearest existing type-coverage test)</files>
  <behavior>
    - Test 1: A const assertion `const s: MemorySource = 'delta-contradiction'` type-checks (compile-time check via `tsc --noEmit` in test or a literal assignment in a runtime test).
    - Test 2: Existing MemorySource consumers (computeTrustLevel at memory-store.ts:31, rowToMemory at memory-store.ts:78, trust-recompute at memory-store.ts:719,751) still narrow correctly — no `never` branches introduced. Verify by running the full `vitest src/memory/` suite — must remain green.
    - Test 3 (negative): An invalid value `'delta-contradicto'` (typo) fails to type-check (compile-error assertion via `expect-error` comment OR existing test pattern in repo).
  </behavior>
  <action>
    1. Edit `src/memory/types.ts:11` — extend `MemorySource` union: `'human' | 'auto-run-recorder' | 'worker-mcp' | 'unknown' | 'delta-contradiction'`.
    2. Audit downstream switch/if-chains over `MemorySource`. Confirmed sites from MEMORY-MAP.md §6+§7: `memory-store.ts:31 computeTrustLevel`, `rowToMemory :78`, trust-recompute `:719,751`, rollback filters `:1046,1075` (current filter `memory_source='auto-run-recorder'` only — must NOT inadvertently include delta-contradiction in rollback). If any site needs a new branch, add minimal handling: delta-contradiction defaults to `trust_level='unverified'` (per Pitfall 4.4: "Trust tier for contradicting auto-extracted memories defaults to unverified"). Do NOT add delta-contradiction to rollbackByRunId filter — contradictions are not auto-run-recorder lineage.
    3. Do NOT touch src/workers/ or src/memory/memory-store.ts CORE write paths (DB-migration/INSERT column list etc.). Only update trust-level/rollback narrowing as required for type-safety.
    4. RED step: add the failing assertion FIRST, run `npm test -- src/memory/types`, confirm fail with "Type '\"delta-contradiction\"' is not assignable" or equivalent.
    5. GREEN step: apply the union extension, re-run, confirm pass.
    6. Commit message: `test(06-01): RED — MemorySource 'delta-contradiction' literal` then `feat(06-01): extend MemorySource union for delta-contradiction`.
  </action>
  <verify>
    <automated>npm test -- src/memory/types &amp;&amp; npm run typecheck</automated>
  </verify>
  <done>
    MemorySource union includes 'delta-contradiction'. `npm run typecheck` clean. Existing memory-store.test.ts + memory-engine.test.ts still green (no narrowing regressions). Trust-level for delta-contradiction defaults to 'unverified'.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2 (RED→GREEN): Make buildPrompt accept existingMemories with structural backward compat</name>
  <files>src/memory/auto-extract-runner.ts, src/memory/auto-extract-runner.test.ts</files>
  <behavior>
    - Test 1 (backward compat — DELTA-04): `buildPrompt(transcript, [])` returns the EXACT same string as the current `buildPrompt(transcript)` (byte-equal, including line count). Existing extraction tests must remain green untouched.
    - Test 2: `buildPrompt(transcript, undefined)` (legacy single-arg call) also returns the v0.1 baseline string. Default parameter handles both `undefined` and `[]`.
    - Test 3: `buildPrompt(transcript, [m1, m2, m3])` (3 memories) returns a string containing the literal `Existing known patterns:` heading, followed by each memory rendered as `- [<memory_type>] <content>` (one per line), followed by a blank line, followed by `New transcript:` heading (NOT just `Transcript:` — the heading rename happens only when existing[] is non-empty), followed by the transcript content. Critical instruction added: `Extract only what the transcript ADDS, CONTRADICTS, or REFINES…`.
    - Test 4: When existing[] non-empty, the prompt contains exactly the existing memories' content verbatim (no truncation, no JSON escape — plain text rendering).
    - Test 5 (export): `buildPrompt` is exported from auto-extract-runner.ts (was previously private).
  </behavior>
  <action>
    1. RED step: write all 5 tests above against the CURRENT private `buildPrompt`. Tests must fail because (a) buildPrompt is not exported, (b) it doesn't accept second arg, (c) no Existing block.
    2. GREEN step: refactor `PROMPT_TEMPLATE` at auto-extract-runner.ts:46-54 into two compose-time fragments:
       - `BASE_PROMPT_PREFIX` — lines 47-51 (instructions + Output STRICTLY directive).
       - `BASE_PROMPT_SUFFIX_LEGACY` — `'Transcript:\n<<<TRANSCRIPT>>>'` (kept verbatim for backward compat when existing[] empty).
       - `BASE_PROMPT_SUFFIX_DELTA` — new — `'<<<EXISTING_BLOCK>>>\nNew transcript:\n<<<TRANSCRIPT>>>'` (used only when existing[] non-empty).
    3. Build `EXISTING_BLOCK` from `existingMemories` only when length > 0:
       ```
       Existing known patterns:
       - [<m.memory_type>] <m.content>
       - [<m.memory_type>] <m.content>
       ...

       Extract only what the transcript ADDS, CONTRADICTS, or REFINES — do NOT re-extract known patterns. Mark contradictions explicitly with {"contradicts_id": "<existing_memory_id>"}.

       ```
       (Trailing blank line before `New transcript:`.)
    4. Export `buildPrompt` (was private). Default `existingMemories: readonly Memory[] = []`.
    5. When existingMemories.length === 0, choose `BASE_PROMPT_SUFFIX_LEGACY` and emit the original prompt unchanged (DELTA-04 backward-compat invariant: byte-equal to v0.1).
    6. When existingMemories.length > 0, choose `BASE_PROMPT_SUFFIX_DELTA`.
    7. Run all 5 tests — must all pass GREEN.
    8. Run the full existing extraction test file (any tests for stripJsonFences, probeLmStudio, extractLessonsViaLmStudio) — must remain GREEN with zero changes.
    9. Commit messages: `test(06-01): RED — buildPrompt(transcript, existing[]) signature + delta block` then `feat(06-01): extend buildPrompt with existingMemories injection, byte-equal legacy path`.
  </action>
  <verify>
    <automated>npm test -- src/memory/auto-extract-runner</automated>
  </verify>
  <done>
    `buildPrompt(transcript, [])` byte-equals `buildPrompt(transcript)` (legacy). `buildPrompt(transcript, [m1, m2])` includes "Existing known patterns:" + "New transcript:" + delta instruction. `buildPrompt` is exported. All existing auto-extract-runner tests still green.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 3 (RED→GREEN): Thread existingMemories through ExtractionOptions and extractLessonsViaLmStudio</name>
  <files>src/memory/auto-extract-runner.ts, src/memory/auto-extract-runner.test.ts</files>
  <behavior>
    - Test 1: `ExtractionOptions` accepts optional `existingMemories?: readonly Memory[]`. Calling `extractLessonsViaLmStudio({ transcript, endpoint, model, timeoutMs })` (no existingMemories) still works — equivalent to `existingMemories: []`.
    - Test 2: `extractLessonsViaLmStudio({ transcript, ..., existingMemories: [m1, m2] })` passes those memories into `buildPrompt` (verify via mocked `callChatCompletions` capturing the prompt arg).
    - Test 3: Workdir scoping — if `existingMemories` contains entries with `workdir` differing from each other (caller bug), runner does NOT filter; this is the caller's responsibility. Document with a JSDoc comment. (Workdir isolation is enforced at the `getCandidates(workdir=...)` call site in T4, not here.)
  </behavior>
  <action>
    1. RED step: write tests above against current `ExtractionOptions` shape — fail because property doesn't exist.
    2. GREEN step: extend `ExtractionOptions` at auto-extract-runner.ts:33-38 — add `existingMemories?: readonly Memory[]` and `contextLimitTokens?: number` (used by T5 — declare here so we don't have to revisit the interface).
    3. Update `extractLessonsViaLmStudio` (auto-extract-runner.ts:222) call site at `:246` from `buildPrompt(opts.transcript)` to `buildPrompt(opts.transcript, opts.existingMemories ?? [])`.
    4. Add JSDoc to ExtractionOptions: `existingMemories — pre-fetched from MemoryStore.getCandidates(workdir, ...) by the caller. Runner does NOT filter by workdir — caller's responsibility.`
    5. Import `Memory` from `./types` in auto-extract-runner.ts (currently no import from types — verify). If TS purity rule from PITFALLS CC.4 applies to memory-engine.ts but NOT auto-extract-runner.ts, this import is fine. (Confirmed: CC.4 lint rule is scoped to `src/memory/memory-engine.ts` only.)
    6. Run tests — all green. Existing tests must remain green (default empty path).
    7. Commit: `test(06-01): RED — ExtractionOptions threads existingMemories` then `feat(06-01): pipe existingMemories through extractLessonsViaLmStudio`.
  </action>
  <verify>
    <automated>npm test -- src/memory/auto-extract-runner</automated>
  </verify>
  <done>
    ExtractionOptions has optional `existingMemories` and `contextLimitTokens`. Runner threads them through to buildPrompt. Default empty behavior unchanged. No new imports beyond `./types`.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 4 (RED→GREEN): cmd-memory-auto-extract fetches existing memories via MemoryStore.getCandidates before extract()</name>
  <files>src/cli/cmd-memory-auto-extract.ts, src/cli/cmd-memory-auto-extract.test.ts</files>
  <behavior>
    - Test 1 (DELTA-02): On every auto-extract invocation, `MemoryStore.getCandidates({ workdir: payload.value.cwd, token_budget: 2000 })` is called EXACTLY ONCE before `extract()` is called. Verify via spy on a `deps.memoryStore` injection (use the existing `deps` pattern at cmd-memory-auto-extract.ts:405).
    - Test 2: The fetched memories are sliced to first 50 (`limit=50` per DELTA-02) before being passed in as `existingMemories`. If `getCandidates` returns >50, only the first 50 are forwarded.
    - Test 3 (workdir isolation — CC.3): `getCandidates` MUST be called with the session's `payload.value.cwd` as workdir. Never null, never wildcard. If `payload.value.cwd` is missing or empty, fall back to existingMemories=[] (degrade gracefully — DELTA-04 backward compat) AND log `skipped:no-workdir` to stderr.
    - Test 4: When MemoryStore.getCandidates throws (DB locked, schema mismatch), runner falls back to `existingMemories: []` AND emits a structured `degraded:existing-fetch-failed` audit entry. Extraction still proceeds (don't block extraction on a recall failure). Hook still exits 0.
    - Test 5: Backward compat — when workdir has zero existing memories, the resulting prompt is byte-equal to the current pre-DELTA prompt. Verified via the same buildPrompt(transcript, []) byte-equal invariant from T2.
  </behavior>
  <action>
    1. RED step: write all 5 tests injecting a `deps.memoryStore` mock with a `getCandidates` spy. Tests fail because cmd-memory-auto-extract.ts currently never touches MemoryStore.
    2. GREEN step: at cmd-memory-auto-extract.ts BEFORE line 405 (the `extract()` call):
       ```
       // Fetch existing patterns for delta extraction (DELTA-02)
       let existingMemories: readonly Memory[] = [];
       try {
         const store = deps.memoryStore ?? new MemoryStore();
         const cwd = payload.value.cwd;
         if (typeof cwd === 'string' && cwd.length > 0) {
           const candidates = store.getCandidates({ workdir: cwd, token_budget: 2000 });
           existingMemories = candidates.slice(0, 50);
         } else {
           // skipped:no-workdir — log to stderr, do not block
           process.stderr.write('RELAY: auto-extract — no workdir, skipping delta enrichment\n');
         }
       } catch (err) {
         existingMemories = [];
         // degraded:existing-fetch-failed — record in audit, do not throw
         process.stderr.write(`RELAY: auto-extract — getCandidates failed: ${String(err)}\n`);
       }
       ```
    3. Update the `extract({ transcript, endpoint, model, timeoutMs })` call at :406-411 to pass `existingMemories`:
       ```
       const extraction = await extract({
         transcript: redactedTranscript,
         endpoint,
         model,
         timeoutMs,
         existingMemories,
       });
       ```
    4. Extend `deps` interface at the top of cmd-memory-auto-extract.ts to accept an optional `memoryStore?: MemoryStore` for test injection (mirror the existing `deps.extractLessons` pattern).
    5. Audit entry: if extraction succeeded with existingMemories.length > 0, record `existing_memories_count: N` and `delta_mode: true` in the audit payload at cmd-memory-auto-extract.ts:422-434.
    6. Keep `await emit(io, args, status, audit, ...)` paths — every error/skipped path still returns exit 0 (CC.2 invariant).
    7. Run tests — all GREEN. Run the full `npm test -- src/cli/cmd-memory-auto-extract` suite — must all remain green (backward compat).
    8. Commit messages: `test(06-01): RED — cmd-memory-auto-extract fetches existing via getCandidates` then `feat(06-01): wire existingMemories prefetch with degrade-graceful fallback`.
  </action>
  <verify>
    <automated>npm test -- src/cli/cmd-memory-auto-extract</automated>
  </verify>
  <done>
    cmd-memory-auto-extract calls `MemoryStore.getCandidates({workdir, token_budget:2000})` once per run before extract(). Result sliced to first 50. Graceful fallback to existingMemories=[] on (a) missing workdir, (b) getCandidates throw. Audit records `existing_memories_count` and `delta_mode`. Hook still exits 0 on all error paths.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 5 (RED→GREEN): Pre-flight prompt-size guard — abort with EXTRACT_PROMPT_TOO_LARGE before LM Studio dispatch</name>
  <files>src/memory/auto-extract-runner.ts, src/memory/auto-extract-runner.test.ts</files>
  <behavior>
    - Test 1 (Pitfall 4.1): When `tokens(prompt) >= contextLimitTokens * 0.8`, extractLessonsViaLmStudio returns `{ status: 'error:prompt-too-large', note: 'prompt size N tokens >= 80% of context limit M' }` WITHOUT calling LM Studio (verify via spy on `callChatCompletions` — must not be invoked).
    - Test 2: When `tokens(prompt) < contextLimitTokens * 0.8`, normal dispatch happens (existing flow unchanged).
    - Test 3: Default `contextLimitTokens` = 8192 if not provided (conservative — matches lfm2-24b smaller models from PITFALLS 4.1).
    - Test 4: Token estimation uses `Math.ceil(text.length / 4)` (mirror of `estimateTokens` from memory-engine.ts:18 — reuse, don't duplicate).
    - Test 5: When existingMemories[] is so large that prompt exceeds threshold, the runner does NOT silently drop memories — it returns `error:prompt-too-large` so the caller can decide (caller's responsibility to retry with a smaller `existingMemories` slice). DO NOT auto-truncate the existing block here — the caller already capped at 50 entries / 2000 token budget in T4, so this guard catches the genuinely oversized case.
  </behavior>
  <action>
    1. RED step: write all 5 tests. Currently no pre-flight exists — tests fail because runner happily POSTs giant prompts.
    2. GREEN step: in `extractLessonsViaLmStudio` at auto-extract-runner.ts:222, after the `buildPrompt` call at :246 and BEFORE the `callChatCompletions` call at :247:
       ```
       const contextLimit = opts.contextLimitTokens ?? 8192;
       const promptTokens = estimateTokens(prompt);   // import from ./memory-engine
       if (promptTokens >= contextLimit * 0.8) {
         return {
           status: 'error:prompt-too-large',
           durationMs: Date.now() - startedAt,
           note: `prompt size ${promptTokens} tokens >= 80% of context limit ${contextLimit}`,
         };
       }
       ```
    3. Extend `ExtractionStatus` union at auto-extract-runner.ts:19-24 to add `'error:prompt-too-large'`.
    4. Import `estimateTokens` from `./memory-engine` (already in the same package — no new external dep).
    5. Update `ChatCompletionsOutcome.status` union at auto-extract-runner.ts:140 to also include `'error:prompt-too-large'` (or — preferred — return directly without calling callChatCompletions so this internal type stays clean).
    6. Map the new status in cmd-memory-auto-extract.ts at :413-421 to an appropriate `AutoExtractStatus` — recommended new value `'skipped:prompt-too-large'` (skipped:* per CC.2 hook-exit-0 invariant). Add to AutoExtractStatus union in the same file.
    7. Run all tests — must pass GREEN.
    8. Commit: `test(06-01): RED — prompt-size pre-flight returns error:prompt-too-large` then `feat(06-01): add pre-flight prompt-size guard before LM Studio dispatch`.
  </action>
  <verify>
    <automated>npm test -- src/memory/auto-extract-runner src/cli/cmd-memory-auto-extract</automated>
  </verify>
  <done>
    extractLessonsViaLmStudio returns `error:prompt-too-large` (without invoking LM Studio) when prompt tokens >= 80% of contextLimitTokens. Default limit = 8192. cmd-memory-auto-extract maps this to `skipped:prompt-too-large` (exit 0). No silent truncation of existingMemories.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 6 (RED→GREEN): Queue-and-detach guard — formalize hook-exit-0 contract when Phase 5 contradiction wiring not yet ready</name>
  <files>src/cli/cmd-memory-auto-extract.ts, src/cli/cmd-memory-auto-extract.test.ts</files>
  <behavior>
    - Test 1 (Pitfall 4.3): When LM Studio response is slow (simulate 30s-delayed mock), SessionEnd hook code path still returns `process.exitCode === 0` within 5s. Verify by wrapping the relevant entrypoint in a Promise.race with a 5s budget and asserting the queue-write path was taken.
    - Test 2: A queue envelope JSON file is written to `<workdir>/.relay/queue/pending-extraction-<ts>.json` containing the redacted transcript, endpoint, model, timeoutMs, and existingMemories metadata (memory_ids only — NOT full content; keep envelope small). Filename uses `Date.now()` + a 4-char nanoid suffix to avoid collisions when multiple sessions end in the same millisecond.
    - Test 3: When `RELAY_AUTO_EXTRACT_DETACH=1` env var is set, runner ALWAYS writes envelope and exits without dispatching — useful for the SessionEnd hook path. Default `RELAY_AUTO_EXTRACT_DETACH=0` preserves current synchronous-dispatch behavior for `relay memory auto-extract --once` CLI use.
    - Test 4: When envelope write itself fails (e.g., `.relay/queue/` not writable), hook STILL exits 0 with `skipped:queue-write-failed` status (CC.2 — hook never throws).
    - Test 5 (Phase 5 dependency gate): When the runner detects a contradiction result (model output contains `contradicts_id`) AND Phase 5 has NOT yet shipped (detection: `conflicts_with_json` column missing — check via `PRAGMA table_info(memories)` once at startup, cache result), the runner writes the contradiction as `memory_source='delta-contradiction'` WITHOUT setting `conflicts_with_json`. Once Phase 5 ships, the existing CONFLICT-02 write-time detection in `MemoryStore.remember()` populates the column reciprocally — no extra code here.
  </behavior>
  <action>
    1. RED step: write all 5 tests. Use fake-timers (vitest `vi.useFakeTimers`) for the 5s budget test. Use a temp dir for the queue write test.
    2. GREEN step: extract a new helper `writeExtractionEnvelope(workdir, payload)` in cmd-memory-auto-extract.ts. Signature:
       ```ts
       interface ExtractionEnvelope {
         readonly version: '1';
         readonly created_at: number;
         readonly session_id: string;
         readonly cwd: string;
         readonly endpoint: string;
         readonly model: string;
         readonly timeoutMs: number;
         readonly redacted_transcript: string;
         readonly existing_memory_ids: readonly string[];   // not full memories — small envelope
       }
       function writeExtractionEnvelope(workdir: string, env: ExtractionEnvelope): { written: true; path: string } | { written: false; reason: string };
       ```
       Use `fs.mkdirSync(path.join(workdir, '.relay/queue'), { recursive: true })` then `fs.writeFileSync` synchronously with a strict 1s timeout via `AbortController` (don't wait forever on a flaky FS).
    3. In the main `runMemoryAutoExtract` entrypoint, add a top-level branch BEFORE the `extract()` call:
       ```
       const detach = process.env.RELAY_AUTO_EXTRACT_DETACH === '1';
       if (detach) {
         const envelope: ExtractionEnvelope = {
           version: '1',
           created_at: Date.now(),
           session_id: payload.value.session_id,
           cwd: payload.value.cwd,
           endpoint,
           model,
           timeoutMs,
           redacted_transcript: redactedTranscript,
           existing_memory_ids: existingMemories.map(m => m.memory_id),
         };
         const result = writeExtractionEnvelope(payload.value.cwd, envelope);
         const status: AutoExtractStatus = result.written ? 'skipped:queued' : 'skipped:queue-write-failed';
         await emit(io, args, status, audit, { /* envelope path */ });
         return 0;
       }
       ```
    4. Wrap the ENTIRE runMemoryAutoExtract body in a top-level `try { ... } catch (err) { process.stderr.write(...); return 0; }` (CC.2 invariant — verify any existing wrapper; do NOT double-wrap).
    5. Add `'skipped:queued'` and `'skipped:queue-write-failed'` to AutoExtractStatus union.
    6. Phase 5 dependency gate: ADD a startup probe `hasConflictsWithJsonColumn(db): boolean` that runs `PRAGMA table_info(memories)` once and caches. When `false` (Phase 5 not shipped yet), delta-contradiction rows still write but the runner does NOT attempt to populate conflicts_with_json directly — relying on Phase 5's `MemoryStore.remember()` write-time detection (CONFLICT-02) to wire reciprocally when both phases are live. Document this in a comment at the call site. NO code is needed for the Phase-5-present path because remember() handles it; we only need to NOT crash when the column is absent.
    7. Run all tests — GREEN.
    8. Commit messages: `test(06-01): RED — queue-and-detach envelope + 5s hook budget` then `feat(06-01): formalize RELAY_AUTO_EXTRACT_DETACH queue-and-detach path`.
  </action>
  <verify>
    <automated>npm test -- src/cli/cmd-memory-auto-extract</automated>
  </verify>
  <done>
    With `RELAY_AUTO_EXTRACT_DETACH=1`, hook writes `<workdir>/.relay/queue/pending-extraction-<ts>.json` and exits 0 within 5s without calling LM Studio. Envelope contains memory_ids only (not content) — keeps file small. Queue-write failure → `skipped:queue-write-failed` exit 0. Phase 5 absence detected via PRAGMA probe — runner does not crash when conflicts_with_json column is missing.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 7 (RED→GREEN): Integration test — no re-extraction of known patterns</name>
  <files>src/cli/cmd-memory-auto-extract.integration.test.ts</files>
  <behavior>
    - Test 1 (ROADMAP §6 success criterion 1): Pre-seed a temp-dir MemoryStore with 3 known memories about CSS naming. Mock LM Studio to (a) receive the prompt, (b) inspect that the "Existing known patterns:" block contains all 3 contents verbatim, (c) return a `lessons:[]` response (model correctly suppressed re-extraction). Assert: `MemoryStore.count(workdir)` after the run === 3 (no new entries created).
    - Test 2 (Pitfall 4.2 — repeats bump recall_count): Pre-seed memory M with `recall_count = 0`. Submit a transcript that re-states M's content verbatim. Mock LM Studio to return `lessons:[]` (correctly suppressed). Assert: cmd-memory-auto-extract has called `MemoryStore.touchMemories([M.memory_id])` OR `markRecallSuccess([M.memory_id])` so `recall_count` increments to 1. NOTE: This requires a small additional code path — a cheap match-before-dispatch step that finds existing memories whose content substring-matches the transcript window, and bumps them. If this matcher isn't ready, ship a stub that logs the intent and create a TODO; the test asserts the call, not the side-effect, for now.
    - Test 3 (DELTA-04 backward compat): Pre-seed ZERO memories. Mock LM Studio. Assert: the prompt sent to LM Studio is byte-equal to the v0.1 pre-DELTA prompt (compare against a fixture file). Confirms backward compat at the full integration level.
  </behavior>
  <action>
    1. RED step: write all 3 tests in a new file `src/cli/cmd-memory-auto-extract.integration.test.ts`. Use `vitest`. Use a temp directory pattern (mirror existing tests in `src/memory/*.test.ts` that use temp dirs). Mock LM Studio HTTP endpoints with a local Express-free `http.createServer` stub OR use the existing `deps.extractLessons` injection pattern to mock the whole runner.
    2. For Test 2 (recall_count bump), if no existing matcher exists, add a minimal helper in cmd-memory-auto-extract.ts:
       ```ts
       function findExistingMatches(transcript: string, existing: readonly Memory[]): readonly Memory[] {
         // O(N) substring-or-Jaccard match. Threshold: 0.6 normalized overlap.
         // Use the existing `jaccard()` from memory-store.ts:178 — exported? If private, replicate the 6-line function locally.
         return existing.filter(m => contentOverlapAtLeast(m.content, transcript, 0.6));
       }
       ```
       If `jaccard` is private at memory-store.ts:178, INLINE a 6-line copy in cmd-memory-auto-extract.ts (do NOT export jaccard from memory-store — that would violate the CC.3 "no SQL outside MemoryStore" boundary by association; cosmetic helpers can live in CLI files).
    3. Before dispatching to extract(), call `findExistingMatches(redactedTranscript, existingMemories)` → for each match, call `store.touchMemories([match.memory_id])`.
    4. GREEN step: run all 3 integration tests — must pass.
    5. Commit: `test(06-01): RED — integration: no-re-extraction + recall_count bump on repeats` then `feat(06-01): add findExistingMatches + touchMemories bump on transcript repeats`.
  </action>
  <verify>
    <automated>npm test -- src/cli/cmd-memory-auto-extract.integration</automated>
  </verify>
  <done>
    Pre-seeded 3 memories → re-run on transcript that re-states them → count remains 3, recall_count bumped on matches. Zero-memories case → prompt byte-equals v0.1 baseline fixture. findExistingMatches helper lives in cmd-memory-auto-extract.ts (not memory-store).
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 8 (RED→GREEN): Integration test — contradiction flag propagation</name>
  <files>src/cli/cmd-memory-auto-extract.integration.test.ts (extend), src/memory/auto-extract-runner.ts</files>
  <behavior>
    - Test 1 (ROADMAP §6 success criterion 2 + DELTA-03): Pre-seed memory A: "Use kebab-case for CSS classes." Submit a transcript stating "Always use camelCase for all class names." Mock LM Studio to return a contradiction-shaped lesson: `{"lessons":[{"content":"Always use camelCase for all class names","memory_type":"decision","confidence":0.9,"contradicts_id":"<A.memory_id>"}]}`. Assert: the new memory is written with `memory_source = 'delta-contradiction'`.
    - Test 2 (Phase 5 NOT yet shipped — backward compat): When `conflicts_with_json` column does NOT exist (Phase 5 not applied), the delta-contradiction memory is still written successfully (with `conflicts_with` either absent from the row or empty `[]`). No crash, no schema error. Assert: `MemoryStore.count()` increases by 1, `getMemory(<new_id>).memory_source === 'delta-contradiction'`.
    - Test 3 (Phase 5 SHIPPED — full integration, conditional skip): When `conflicts_with_json` column DOES exist (Phase 5 applied to the test DB), the new memory's `conflicts_with` includes `[A.memory_id]` AND A's `conflicts_with` retroactively includes `[<new_id>]` (reciprocal, per CONFLICT-02 transactional pairing). This test uses `it.skipIf(!hasConflictsWithJsonColumn(db))` so it auto-skips when Phase 5 hasn't landed yet but starts passing once it does. NOTE TO EXECUTOR: this is the gate that closes the Phase 5 → Phase 6 dependency loop.
    - Test 4 (Berry gate — Pitfall 4.5 / PRIV-06): The Berry hallucination check runs BEFORE the delta-contradiction memory is written. When `mcp__berry__detect_hallucination` is mocked to return `flagged: true`, the memory is NOT written. Assert: `MemoryStore.count()` unchanged, structured log `skipped:berry-flagged-contradiction` emitted. This invariant must hold REGARDLESS of memory_source — delta-contradiction is no special-case bypass.
  </behavior>
  <action>
    1. RED step: write all 4 tests. Test 3 uses `it.skipIf` — vitest supports this natively. Test 4 mocks Berry via the existing pattern (whatever your project uses for MCP mocks — check `mcp__berry__detect_hallucination` call site in current cmd-memory-auto-extract.ts).
    2. GREEN step: extend the schema-validation / cleanupAndValidate path at cmd-memory-auto-extract.ts:438+ to recognize the new optional `contradicts_id` field on lesson entries. When present:
       - Look up the contradicted memory in `existingMemories` by ID.
       - If found, set `memory_source: 'delta-contradiction'` on the new entry being written.
       - If not found (model hallucinated an ID), drop the `contradicts_id` and write with `memory_source: 'auto-run-recorder'` (the existing default) — log a `degraded:unknown-contradicts-id` audit entry.
    3. Berry gate (CRITICAL — Pitfall 4.5): the existing Berry call at cmd-memory-auto-extract.ts (wherever it lives — search for `mcp__berry`) MUST apply to delta-contradiction entries too. Do NOT add a branch that skips Berry for contradictions. Verified by Test 4.
    4. Phase 5 hand-off: when Phase 5's CONFLICT-02 detection in `MemoryStore.remember()` ships, it will look at the new `memory_source='delta-contradiction'` row and run reciprocal write-time conflict pairing automatically — no extra wiring needed from Phase 6.
    5. Run all 4 tests — Test 3 should skip, Tests 1/2/4 should pass.
    6. Commit messages: `test(06-01): RED — integration: contradiction flag → delta-contradiction source + Berry gate` then `feat(06-01): parse contradicts_id and route to delta-contradiction source`.
  </action>
  <verify>
    <automated>npm test -- src/cli/cmd-memory-auto-extract.integration</automated>
  </verify>
  <done>
    Contradiction-shaped lesson writes with `memory_source = 'delta-contradiction'`. Test 3 auto-skips until Phase 5 lands. Berry gate active for all extraction paths including delta-contradiction. Unknown `contradicts_id` degrades gracefully (logged, written with auto-run-recorder source).
  </done>
</task>

</tasks>

<runtime_validation>
After all 8 tasks pass automated verification, run the following end-to-end sanity check against a real LM Studio instance (manual; human runs once, not in CI):

```bash
# 1. Pre-seed 3 known memories
RELAY_WORKDIR=/tmp/relay-delta-test relay memory remember \
  "Use kebab-case for CSS class names" --type=decision --tag css,naming
RELAY_WORKDIR=/tmp/relay-delta-test relay memory remember \
  "Prefer single quotes for JS strings" --type=decision --tag js,style
RELAY_WORKDIR=/tmp/relay-delta-test relay memory remember \
  "Always run npm test before commit" --type=lesson --tag testing

# 2. Compose a transcript that re-states one verbatim plus a NEW lesson
cat > /tmp/delta-test-transcript.txt <<'EOF'
User: "I keep forgetting to test before commits."
Assistant: "Yes — always run npm test before commit. Also, prefer arrow functions for callback expressions in this codebase."
EOF

# 3. Run auto-extract with the new code path
RELAY_WORKDIR=/tmp/relay-delta-test \
  RELAY_AUTO_EXTRACT_DEBUG=1 \
  relay memory auto-extract --transcript /tmp/delta-test-transcript.txt --once

# 4. Verify:
#    (a) the prompt sent to LM Studio (in ~/.relay/debug/) contains
#        "Existing known patterns:" with all 3 pre-seeded entries.
#    (b) count(workdir=/tmp/relay-delta-test) == 4 (3 original + 1 new arrow-function lesson;
#        NO duplicate of "Always run npm test before commit").
#    (c) recall_count on the matched "Always run npm test before commit" memory == 1 (bumped).
#    (d) hook exit code == 0 even if LM Studio is slow (test by SIGSTOP-ing LM Studio
#        mid-run then resuming after 30s — hook should have already returned 0
#        because RELAY_AUTO_EXTRACT_DETACH=1 was set OR queue-write happened).

# 5. Confirm Berry gate
RELAY_DISABLE_BERRY=1 RELAY_WORKDIR=/tmp/relay-delta-test \
  relay memory auto-extract --transcript /tmp/delta-test-transcript.txt --once
# Should log: "skipped:berry-unavailable" and write NO memories (or write with trust_level=unverified
# and short 7-day TTL per Pitfall 4.5 prevention strategy 2).

# 6. Cleanup
rm -rf /tmp/relay-delta-test /tmp/delta-test-transcript.txt
```

This validation is NOT automated CI but MUST be run by the human reviewer before marking Phase 6 done — confirms the full delta flow end-to-end on real LM Studio.
</runtime_validation>

<verification>
Phase-level checks AFTER all 8 tasks complete:

1. **Test suite green:** `npm test` — all existing 972+ tests still pass plus the new tests added in T1-T8.
2. **Typecheck clean:** `npm run typecheck` — no `any`, no narrowing failures from MemorySource extension.
3. **Backward-compat smoke:** `buildPrompt(transcript, [])` byte-equals `buildPrompt(transcript)` (assert with a fixture-based byte-diff test).
4. **No memory-engine.ts pollution (CC.4):** `grep -n "import" src/memory/memory-engine.ts` shows ONLY `./types` and `./constants` imports — no auto-extract-runner imports, no embedding imports.
5. **Hook-exit-0 invariant (CC.2):** `grep -nE "throw new Error|throw new" src/cli/cmd-memory-auto-extract.ts` — every match MUST be inside a try block whose catch returns 0. If found unwrapped, fail.
6. **No raw SQL outside MemoryStore (CC.3):** `grep -nE "FROM memories" src/cli/cmd-memory-auto-extract.ts` returns empty (must use MemoryStore methods).
7. **Workdir scoping verified:** Cross-workdir contamination test — pre-seed memory in workdir A, run auto-extract in workdir B, assert workdir-A memory never appears in the `existingMemories` array passed to buildPrompt.
8. **Coverage:** `npm test -- --coverage src/memory/auto-extract-runner src/cli/cmd-memory-auto-extract` — line coverage ≥80% per project standard.
</verification>

<success_criteria>
Phase 6 ships when ALL of the following hold (mapped 1:1 to ROADMAP §Phase 6 Success Criteria):

- [ ] **SC-1 (DELTA-01 + DELTA-02):** User triggers auto-extract on a workdir with 50 existing memories; LM Studio request contains "Existing known patterns" block (verified via debug dump) followed by transcript window; extraction set contains zero re-extracted duplicates of known patterns (verified via integration test T7).
- [ ] **SC-2 (DELTA-03):** Contradictions surface as memories with `memory_source = 'delta-contradiction'` (verified via integration test T8 Test 1). When Phase 5 shipped, they propagate into `conflicts_with_json` reciprocally (T8 Test 3, auto-skipped until Phase 5 lands).
- [ ] **SC-3 (DELTA-04):** Auto-extract on a clean workdir (zero existing memories) produces structurally-equivalent prompt to pre-DELTA baseline (verified via byte-equal fixture test in T2 + integration test T7 Test 3).
- [ ] **SC-4 (DELTA-02):** `MemoryStore.getCandidates(workdir, limit=50, tokenBudget=2000)` invoked exactly once per auto-extract run before `buildPrompt()` (verified via spy in T4 Test 1).
- [ ] **Additional invariants from PITFALLS 4.1-4.5:**
  - Pre-flight prompt-size check aborts with `EXTRACT_PROMPT_TOO_LARGE` when prompt ≥ 80% context limit (T5).
  - Repeats bump `recall_count`/`accessed_at` on the matching existing memory — no new entry created (T7 Test 2).
  - SessionEnd hook returns exit 0 within 5s when LM Studio slow — queue-and-detach via `.relay/queue/pending-extraction-*.json` (T6).
  - Contradictions stored as relationship (`memory_source = 'delta-contradiction'` + relies on Phase 5 `conflicts_with_json` for reciprocity), NOT as a separate contradiction-tagged entity (Pitfall 4.4 prevention).
  - Berry hallucination gate runs for ALL delta-extracted entries including contradictions (T8 Test 4).
</success_criteria>

<risk_register>

| Risk | Likelihood | Blast Radius | Mitigation | Verified By |
|------|------------|--------------|------------|-------------|
| Model ignores "extract only deltas" instruction and re-extracts known patterns anyway | MEDIUM | LOW (we dedupe via content_hash 60s window at memory-store.ts:296-302 — duplicates blocked at write) | Add explicit `contradicts_id` field in the JSON schema; weight instructions toward "default to empty `lessons:[]` if uncertain"; T7 Test 1 catches regression | Integration test T7 + runtime validation step 4(b) |
| Prompt-size overflow on large workdirs with verbose memories | HIGH (workdirs with 100+ memories) | MEDIUM (truncation = silent extraction failure) | T5 pre-flight guard returns `error:prompt-too-large` before dispatch; caller sees `skipped:prompt-too-large`; existing 2000-token budget cap on getCandidates() (T4) is first defense | T5 tests + runtime validation step 4(a) |
| SessionEnd hook blocks CC when LM Studio is slow or down | HIGH (LM Studio cold-start can take 60s+) | CATASTROPHIC (CC disables Relay hook entirely per PITFALLS Pitfall 4.3) | T6 formalizes `RELAY_AUTO_EXTRACT_DETACH=1` queue-and-detach pattern; envelope-write itself is 1s-timeout-bounded; top-level try/catch returns exit 0 on every error | T6 Test 1 (5s budget) + runtime validation step 4(d) |
| `delta-contradiction` source value format-drifts as Phase 5 evolves | LOW | MEDIUM (CONFLICT-02 write-time detection might mis-handle if name changes) | Document the contract: `memory_source='delta-contradiction'` is a Phase 6-owned literal; Phase 5 reads it; both phases must agree. Lock the string literal in a constants module if T1 reveals churn risk. Add a co-located test in Phase 5 that asserts CONFLICT-02 recognizes the source value | T8 Test 3 (Phase 5 integration, conditionally skipped) |
| MemorySource union extension breaks narrowing in unaudited switch statements | MEDIUM | HIGH (silent runtime fallthrough on switch with no default) | T1 step 2 explicitly audits MEMORY-MAP.md §6+§7 sites; typecheck catches missing branches when switch has exhaustiveness assertion; if any site lacks exhaustiveness check, add `_exhaustive: never = source` guard during T1 | T1 tests + `npm run typecheck` |
| Berry gate bypassed for delta-contradiction (Pitfall 4.5 regression) | LOW (test enforces it) | HIGH (hallucinated contradictions auto-flagged and propagated to Phase 5 conflict store would poison recall) | T8 Test 4 asserts Berry called for delta-contradiction rows; do NOT add `if (memory_source === 'delta-contradiction') skipBerry()` anywhere; code review must reject any such branch | T8 Test 4 + grep `grep -n "delta-contradiction" src/cli/cmd-memory-auto-extract.ts \| grep -i "berry\|skip"` returns no matches |
| getCandidates() fetch fails silently (DB locked, schema mismatch) and runner proceeds without delta enrichment with no signal to user | MEDIUM | LOW (degrades to v0.1 behavior — not broken, just not enriched) | T4 Test 4: fallback to existingMemories=[] is loud (stderr log + audit entry `degraded:existing-fetch-failed`); doctor check should surface elevated rate of degraded:* status in future Phase | T4 Test 4 + `relay info` rollup (deferred to next iteration) |

</risk_register>

<output>
After all 8 tasks complete, write `.planning/phases/06-delta-extraction/06-01-SUMMARY.md` capturing:
- Final shape of `MemorySource` union (with `delta-contradiction`).
- Final `buildPrompt` signature + the v0.1 backward-compat fixture path.
- The queue envelope JSON shape (ExtractionEnvelope interface) — for downstream tooling that may read the queue (e.g., `relay extract --process-queue` in a future phase).
- Notes on what Phase 5 must implement to close the contradiction loop (CONFLICT-02 must recognize `memory_source='delta-contradiction'` and pair reciprocally).
- The exact `it.skipIf` predicate Test 8.3 uses, so Phase 5 verification knows what to grep for after CONFLICT-02 ships.
</output>
