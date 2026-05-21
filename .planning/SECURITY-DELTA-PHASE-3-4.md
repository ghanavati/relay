---
doc_type: security_delta_audit
audit_for: v0.2 Phase 3 (agentic LM Studio runner) + Phase 4 (embeddings wire-up)
baseline_ref: ./SECURITY-BASELINE.md
audited_at: 2026-05-20
auditor: gsd-security-auditor (read-only inspection of src/, no code changes)
asvs_level: 2
---

# Security Delta — Phase 3 + Phase 4 (post-merge to main)

Net-new threat surface vs. `SECURITY-BASELINE.md`. Implementation files are READ-ONLY for this audit; gaps surface as remediation notes only.

---

## Risk Summary

| Severity | Phase 3 | Phase 4 | Action |
|----------|---------|---------|--------|
| CATASTROPHIC | 1 (P3-G1: env inheritance to shell) | 1 (P4-G1: embedding endpoint locality gate missing) | FIX BEFORE v0.2 SHIP |
| HIGH | 0 | 0 | — |
| MEDIUM | 1 (P3-G2: sentinel collision narrow) | 1 (P4-G2: cosine clamp non-asserted) | DOC + add assertion |
| LOW | 3 verified mitigations | 4 verified mitigations | — |

**Headline:** 2 CATASTROPHIC gaps. Both are env-derived (`LMSTUDIO_ENDPOINT`, full `process.env` inheritance). Local-CLI threat model partially absorbs them (user IS the principal) but ship-blocking under ASVS L2 because the threat-model attestation in `SECURITY-BASELINE.md` §8 declared mitigation.

---

## Phase 3 — Agentic Runner

### P3-1. shell_exec cwd-clamp bypass — VERIFIED MITIGATED (with caveat)
- **Site:** `src/workers/lmstudio-agentic.ts:252-264` (`executeShellExec`), `:188` (schema strips `cwd`)
- **Evidence:** `cwd = workdir` is hard-coded; the model-emitted `cwd` field is silently dropped by `SHELL_EXEC_ARGS_SCHEMA.passthrough()` and never read. Test `:305-315` verifies model `cwd:'/etc'` is overridden.
- **Caveat (LOW residual):** `cwd` is passed verbatim to `execFile`. No `realpath()` / `lstat()` on `workdir` itself. If `task.workdir` IS a symlink to `/etc` (set at the dispatch layer), the clamp doesn't help. Baseline §6 documented symlink resolution as accepted risk for local-CLI v0.2 — this defect is in-scope of that acceptance, not a new gap. The user controls `task.workdir`.
- **Verdict:** CLOSED. Path-traversal via `../../etc` is structurally impossible because the model's cwd is ignored entirely.

