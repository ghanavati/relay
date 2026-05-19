# Research Synthesis — Relay v0.2

**Confidence:** HIGH (4 research files + verified against shipped v0.2 partials)

## Executive Summary

Relay v0.2 layers five capabilities on top of v0.1.2's 1003-test baseline. Research confirms minimal-stack discipline: only `ws@^8.20.1` + `@types/ws@^8.18.1` are new runtime adds. Embeddings, conflict detection, agentic loops, Figma REST all use native `fetch` + existing Zod + better-sqlite3.

**Partial v0.2 already shipped:** embedding client (8.3K, 18 tests), `embedding_blob` BLOB column, `BudgetStore.getUsage()` with provider/workdir/period scoping, `cmd-budget` v0.2 impl with all flags, budget scope CHECK constraint expanded. **Embedding client exists but NOT yet wired into `budgetedRecall`** — that's the open work.

**Remaining v0.2 scope:** (1) schema cleanup + `schema_version`, (2) agentic LM Studio runner, (3) Figma tools (depends #2), (4) conflict detection, (5) wiring embeddings into scoring, (6) delta extraction.

---

## 1. Stack Additions

| Package | Version | Purpose |
|---|---|---|
| `ws` | `^8.20.1` | Figma Desktop Bridge WebSocket (Phase 6 only, deferred) |
| `@types/ws` (dev) | `^8.18.1` | Type defs |
| `@figma/rest-api-spec` (dev, optional) | `^0.38.0` | Figma REST typings |

### DO-NOT-add
- `axios` / `node-fetch` — native fetch mandatory
- `openai` SDK — 2MB+ for wire format we call directly
- `figma-api@2.2.0-beta` — depends on axios
- `zod@4.x` — breaking rewrite, invalidates 1003 tests
- `sqlite-vec` — alpha; premature at <50k vectors
- `tiktoken` — wrong tokenizer for nomic
- ANN libs (`hnswlib-node`, `faiss-node`, `lancedb`) — linear scan beats index overhead at our scale
- `dotenv`, `ajv`, `socket.io`, `vm2`/`isolated-vm`, `express`/`fastify`/`hono`
- Codex CLI for v0.2 implementation (PROJECT.md constraint)

---

## 2. Feature Table Stakes

### F1 — Schema cleanup
- `schema_version` table gates DROPs
- Drop 11 orphans honoring FK order (task_deps→tasks→jobs→job_events; sign_off triggers→amendments→sign_offs; recipes→continuity_objects)
- v0.1.2 fixture DB checked into `src/memory/__fixtures__/` MANDATORY (CC.1)
- `.v1-backup` via better-sqlite3 online backup API; opt-out via `RELAY_SKIP_V2_BACKUP=1`

### F2 — Agentic LM Studio runner
- `WorkerTask.tools[]` + `WorkerResult.{tool_call_count, iterations}`
- Iteration cap 20 (configurable), `AbortController` wall-clock, `stream: false`
- Hash-loop detector: `sha256(name + canonicalJsonStringify(sortedArgs))`, abort on 3 consecutive matches
- `tool_call_id` byte-exact echo (never normalize)
- Capability pre-check via `GET /api/v0/models`
- `RELAY_LMSTUDIO_DEBUG_DUMP=1` writes pairs to `~/.relay/debug/`
- LFM2 system-prompt nudge ensures JSON (else Pythonic default)
- Standalone runner (not GenericHttpRunner subclass)

### F3 — Conflict detection
- `conflicts_with_json TEXT NOT NULL DEFAULT '[]'` PRAGMA-guarded ALTER
- Detection at WRITE time vs ≤50 same-workdir candidates (NOT recall)
- Reciprocal: new memory + retroactive UPDATE on peers, same transaction
- Default `ANNOTATE_BOTH`; configurable `RecallOptions.conflictPolicy`
- Pinned never dropped; `min-shared-tags ≥ 2` floor
- Two-pass recall: pure `scoreCandidates()` → pure `resolveConflicts()` → packToBudget

### F4 — Semantic embeddings (wire-up)
- ✅ `src/memory/embedding-client.ts` (8.3K, 18 tests, 768-dim nomic)
- ✅ `embedding_blob BLOB` column (3072 bytes/row, little-endian Float32Array)
- TODO: wire `embedText(query)` into recall flow; compute cosine; pass `similarities` map into scorer
- `scoreMemoryDetailed(memory, query, opts?: { semanticSimilarity?: number })` — replaces `contentScore` when present
- Write-path: sync INSERT, background micro-task for `embedText()` + lazy UPDATE
- Fallback when `embedding_blob IS NULL` → word-overlap
- `embedding_model` column refuses cross-model comparison
- Doctor probe `/v1/embeddings`; stderr-loud fallback

### F5 — Delta extraction
- `buildPrompt(transcript, existing: readonly Memory[])`
- `getCandidates({ workdir, token_budget: 4000 })` prefetch
- Pre-flight prompt-size check: `< contextLimit * 0.8`, abort `EXTRACT_PROMPT_TOO_LARGE`
- Repeats bump `recall_count`/`accessed_at` — no new entry
- Contradictions populate `conflicts_with_json` on new memory
- Berry hallucination gate mandatory (PRIV-06)
- Queue-and-detach: SessionEnd writes `.relay/queue/pending-extraction-*.json`, exit 0 within 5s

### F6 — Figma (depends F2)
- `figma_list_layers`, `figma_update_token` — REST (`X-Figma-Token`)
- `figma_get_selection`, `figma_create_component` — DEFERRED to v0.3 (Plugin API bridge)
- PAT at `~/.relay/secrets/figma.json` (chmod 600), workdir-scoped binding at `<workdir>/.relay/figma.json`
- Hard error `BRIDGE_UNAVAILABLE` — never silent success
- Plan-tier detection: filter `figma_update_token` for non-Enterprise (403)
- Rate-limit wrapper: sleep on `Retry-After`, one retry, then hard error
- PAT scrubbing in all debug logs

### F7 — Budget (mostly shipped)
- ✅ `getUsage()` provider/workdir/period scoping
- ✅ `cmd-budget` v0.2 impl with all flags
- ✅ Scope CHECK constraint expanded
- Remaining: verify chaining with F1 `schema_version` migration

---

## 3. Architecture Decision: F4 (Embeddings) BEFORE F3 (Conflict)

**Delta from ROADMAP §Sequencing:** swap items 3 and 4. Wire embeddings into scoring BEFORE conflict detection ships.

### Rationale
1. **Conflict detection residual is weak with Jaccard, strong with cosine.** "High tag overlap + LOW content overlap = conflict" produces spurious flags on paraphrases when divergence is Jaccard tokens.
2. **Embedding infrastructure is already 70% in.** Remaining work is ~150-200 LoC plumbing. Smaller than starting F3 cold.
3. **Conflict detection rework risk.** Ship F3 with Jaccard → users tune → F4 lands → re-tune. Doing F4 first means F3 lands at correct quality first time.
4. **F5 also benefits from F4 first.** Delta's top-K candidate selection is sharper with embedding similarity.

### Revised sequence

```
1. F1  Schema cleanup            (prerequisite)
2. F7  Budget verify             (mostly done — verify schema_version chaining)
3. F2  Agentic LM Studio runner  (independent, unblocks F6)
4. F4  Wire embeddings → scoring (small plumbing; sharpens F3)
5. F3  Conflict detection        (lands at quality)
6. F5  Delta extraction          (composes F3 column + F4 ranking)
7. F6  Figma tools               (parallel-able after F2)
```

---

## 4. Watch Out For (top 10 by blast radius)

| # | Pitfall | Phase | Blast Radius |
|---|---|---|---|
| 1 | v0.1.2→v0.2 DB upgrade breaks recall | F1 | CATASTROPHIC — data-loss |
| 2 | Figma PAT leaked in debug logs / committed `.env` | F6 | CATASTROPHIC — credential rotation + git history scrub |
| 3 | Workdir scoping leak across features | F3+ | HIGH — cross-project memory contamination |
| 4 | Hook exit-0 discipline erodes | F2/F4/F5 | HIGH — CC disables Relay hook |
| 5 | `memory-engine.ts` purity erodes | F4 | HIGH — 28 callers refactored, recall latency cliffs |
| 6 | Embedding silent NULL fallback | F4 | MEDIUM — designer can't trace recall regression |
| 7 | JSON fence drift / Pythonic tool calls | F2 | MEDIUM — model "completes" with 0 tool calls |
| 8 | Hash-less token loop burns budget | F2 | MEDIUM — 5min + 200K tokens before max-iter |
| 9 | Embedding dimension mismatch / model swap | F4 | MEDIUM — recall quality cliffs to zero, no error |
| 10 | Figma bridge silent success / port-scan race | F6 | MEDIUM — model says "Done" when nothing happened |

### Enforcement gates
- `src/memory/__fixtures__/v0.1.2-baseline.db` fixture (must pass before F1 merge)
- CI lint: `memory-engine.ts` only imports `./types`, `./constants`
- CI grep: no `FROM memories` outside `MemoryStore`
- CI grep: no `throw` in `cmd-*-hook.ts` without top-level catch
- Doctor checks per service (berry, lmstudio_embed, lmstudio_agentic, figma_bridge, figma_plan)
- Fixture-based mocks (no hand-written) for LM Studio + Figma

---

## 5. Phase Dependency Graph

```
                  ┌─────────────────────────────────────┐
                  │ F1: Schema cleanup +                │
                  │     schema_version table            │  PREREQUISITE
                  │     + v0.1.2 fixture                │
                  └─┬──────────┬───────────────────────┬┘
                    │          │                       │
              ┌─────┘          │                       └──────┐
              ▼                ▼                              ▼
   ┌──────────────────┐ ┌────────────────────┐  ┌──────────────────┐
   │ F7: Budget verify│ │ F2: Agentic LM     │  │ F4: Wire embed   │
   │ (✅ mostly done) │ │     Studio runner  │  │  into scoring    │
   └──────────────────┘ └─────┬──────────────┘  └────┬─────────────┘
                              │                      │
                              │                      ▼
                              │            ┌──────────────────────┐
                              │            │ F3: Conflict         │
                              │            │  detection           │
                              │            └────┬─────────────────┘
                              │                 │
                              │                 ▼
                              │       ┌─────────────────────────┐
                              │       │ F5: Delta extraction    │
                              │       └─────────────────────────┘
                              ▼
                  ┌────────────────────────┐
                  │ F6: Figma tools (REST) │
                  │ (Plugin bridge → v0.3) │
                  └────────────────────────┘
```

**Critical path:** F1 → F4-wire → F3 → F5
**Parallel branches:** F7 (mostly done), F2 (gates F6), F6 (off F2)

---

## 6. Open Questions

1. **F1 fixture provenance** — anonymized user DB or synthetic?
2. **F2 tool dispatch** — `RELAY_LMSTUDIO_AGENTIC=1` env or `WorkerTask.agentic === true`?
3. **F4 wire-up** — sync vs async embed-at-write? Background micro-task = unawaited Promise or `setImmediate`?
4. **F3 default threshold** — start at `1 - cosine > 0.5`?
5. **F6 file_key origin** — workdir consent file or env var?
6. **F6 bridge protocol version** — `"0.2.0"` (mirrors Relay) or independent `"1"`?
7. **F5 queue worker invocation** — cron / next SessionStart hook / manual?
8. **Schema versioning scope** — only Relay tables, or budget chains in?

---

### Confidence

Overall: HIGH

| Area | Confidence | Notes |
|---|---|---|
| Stack | HIGH | All versions verified live against npm registry 2026-05-18 |
| Features | HIGH | LM Studio + δ-mem + Mem0/A-MEM + Figma blog primary sources |
| Architecture | HIGH | Direct read of `src/` + 5 scrap maps with file:line citations |
| Pitfalls | HIGH | Grounded in scrap maps + ROADMAP-DRIFT + codex wave-4 incidents |
| v0.2 partial-status | HIGH | Verified against recent commits + `package.json` + shipped files |

**Gaps:** 8 open questions above (no source can resolve — require user decision).
