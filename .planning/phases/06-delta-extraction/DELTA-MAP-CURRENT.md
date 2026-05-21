# Phase 6 — Delta Extraction: Current-State Map

**Scope:** Map the surface area Phase 6 (delta extraction) must touch. No code changes here — citations only.

---

## 1. `src/memory/auto-extract-runner.ts` (8.3 KB, 276 lines)

**Role:** I/O wrapper around LM Studio `/v1/chat/completions`. Pure: probe → call → strip fences → return raw output. Never throws.

- **T10 prompt template:** `PROMPT_TEMPLATE` at `src/memory/auto-extract-runner.ts:46-54`. Joined string with sentinel `<<<TRANSCRIPT>>>`. Inline by design — semantics change = code review.
- **`buildPrompt` signature:** `function buildPrompt(transcript: string): string` at `src/memory/auto-extract-runner.ts:65-67`. Pure substitution of `<<<TRANSCRIPT>>>`. **No context slot for existing-memory deltas.**
- **`ExtractionOptions` interface:** `src/memory/auto-extract-runner.ts:33-38`. Fields: `transcript`, `endpoint`, `model`, `timeoutMs`. **No `existingMemories` / `delta` / `priorLessons` field.**
- **`ExtractionResult` interface:** `src/memory/auto-extract-runner.ts:26-31`. Fields: `status`, `rawOutput?`, `durationMs`, `note?`.
- **`ExtractionStatus` enum:** `src/memory/auto-extract-runner.ts:19-24` — `'ok' | 'error:llm-down' | 'error:timeout' | 'error:parse' | 'error:empty'`.
- **Extraction flow:** `extractLessonsViaLmStudio` at `src/memory/auto-extract-runner.ts:222-275`:
  1. AbortController + timeout (line 226-227).
  2. `probeLmStudio` — confirms `/v1/models` reachable + requested model in list (lines 91-137, called at 230).
  3. `buildPrompt(opts.transcript)` (line 246).
  4. `callChatCompletions` — POST `/v1/chat/completions` with `temperature=1.0`, `top_p=0.95` (lines 145-201, called at 247).
  5. `stripJsonFences` removes ```json fences (lines 74-83, called inside callChatCompletions at line 195).
  6. Returns `ExtractionResult`.
- **Sampling constants:** `SAMPLING = { temperature: 1.0, top_p: 0.95 }` at `src/memory/auto-extract-runner.ts:56-59` — matches feedback_lmstudio_routing rule (qwen3-coder preset).

---

## 2. `src/cli/cmd-memory-auto-extract.ts` (33.4 KB, ~700 lines)

**Role:** SessionEnd-hook pipeline orchestrator. CC pipes JSON payload on stdin.

### Header block — pipeline contract
- File-header pipeline doc: `src/cli/cmd-memory-auto-extract.ts:1-29`. Lists 10 steps (parse → consent → window → redact → extract → cleanup → Berry → write → log).
- Imports: `src/cli/cmd-memory-auto-extract.ts:32-62`. Notable: `extractLessonsViaLmStudio` + `ExtractionOptions` (47-51), `cleanupAndValidate` (52-56), `checkLessonViaBerry` (57-61), `handleRemember` (62). **No `MemoryStore` / `getCandidates` import — pipeline never reads existing memories today.**
- Hook payload schema: `HookPayloadSchema` at `src/cli/cmd-memory-auto-extract.ts:66-71`. Fields: `session_id`, `transcript_path`, `cwd`, optional `hook_event_name`.
- Status enum: `AutoExtractStatus` at `src/cli/cmd-memory-auto-extract.ts:76-98`. 21 variants. Will need at least one new variant for delta-skipped (e.g. `skipped:duplicate-of-existing`).
- Audit entry: `AuditEntry` at `src/cli/cmd-memory-auto-extract.ts:102-117`. Fields include `lessons_written`, `lessons_failed`, `redaction_hits`. No field for "lessons skipped as duplicates".
- `AutoExtractDeps` (DI seam): `src/cli/cmd-memory-auto-extract.ts:132-150`. Every external service is injectable for tests. **No `getExistingMemories` / `loadCandidates` dep yet — will need to add for Phase 6.**

### Entry + pipeline
- `executeMemoryAutoExtractCommand` at `src/cli/cmd-memory-auto-extract.ts:163-202` — top-level try/catch, always exits 0.
- `runPipeline` at `src/cli/cmd-memory-auto-extract.ts:204+`.
  - Project opt-out check (`.relayignore`) at `:232-241`.
  - Consent load + `enabled` check at `:243-269`.
  - Provider gating (lmstudio-only in v1) at `:271-297`.
  - Transcript existence check at `:300-311`.
  - Window load via `loadRecentTranscriptWindow` at `:314-330`.
  - PII / secret redaction at `:340-349`.
  - Endpoint + timeout resolution + localhost gate at `:352-376`.
  - Model resolution (env → consent → `lms ps`) at `:378-403`.
  - **Extraction call at `:405-411`** — currently passes only `{ transcript, endpoint, model, timeoutMs }`. This is the choke point Phase 6 must extend (delta context injection).
  - Extraction error branching at `:413-436`.
  - **Cleanup + validate at `:438-464`** — `cleanupAndValidate(rawOutput, consent.min_confidence)`.

### Berry gate (T15/T29)
- Berry integration at `src/cli/cmd-memory-auto-extract.ts:466-522`:
  - Comment block explaining `berry-not-configured` semantics: `:466-477`.
  - `requireBerry` env-var read: `:478`.
  - `checkBerry` resolution from deps: `:479`.
  - Per-lesson `for` loop calling `berryCheck({ lessonContent, transcriptSpans })`: `:487-522`.
  - `survivors` array built from passes; `flagged` → drop; `berry-not-configured` → pass through (`:511-515`); other `unavailable` honours `REQUIRE_BERRY` (`:516-520`).
- All-flagged short-circuit at `:524-540` — emits `error:berry-flagged` or `skipped:low-confidence`.

### Write step
- Write loop at `src/cli/cmd-memory-auto-extract.ts:542-577`. Calls `handleRemember(..., 'auto-run-recorder')` per surviving lesson. Tag set hard-coded: `['auto', 'auto-extract', 'session:<id>', 'confidence:<n>']` (`:559-564`). TTL = 30 days (`:567`). Tracks `written` / `failed` / `writeErrors` for per-lesson outcome bucketing.

**Existing-memory fetch gap:** Pipeline never queries the store before sending to LM. The "delta" knowledge — what we already remember for this `cwd` — is not in the prompt. Phase 6 must insert a step between line 348 (`redactedTranscript`) and line 405 (`extract(...)`) that:
1. Loads top-N existing lessons for the workdir (call `MemoryStore.getCandidates({ workdir: payload.value.cwd, types: ['lesson', 'fact', 'decision'], token_budget: <N> })`).
2. Either folds them into a "DO NOT RE-EMIT" preamble in the prompt OR post-filters duplicates after schema validation.

---

## 3. `src/memory/memory-store.ts` — `getCandidates` (1700+ lines total)

**Signature** at `src/memory/memory-store.ts:585`:
```
getCandidates(query: RecallQuery): Memory[]
```

**Body** at `src/memory/memory-store.ts:585-609`:
- Asserts workdir allowed (`:586`).
- FTS path when `query.query` is set — `SELECT memory_id FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank` (`:588-601`). Falls through to recency on catch.
- Non-FTS path: `SELECT * FROM memories ${where} ORDER BY accessed_at DESC LIMIT 500` (`:603-608`).
- WHERE clause built by `buildWhereClause` (`:633-682`). Applies: `superseded_by IS NULL`, `memory_type IN (...)`, workdir scope (`workdir = ? OR workdir IS NULL`), expiry, `created_after/before`, files-LIKE, trust-tier (`:672-679`).

**RecallQuery shape** — defined at `src/memory/types.ts:89-100`. Phase-6-relevant fields:
- `query?: string` — FTS match string.
- `types?: readonly MemoryType[]` — restrict types.
- `workdir?: string` — `'*'` = all, undefined = current.
- `token_budget: number` — **required field; getCandidates itself does NOT apply this — token budgeting is in the engine layer (`memory-engine.ts`). For Phase 6 you either pass a small synthetic budget or post-slice the returned `Memory[]`.**
- `min_trust?: TrustLevel` — Phase 6 likely wants `min_trust: 'provisional'` to avoid feeding unverified auto-extracts back to the model.

**Verification verdict:** `getCandidates` accepts `workdir` (yes, via RecallQuery) but does **not** accept a `limit` arg directly — the SQL hard-cap is `LIMIT 500` at line 606. `token_budget` exists on the query type but is not used inside `getCandidates` itself.

---

## 4. `src/memory/types.ts` — `MemorySource` enum

**Definition** at `src/memory/types.ts:11`:
```
export type MemorySource = 'human' | 'auto-run-recorder' | 'worker-mcp' | 'unknown';
```

**Verification verdict:** Confirmed — exactly the four values listed in the prompt. Auto-extract writes use `'auto-run-recorder'` (per `cmd-memory-auto-extract.ts:570`). Phase 6 likely does **not** need a new MemorySource variant — delta-extracted lessons are still auto-extracts; what changes is the prompt, not the provenance.

Related types worth noting for Phase 6 design:
- `MemoryType` at `src/memory/types.ts:8` — `'fact' | 'decision' | 'lesson' | 'context' | 'state' | 'handoff' | 'session'`.
- `TrustLevel` at `src/memory/types.ts:19` — `'unverified' | 'provisional' | 'trusted'`. Delta-extracted lessons should write at `'unverified'` (existing behavior — auto-write path is hardcoded unverified per trust-tier rules at memory-store.ts trust computation).
- `Memory` interface at `src/memory/types.ts:56-76` — readonly. Has `content`, `memory_type`, `tags`, `entity_key`, `files`. **`entity_key`** (line 69) is the key existing-supersede mechanism; delta extractor can read this to decide "already exists" without LLM round-trip.

---

## 5. `src/memory/auto-extract-schema.ts` (3.9 KB, 130 lines)

**`ExtractedLesson` Zod schema** at `src/memory/auto-extract-schema.ts:15-19`:
```
content: z.string().min(10).max(200),
memory_type: z.enum(['lesson', 'fact', 'decision']),
confidence: z.number().min(0).max(1),
```

**`ExtractionResult` schema** at `src/memory/auto-extract-schema.ts:22-24`:
```
lessons: z.array(ExtractedLesson).max(3)
```

**Phase 6 attach point for "contradiction" / "delta" flag:**
- Natural slot is on `ExtractedLesson` (per-lesson flag). Add e.g. `is_delta: z.boolean().optional()` or `relates_to_existing: z.string().optional()` (entity_key reference) here at line 15-19.
- Type alias `ExtractedLessonT` exported at line 26 — adding a field auto-propagates to the audit + write loop at `cmd-memory-auto-extract.ts:553-577`.
- `cleanupAndValidate` at `src/memory/auto-extract-schema.ts:82-129`:
  - Strip code fences (`stripCodeFences` at lines 48-56).
  - JSON.parse (`:88-94`).
  - Schema validate (`:96-105`).
  - Redaction-leak check (`hasRedactionLeak` at `:59-66`, called at `:109-116`).
  - Min-confidence filter (`:118-125`).
  - Returns `CleanupResult` discriminated union (defined at `:28-45`).
- Failure reasons enumerated at `:33-37`: `'parse-error' | 'schema-error' | 'low-confidence' | 'redaction-leak'`. Phase 6 may need a new reason like `'duplicate-of-existing'` if delta-skip happens at the cleanup layer instead of upstream of the LLM.

---

## 6. SessionEnd hook wiring — `src/cli/cmd-memory-ops.ts`

**Hook script** at `src/cli/cmd-memory-ops.ts:189`:
```
mkdir -p "$HOME/.relay" && relay memory auto-extract --from-stdin 2>>"$HOME/.relay/relay.ndjson" || true
```

**Hook IDs / markers:**
- `HOOK_ID_SESSION_END = 'relay-memory-session-end'` at `src/cli/cmd-memory-ops.ts:190`.
- `HOOK_MARKER_SESSION_END = 'relay-session-end-v1'` exported at `:199`.
- Comment block explaining `relay pause` short-circuit and stderr routing: `:172-188`.

**Install / remove logic** at `src/cli/cmd-memory-ops.ts:239-322`:
- `executeHookCommand` switches between `SessionStart` and `SessionEnd` based on `command.sessionEnd` flag (`:251-260`).
- Success message for SessionEnd install at `:322`.

**Phase 6 implication:** No change required to the hook script itself. The script just invokes `relay memory auto-extract --from-stdin`; delta logic lives entirely inside that command's pipeline.

---

## 7. Queue directory (`.relay/queue/`)

**Current state — DOES NOT EXIST.**

Verified:
- `ls -la /Users/ghanavati/ai-stack/Projects/Relay/.relay/` → `no .relay dir` (project root has no `.relay/` subdir at all).
- No grep hits in the source tree for `relay/queue` or `RELAY_QUEUE_DIR` patterns (would have shown above).
- Audit log path is `$HOME/.relay/relay.ndjson` (per hook script at `cmd-memory-ops.ts:189` and `auditPath` injection point at `cmd-memory-auto-extract.ts:142`).

**Phase 6 implication:** If the design needs a queue (e.g. defer extraction when LM Studio is down, retry on next session), it must create `~/.relay/queue/` from scratch — no prior pattern to mirror. The closest existing-pattern reference is `$HOME/.relay/relay.ndjson` (unified ndjson log via `appendLog` from `runtime/relay-log.ts`, imported at `cmd-memory-auto-extract.ts:38`).

---

## 8. `src/memory/auto-extract-berry.ts` (4.5 KB, 133 lines)

**Role:** Optional gate. Spawns `RELAY_BERRY_CMD` shell command, pipes lesson on stdin, reads exit code.

**Header block** at `src/memory/auto-extract-berry.ts:1-28`:
- Explains why a shell-command hook (no MCP client from CLI; HTTP fallback never worked).
- Three outcomes: `pass` (exit 0), `flagged` (non-zero), `unavailable` (no cmd / spawn fail / timeout).

**Types:**
- `BerryCheckOutcome` at `src/memory/auto-extract-berry.ts:32` — `'pass' | 'flagged' | 'unavailable'`.
- `BerryCheckResult` at `:34-37` — `{ ok: BerryCheckOutcome, details?: unknown }`.
- `TranscriptSpan` at `:39-42` — `{ source: string, text: string }`. **Currently unused by the shell command — only `lessonContent` reaches stdin. Phase 6 could repurpose `transcriptSpans` for delta context if implementing programmatic grounding.**
- `CheckLessonOptions` at `:44-52` — `{ lessonContent, transcriptSpans, timeoutMs?, cmd?, spawnFn? }`.

**Defaults:** `DEFAULT_TIMEOUT_MS = 10_000` at `:54`.

**`checkLessonViaBerry`** at `src/memory/auto-extract-berry.ts:66-132`:
- Empty lesson short-circuit: `:69-71`.
- Cmd resolution from `opts.cmd ?? process.env['RELAY_BERRY_CMD']` at `:73`.
- **`berry-not-configured` sentinel** at `:74-76` — this is what the auto-extract pipeline keys on at `cmd-memory-auto-extract.ts:498-504, 511-515` to skip without blocking.
- Spawner: `spawn(cmd, { shell: true })` at `:93`. Pipes lesson on stdin (`:121-130`). Exit 0 → pass, non-zero → flagged (`:113-117`).

**Phase 6 implication:** No change to Berry helper itself. If delta extractor wants Berry-style cross-checking against existing memories ("does this proposed lesson contradict memory ID X?"), that's net-new — Berry today only sees the single proposed lesson string on stdin.

---

## Synthesis — surfaces Phase 6 must touch

| Surface | File | Lines | Change scope |
|---|---|---|---|
| Prompt template (add existing-memory slot) | `src/memory/auto-extract-runner.ts` | 46-54 | Extend `PROMPT_TEMPLATE` and `buildPrompt(transcript, existingLessons?)`. |
| ExtractionOptions field for prior lessons | `src/memory/auto-extract-runner.ts` | 33-38 | Add `existingLessons?: readonly string[]` (or richer shape). |
| Pre-extract memory fetch in pipeline | `src/cli/cmd-memory-auto-extract.ts` | 348→405 | Insert step between redact and extract. Needs `MemoryStore` DI seam in `AutoExtractDeps` (132-150). |
| Per-lesson delta flag in schema | `src/memory/auto-extract-schema.ts` | 15-19 | Add e.g. `is_delta` or `entity_ref`. |
| New status variant(s) | `src/cli/cmd-memory-auto-extract.ts` | 76-98 | Add e.g. `skipped:duplicate-of-existing`. |
| Audit accounting | `src/cli/cmd-memory-auto-extract.ts` | 102-117 | Add e.g. `lessons_skipped_duplicate`. |

**Files Phase 6 should NOT need to touch:**
- `src/memory/types.ts` — `MemorySource`, `MemoryType`, `TrustLevel`, `Memory` already sufficient.
- `src/memory/memory-store.ts` — `getCandidates` accepts what we need (workdir, types, min_trust).
- `src/memory/auto-extract-berry.ts` — unrelated gate; leave alone.
- `src/cli/cmd-memory-ops.ts` — hook script unchanged; delta logic is internal to `auto-extract`.

**Open design questions for the plan:**
1. Fetch existing memories **before** LLM (prompt-side delta) or **after** validation (post-filter)? Pre-LLM saves tokens but bloats the prompt; post-filter is simpler but pays for duplicate generations.
2. Identity match: by `content_hash` (60s dedup field at `types.ts:48`), `entity_key`, or fuzzy similarity?
3. Where does the `skipped:duplicate-of-existing` count go — separate audit field or extend `lessons_failed`?