### P3-G1. shell_exec env injection — CATASTROPHIC GAP
- **Site:** `src/workers/lmstudio-agentic.ts:190-220` (`defaultShellExec`)
- **Defect:** `execFile('/bin/sh', ['-c', args.command], { cwd, timeout, maxBuffer })` — the options object has NO `env:` field. Per Node.js docs, omitting `env` inherits the FULL `process.env` of the parent.
- **Impact:** Model-driven shell receives `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `LMSTUDIO_API_KEY`, `RELAY_BERRY_CMD`, `RELAY_DB_PATH`, future `FIGMA_API_TOKEN` (Phase 7), etc. A single model-emitted `env | grep -i key` exfiltrates everything. Compare to baseline §8 which declared *required* mitigation: "env scrubbed — NEVER inherit `FIGMA_API_TOKEN`, `ANTHROPIC_API_KEY` etc."
- **Baseline contrast:** `src/workers/codex.ts:435` uses `spawn(..., { env: invocation.envAdditions })` with an explicit allow-list. Phase 3 does NOT replicate this pattern.
- **Remediation:** add `env:` allow-list to options. Minimum safe set: `PATH`, `HOME`, `LANG`, `LC_ALL`, `TERM`, `USER`, `TMPDIR`. Refuse to pass through any var matching `/KEY$|TOKEN$|SECRET$|PASSWORD$|CREDENTIAL$|RELAY_/i`.
- **Verdict:** OPEN — BLOCKS v0.2 SHIP per baseline §9 attestation.

### P3-2. 32KB stdout truncation — VERIFIED MITIGATED
- **Site:** `src/workers/lmstudio-agentic.ts:226-236` (`truncateBytes`), `:242-246` (`formatShellResult`)
- **Evidence:** Buffer.subarray(0, maxBytes) followed by toString('utf-8'); split-codepoint left to U+FFFD substitution (documented at `:231-232`). Marker `…[TRUNCATED: original N bytes]` appended. Test `:317-335` asserts bound. Marker is OUTSIDE the JSON envelope of any tool-result (it's prefixed with literal `STDOUT:\n`), so it cannot be parsed as truthy JSON — `formatShellResult:245` wraps everything in a fixed string template that includes `\n\nSTDERR:\n` and `\n\nEXIT: <n>`, ensuring the truncation site is always inside a string, never structurally adjacent to a JSON brace.
- **Verdict:** CLOSED. No partial-JSON parsing concern — output is plaintext, never JSON.

### P3-G2. Tool-call-id sentinel collision — MEDIUM (narrow)
- **Site:** `src/workers/lmstudio-agentic.ts:422` (`EMPTY_ID_SENTINEL = '__missing__'`), `:600-609`
- **Defect:** If an attacker controlling the model emits a tool_call with `id: '__missing__'` (legit string), the runner's empty-id branch DOES NOT fire (length > 0), so it goes through `executeToolCall` normally. BUT if the model emits an empty id THEN later a real id of `__missing__`, both tool-result messages would echo the same `tool_call_id`. The OpenAI tool-loop protocol does not require uniqueness within a conversation, but downstream model behavior is undefined — could conflate results.
- **Impact:** LOW in practice — the model itself authors both ids. The sentinel `__missing__` is reserved internally and never echoed in a way a user could control. The only way to trigger collision is if the model deliberately emits `__missing__` as a literal id, which is benign self-confusion.
- **Remediation (defense-in-depth):** use a sentinel that cannot appear naturally — e.g. include a per-run nonce: `__relay_missing_${randomUUID()}__`. Cheap; eliminates the theoretical collision entirely.
- **Verdict:** OPEN (cosmetic/defense-in-depth; not a blocker).

### P3-3. Loop budget exhaustion (>20 unique calls) — VERIFIED MITIGATED
- **Site:** `src/workers/lmstudio-agentic.ts:490` (`for iterations = 1; iterations <= this.maxIterations`), `:615-620` (UNSUPPORTED on cap hit)
- **Evidence:** Iteration cap is a hard upper bound; attacker emitting 20 UNIQUE calls (hash-detector won't fire) still exits with `UNSUPPORTED: iteration cap hit`. Test `:512-528` confirms 20 unique calls → UNSUPPORTED, exactly 20 chat POSTs. No way to extend beyond the cap. Wall-clock timeout via `AbortController(task.timeout_ms)` at `:469-470` is an orthogonal second-layer cap.
- **Verdict:** CLOSED.

### P3-4. Capability probe leakage — VERIFIED MITIGATED (with caveat)
- **Site:** `src/workers/lmstudio-agentic.ts:336-397` (`probeCapability`)
- **Evidence:** Probe GETs `/v1/models`, parses `data[].id` + `data[].capabilities` only. No body content is logged — failure paths at `:362-395` quote only HTTP status, network error message, or the literal model id (which the user provided). The model id passed back in error messages is user-controlled input, so reflection is safe.
- **Caveat (LOW):** The HTTP status text from a 4xx/5xx body IS logged inside `makeError('PROVIDER_ERROR', ...)`. If LM Studio ever surfaces a stack trace or env var in its error body, that would leak into Relay's `run` logs. LM Studio's known behavior is conservative (it returns short JSON envelopes), so practical risk is low.
- **Verdict:** CLOSED (verify the LM Studio error-body shape in Phase 7 audit when more endpoints are added).

### P3-5. LFM2 nudge injection (regex too broad) — VERIFIED MITIGATED
- **Site:** `src/workers/lmstudio-agentic.ts:56` (`LFM2_MODEL_RE = /^liquid\/lfm2-/i`)
- **Evidence:** Anchored `^` start + `-` after lfm2 — matches only `liquid/lfm2-*`. A malicious model name like `evil/lfm2-` (no `liquid/` prefix) does NOT match. Case-insensitive flag is intentional (test `:771-783`). The nudge content is a fixed string from a const (line 85-86), so even if the regex over-matched, the worst case is appending a 17-word JSON-format instruction to a non-LFM2 system prompt — degraded behavior, not a security boundary.
- **Verdict:** CLOSED.

### P3-6. tool_call_id collision across concurrent dispatches — VERIFIED ISOLATED
- **Site:** `src/cli/cmd-parallel.ts` (per-task `LmStudioAgenticRunner` instance), `src/workers/lmstudio-agentic.ts:434-438` (constructor)
- **Evidence:** Each `executeParallelCommand` task constructs its own `new LmStudioAgenticRunner()` instance. The runner holds NO cross-task state — `messages: ChatMessage[]` is a local variable inside `run()` (`:480`), `recentTurnHashes` is local (`:488`). Tool-call-id echo is per-run and never crosses run boundaries. The only module-scope state is the `EMPTY_ID_SENTINEL` constant — read-only.
- **Verdict:** CLOSED. Concurrent dispatches are fully isolated.

---

## Phase 4 — Embeddings Wire-Up

### P4-1. Embedding content leak (PII recoverable from vectors?) — VERIFIED MITIGATED
- **Site:** `src/memory/memory-store.ts:430,488` (sanitize → schedule embed)
- **Evidence:** `sanitizeContent()` (line 52-55) applies `redactSecrets()` + strips `<private>` blocks BEFORE the variable `content` is assigned. `scheduleEmbed(memoryId, content)` at line 488 uses the SANITIZED string. Same pattern in `upsert()` at `:526,596`. Embeddings are therefore computed over already-redacted text — secrets never reach LM Studio. Vector inversion attacks on nomic-embed-text-v1.5 cannot recover the redacted spans because those bytes were never encoded.
- **Verdict:** CLOSED.

### P4-G1. Embedding endpoint locality gate — CATASTROPHIC GAP
- **Sites:**
  - `src/memory/memory-store.ts:289` (`endpoint = process.env['LMSTUDIO_ENDPOINT'] ?? 'http://127.0.0.1:1234'`)
  - `src/memory/semantic-similarities.ts:136` (same fallback, no locality check)
  - `src/memory/embedding-client.ts:75-77` (`getFetch` does not gate on host)
- **Defect:** `isLocalEndpoint()` exists at `src/cli/cmd-memory-auto-extract.ts:826-835` and IS applied to the auto-extract LLM POST (`:359`). It is NOT applied to embedding POSTs. A user (or a malicious config file) that sets `LMSTUDIO_ENDPOINT=https://attacker.example.com:1234` will silently POST every memory write (already-sanitized, but still user content) AND every recall query text to the attacker.
- **Impact:** Each `remember()` / `upsert()` POSTs the sanitized content + the active model name; each `handleRecall()` / `handleMemorySearch()` POSTs the query text. Baseline §9 declared the required mitigation: "Same endpoint-locality gate as auto-extract MUST cover embedding endpoint." This is NOT implemented.
- **Remediation:** import `isLocalEndpoint` from `cli/cmd-memory-auto-extract.ts` (or relocate it to a shared helper) and gate the embedding endpoint in BOTH `memory-store.ts:289` (write-time) and `semantic-similarities.ts:136` (read-time). On non-local + no `allow_remote` consent flag → return `{ ok: false, reason: 'remote-llm-blocked' }` and emit one deduped stderr warning. Existing dedup machinery at memory-store.ts:329-336 can carry the new reason.
- **Verdict:** OPEN — BLOCKS v0.2 SHIP per baseline §9 attestation.

### P4-2. Cross-model contamination (different model, same dim) — VERIFIED MITIGATED
- **Site:** `src/memory/semantic-similarities.ts:170-172`
- **Evidence:** `for (const [id, { blob, model: rowModel }] of rawByCandidate) { if (rowModel !== model) continue; ... }` — exact-string match on `embedding_model`. Even if two models produced identical 768-dim outputs, the rowModel mismatch causes the row to be skipped entirely. The `getRawEmbeddings` SQL at memory-store.ts:370-377 returns the `embedding_model` column with every blob, so the comparison runs against persisted metadata not a stale assumption.
- **Verdict:** CLOSED.

### P4-3. queueMicrotask race (unawaited Promise leaks content in failure log?) — VERIFIED MITIGATED
- **Site:** `src/memory/memory-store.ts:286-311` (`scheduleEmbed`), `:329-336` (`warnEmbedSkipped`)
- **Evidence:** The microtask body chains `.then()` → handle ok/!ok, and `.catch(() => {})` swallows any rejection silently. The warning at `:332-335` contains ONLY the reason string and a static "Run 'relay doctor' to check" hint — NO content, NO query text, NO memory_id, NO workdir. The dedup mechanism (per-instance Set) ensures one warning per reason per MemoryStore instance. UPDATE failure is wrapped in try/catch at `:297-301` — also silent.
- **Verdict:** CLOSED. No content leakage; matches T-04-02 attestation in plan.

### P4-G2. Cosine threshold misuse (similarity > 1.0 / < -1.0) — MEDIUM (assertion absent)
- **Site:** `src/memory/semantic-similarities.ts:87-101` (`cosineSimNormalized`), `:174-177`
- **Defect:** Cosine math is mathematically bounded `[-1, +1]`, but the implementation does NOT assert this. The clamp at `:175-176` (`Math.max(0, Math.min(1, raw))`) silently maps anti-similar vectors to 0 and over-similar (floating-point noise above 1.0) to 1. If a future code change introduces a bug that pushes `raw` outside `[-1, +1]` (e.g. mismatched vector lengths, NaN propagation through a partially-normalized vector), the clamp would silently mask it. There IS a length-mismatch guard (`:88`) and a zero-magnitude guard (`:99`), but no NaN/Infinity guard on the floats themselves.
- **Impact:** Currently low — nomic outputs are well-behaved per model card. Risk activates when a future model swap (RELAY_EMBEDDING_MODEL change) introduces a non-normalized model whose stored blobs round-trip through `blobToFloat32` and produce non-finite values. Without an assert/log, silently-wrong recall scores would leak into the engine.
- **Remediation:** add `if (!Number.isFinite(raw)) { warn('non-finite cosine'); return 0; }` before the clamp at `:175`. Cost: 2 lines, zero perf impact.
- **Verdict:** OPEN (defensive hygiene; not a blocker).

### P4-4. Workdir scoping preserved through embedding pipeline — VERIFIED MITIGATED
- **Sites:** `src/memory/memory-store.ts:427,519,738,965` (all SELECT-paths gated via `assertWorkdirAllowed`)
- **Evidence:** `getCandidates(query)` at memory-store.ts:738 (called from `tools/recall.ts:26` and `tools/memory_search.ts:38`) invokes `assertWorkdirAllowed(query.workdir)`. The candidates returned to `computeSemanticSimilarities` are already scope-filtered — the embedding helper only sees rows the caller is authorized to read. `getRawEmbeddings(ids)` at `:366` accepts IDs (no workdir filter), but since the candidate IDs came from a workdir-filtered query, the inherited scope holds. Cross-workdir leak via embedding helper is structurally impossible IF `RELAY_MEMORY_ALLOWED_WORKDIRS` is set.
- **Verdict:** CLOSED.

### P4-5. Embedding blob storage hygiene (size + alignment) — VERIFIED MITIGATED
- **Site:** `src/memory/semantic-similarities.ts:172` (corrupt-blob skip), `:64-75` (`blobToFloat32` alignment fallback)
- **Evidence:** `if (blob.byteLength !== EXPECTED_EMBEDDING_DIM * 4) continue;` rejects malformed blobs (e.g. row from an old model that stored a different dim). `blobToFloat32` handles 4-byte misalignment with a copy fallback, preventing UB. `embedding-client.ts:222-224` refuses to return a vector when `arr.length !== EXPECTED_EMBEDDING_DIM` (`wrong-dim` reason) — defense-in-depth.
- **Verdict:** CLOSED.

---

## Verification Method

Direct read of `src/` + grep across known mitigation sites. No code changes. All claims trace to a file:line citation in this report.

---

## Required Actions Before v0.2 SHIP

1. **P3-G1 (CATASTROPHIC):** add `env:` allow-list to `defaultShellExec` in `src/workers/lmstudio-agentic.ts:195`. Pattern: copy `codex.ts:435` shape, but adapted for `execFile` instead of `spawn`. Block any var matching `/KEY$|TOKEN$|SECRET$|PASSWORD$|CREDENTIAL$|RELAY_/i`. Add a test in `lmstudio-agentic.test.ts` that asserts the spawned shell sees ONLY the allow-listed vars.
2. **P4-G1 (CATASTROPHIC):** apply `isLocalEndpoint` gate in `src/memory/memory-store.ts:289` (`scheduleEmbed`) and `src/memory/semantic-similarities.ts:136`. Relocate `isLocalEndpoint` from `cli/cmd-memory-auto-extract.ts:826` into a shared module (e.g. `src/security/endpoint-locality.ts`). Default behavior on non-local + no `allow_remote` consent: silently skip embedding with a deduped warning `RELAY: embedding skipped (remote endpoint blocked — set consent.allow_remote=true)`.
3. **P3-G2 (cosmetic):** swap `EMPTY_ID_SENTINEL` literal for a per-run unique value. Cheap.
4. **P4-G2 (hygiene):** add `Number.isFinite(raw)` guard before cosine clamp. Cheap.

Re-audit after items 1+2 land. Items 3+4 may ship as follow-ups but should be tracked.
