# DELTA-MEM-CONFLICT — Research for ROADMAP #3

**Researched:** 2026-05-18
**Domain:** LLM agent memory — conflict detection at write & recall time
**Confidence:** HIGH (paper equations, prior-art algorithms, codebase schema all verified)
**Scope:** Research only — no code changes. Anchors a v0.2 design proposal for `MemoryStore.remember()` and `budgetedRecall()`.

---

## 1. δ-mem paper — provenance & operational error signal

### Citation (VERIFIED)
- **Title:** *δ-mem: Efficient Online Memory for Large Language Models*
- **arXiv ID:** `2605.12357` (submitted 12 May 2026) [CITED: arxiv.org/abs/2605.12357]
- **Authors:** Jingdi Lei, Di Zhang, Junxian Li, Weida Wang, Kaixuan Fan, Xiang Liu, Qihan Liu, Xiaoteng Ma, Baian Chen, Soujanya Poria (declare-lab) [CITED: arxiv abstract page]
- **Code:** `github.com/declare-lab/delta-Mem` [CITED]

### The error signal (extracted from PDF, Section 2, Eqs. 1–2)
Given memory key `kₜ ∈ ℝʳ` and value `vₜ ∈ ℝʳ` at position `t`, with state matrix `Sₜ₋₁`:

> **Prediction:** `v̂ₜ = Sₜ₋₁ · kₜ` *(what the existing memory believes about this key)*
> **Loss:** `Lₜ(S) = ½ ‖S kₜ − vₜ‖²` *(squared residual)*
> **Update:** `Sₜ = Sₜ₋₁ + βₜ (vₜ − Sₜ₋₁ kₜ) kₜᵀ` ← **the delta rule**

The paper itself writes:
> *"This formulation writes only the residual information along the key direction. Consequently, well-learned associations induce negligible updates, whereas predictive discrepancies dynamically correct the memory state."* (§2, line 125–127) [CITED: PDF p.2]

### Operational interpretation
- `kₜ` = the *cue* / index under which the new fact is filed
- `vₜ` = the *target* — what the new evidence says the answer should be
- `Sₜ₋₁ · kₜ` = the *prior belief* — what current memory would have answered if asked under that cue
- `(vₜ − Sₜ₋₁ kₜ)` = **the conflict magnitude**: zero ⇒ memory already agrees, no write needed; large ⇒ contradicts prior, must correct
- `βₜ ∈ (0,1)` = per-write learning rate (in δ-mem, gated; in our analog, becomes a trust-weighted blend factor)

**One-liner:** *δ-mem only writes when memory is wrong, and writes proportional to how wrong.* That is exactly the property Relay needs at SQLite scale.

---

## 2. Translating the signal into Relay's row-based model

Relay has no parametric `M`; memories are SQLite rows with `content TEXT`, `tags_json TEXT`, `trust_level TEXT`, `memory_id TEXT PRIMARY KEY`, `superseded_by TEXT` [VERIFIED: `src/memory/db-migrations.ts` lines 16–89]. The "matrix prediction" `Sₜ₋₁ · kₜ` has no literal equivalent — but the *idea* — *does my existing store already encode an answer for this cue?* — does.

### Analog mapping

| δ-mem (parametric)      | Relay (row-based)                                                  |
|--------------------------|---------------------------------------------------------------------|
| `kₜ` (key vector)        | Tag set `T_new = M_new.tags` (later: embedding of content)          |
| `vₜ` (value vector)      | Content tokens `C_new = tokenize(M_new.content)`                    |
| `Sₜ₋₁ · kₜ` (prediction) | Set of existing memories `R_existing` whose tags overlap with `T_new` |
| `(vₜ − Sₜ₋₁ kₜ)`         | **Content divergence** between `C_new` and each `r ∈ R_existing`    |
| Conflict signal          | High **tag overlap** ∧ low **content overlap** ⇒ same topic, different claim |

This is the heuristic stand-in for the residual. Once embeddings ship (ROADMAP #4), the second axis becomes `1 − cos(emb(new), emb(existing))` — much closer to the δ-mem residual norm.

---

## 3. Prior art (verified)

### Mem0 (arXiv 2504.19413, production system) [CITED]
- LLM-driven decision per new fact: `ADD | UPDATE | DELETE | NOOP` against top-K vector-similar candidates [CITED: mem0.ai docs, deepwiki/mem0ai]
- Default similarity threshold 0.1; M=10 recent turns extracted, K=10 candidates re-ranked [CITED: emergentmind.com/topics/mem0-system]
- **Contradiction handling:** `DELETE` marks the old record obsolete (soft-delete) — `"the latest truth wins"` but history is preserved for temporal reasoning [CITED: medium.com Mem0 architecture writeup]
- **Cost:** every write triggers an LLM call. Relay's instinct of using *cheap symbolic features first* avoids that cost.

### A-MEM (NeurIPS 2025, arXiv 2502.12110) [CITED]
- Zettelkasten-style: each new memory generates **keywords + tags + contextual description** via LLM, then SBERT embedding [CITED: A-MEM paper §3]
- New observation links to top-K embedding-similar prior memories, then an LLM **"retroactively updates the content and tags of past memories"** to maintain a "contradiction-free internal state" [CITED: A-MEM abstract]
- **Key insight worth stealing:** *bidirectional update* — when conflict is detected, both the new and the old memory are touched. Relay's proposed `conflicts_with_json` should be reciprocal for the same reason.

### Letta / MemGPT [CITED: letta.com, sureprompts.com]
- No automated conflict resolver in core. **Agent-driven**: the LLM itself decides via tool calls when to rewrite a core-memory block.
- Newer "Context Repositories" feature uses **git-style merge** for parallel subagent writes [CITED: letta.com/blog/context-repositories]
- Lesson: **don't auto-delete** — surface conflict to the consumer (the agent), let it decide. Maps to Relay's "annotate, don't drop" recall option.

### Generative Agents (Park et al., arXiv 2304.03442, CHI/UIST 2023) [CITED]
- No explicit contradiction detection. Conflict resolution emerges from **reflection** — periodic LLM passes generate higher-level abstractions over base observations.
- Importance score (mundane vs. core) is the only metadata signal; retrieval = `α_recency · recency + α_importance · importance + α_relevance · relevance` [CITED: arxiv 2304.03442 §4]
- Less directly applicable but confirms: **provenance + scoring**, not deletion, is the conventional first move.

### DeltaNet (Schlag/Yang et al., arXiv 2406.06484, NeurIPS 2024) [CITED]
- Pure-NN analog of the same delta rule δ-mem builds on: `Sₜ = Sₜ₋₁ − βₜ(Sₜ₋₁ kₜ − vₜ) kₜᵀ` [CITED: sustcsonglin.github.io deltanet-1 blog]
- Provides theoretical grounding: the delta rule is "online gradient descent on a quadratic loss" — what we want to approximate cheaply.

### Tag-overlap + content-divergence as conflict heuristic — prior art?
- **No paper directly uses this exact pair** (verified via tag-jaccard + contradiction searches — see Sources).
- Related: knowledge-graph conflict detection uses **same-subject + different-object** triples [CITED: mdpi.com 2227-7390/12/15/2318] — structurally identical: shared key (subject ≈ tags), different value (object ≈ content).
- PaTeCon (arXiv 2304.09015) mines temporal patterns over shared entity pairs [CITED].
- **Verdict:** The proposed heuristic is *novel as a packaged algorithm* but rests on a long lineage. It's defensible.

---

## 4. Proposed algorithm — write time (`MemoryStore.remember()`)

### Inputs
`M_new = { content, tags, trust_level, memory_type, workdir }` — already constructed by the caller.

### Step W1: build the candidate set
```
T_new = set(M_new.tags)                      # tag set
If |T_new| < 2:  skip conflict detection     # too few tags ⇒ too many false positives
candidates = SELECT memory_id, content, tags_json, trust_level
             FROM memories
             WHERE superseded_by IS NULL
               AND (workdir = M_new.workdir OR workdir IS NULL)
               AND memory_type = M_new.memory_type
               AND EXISTS (json_each(tags_json) WHERE value IN T_new)   -- SQLite json1
```
The `EXISTS` prefilter cuts the working set from N to typically O(few dozen) before we score in JS.

### Step W2: score each candidate
For each `c` in candidates:
```
T_c          = set(parse(c.tags_json))
tag_jaccard  = |T_new ∩ T_c| / |T_new ∪ T_c|
W_new        = tokenize(M_new.content)         # reuse existing tokenize() from memory-store.ts:173
W_c          = tokenize(c.content)
content_jac  = |W_new ∩ W_c| / |W_new ∪ W_c|
```

### Step W3: classify
```
IF tag_jaccard > 0.5  AND  content_jac < 0.3   →  CONFLICT
IF tag_jaccard > 0.5  AND  content_jac > 0.7   →  DUPLICATE  (defer to existing SHA dedup at memory-store.ts:295)
ELSE                                            →  UNRELATED
```
The two thresholds bracket the residual: high tag overlap = same key; low content overlap = different value = positive residual.

### Step W4: persist
```
conflict_ids = [c.memory_id for c in CONFLICT-class candidates]
IF conflict_ids non-empty:
  M_new.conflicts_with_json = JSON(conflict_ids)
  FOR each cid in conflict_ids:
    UPDATE memories
      SET conflicts_with_json = json_insert(coalesce(conflicts_with_json,'[]'), '$[#]', M_new.memory_id)
      WHERE memory_id = cid
```
**Reciprocal**, per the A-MEM lesson.

### Schema change required
Add one column (single ALTER, no migration cost):
```sql
ALTER TABLE memories ADD COLUMN conflicts_with_json TEXT NOT NULL DEFAULT '[]';
```
Aligns with the existing pattern at `db-migrations.ts:88` (PRAGMA-guarded ALTER).

---

## 5. Proposed algorithm — recall time (`budgetedRecall`, `memory-engine.ts:195`)

The current loop scores → sorts → greedily packs. Insert one pass between sort and pack.

### After sort, before budget loop:
```
// Build conflict-aware view: among the sorted candidates, identify pairs
conflict_map = Map<memory_id, ScoredMemory[]>   # id → list of its conflicts that are also in `candidates`
for each m in candidates:
  for cid in parse(m.conflicts_with_json):
    if cid in candidate_ids:
      conflict_map[m.memory_id].push(candidate_for[cid])

losers = Set<memory_id>()
annotations = Map<memory_id, string[]>()

for each m in candidates (sorted by score DESC):
  if m.memory_id in losers: continue
  for c in conflict_map[m.memory_id]:
    if c.memory_id in losers: continue
    winner, loser = rank_pair(m, c)        # see §6
    case ResolveMode:
      DROP_LOSER:        losers.add(loser.memory_id)
      ANNOTATE_BOTH:     annotations[winner.memory_id].push(`⚠ CONFLICTS WITH ${loser.memory_id}`)
                         annotations[loser.memory_id].push(`⚠ CONTRADICTED BY ${winner.memory_id}`)

// then run the existing greedy budget loop, skipping `losers` and decorating with `annotations`
```

### Why insert here (not at score time)
- Conflict is a *pairwise* property; scoring is *unary*. Conflating them gets confusing fast and bloats `scoreMemory`.
- This keeps `scoreMemory` pure and easy to test (already 100% covered in `score-memory.test.ts`).

### Default mode
`ANNOTATE_BOTH`. Don't silently delete — the LLM consumer is smarter than the heuristic. Drop only behind a feature flag (e.g. `recall.options.conflict_resolution: 'drop'|'annotate'`).

---

## 6. Pairwise precedence rule (`rank_pair`)

Conventional precedence from the multi-agent memory survey [CITED: techrxiv.org LLM_MAS_Memory_Survey]: **provenance → confidence → recency**.

```
function rank_pair(a, b):
  if a.trust_level != b.trust_level:
      return higher_trust(a, b)               // 'verified' > 'reviewed' > 'unverified'
  if abs(a.score - b.score) > 0.1:
      return higher_score(a, b)               // recall score already mixes recency+relevance
  return more_recent(a, b)                    // by created_at
```
This matches Mem0's "latest truth wins" *but only after* trust ties — which is the right risk-ordering for Relay's higher-stakes use case.

---

## 7. Complexity analysis

Let `N` = candidate set size after SQL prefilter (tag-overlap rows). In practice `N` is small (<50) because the tag prefilter already eliminates ~99% of the store.

| Approach            | Time              | Notes                                                    |
|---------------------|-------------------|----------------------------------------------------------|
| **Heuristic O(N)**  | N tokenize+jaccard | What we recommend. Tokenize ~100µs, jaccard ~10µs. Total ~5ms for N=50. |
| Pairwise O(N²)      | N² content-similarity comparisons | Only relevant at recall, where `N` = top-K (≤32). Still <1ms. |
| Clustering O(N log N) | hierarchical (e.g. agglomerative) | Overkill for N<50 and obscures the per-pair rationale we want. |

**At recall time** the pairwise pass is O(K²) where K is the recall candidate count (already bounded by the existing `MIN_RELEVANCE_SCORE` filter and budget). For K=32: 1024 comparisons of in-memory IDs — sub-millisecond.

**At write time** the SQL prefilter on `EXISTS (json_each(tags_json) WHERE value IN T_new)` is O(matched rows) thanks to a future index on a virtual table, or a plain seq-scan today (acceptable while the store is <100k rows).

---

## 8. False-positive risk & mitigation

### Failure mode
Two memories share tags (`docker`, `compose`) but describe different scopes — one about *production deployment*, one about *local dev*. Tag overlap = 1.0, content overlap might be ~0.2. The heuristic flags them as conflicts; they are not.

### Mitigations in priority order
1. **Require ≥2 shared tags** beyond the auto-extracted keywords (which are noisy). Drop the conflict candidate if `|T_new ∩ T_c| < 2`.
2. **Workdir scoping** is already in the SQL prefilter — different project = no conflict. Most false positives in practice will be cross-project, eliminated here.
3. **Memory type matching** — never flag conflicts across different `memory_type` values (e.g. don't compare a `decision` to a `fact`).
4. **Embedding gate (post-ROADMAP #4):** require `cos(emb(new), emb(c)) < 0.7` to confirm semantic divergence before flagging. This is the closest thing we'll have to δ-mem's `(vₜ − Sₜ₋₁ kₜ)` magnitude.
5. **Conservative default mode** — `ANNOTATE_BOTH`, never `DROP_LOSER` by default. False positives degrade to a harmless `⚠` line in the LLM's recall context.

### Calibration
Ship with **thresholds as constants in one file** (e.g. `src/memory/conflict-thresholds.ts`):
```typescript
export const CONFLICT_TAG_JACCARD_MIN  = 0.5;
export const CONFLICT_CONTENT_JAC_MAX  = 0.3;
export const CONFLICT_MIN_SHARED_TAGS  = 2;
```
Tune on a small annotated set before flipping to `DROP_LOSER`. Land annotation mode first, gather false-positive rate from real recall logs, then iterate.

---

## 9. What ships in v0.2 vs deferred

### v0.2 (this proposal)
- Schema: `conflicts_with_json TEXT DEFAULT '[]'` via PRAGMA-guarded ALTER
- Write-time: tag-jaccard + content-jaccard heuristic in `remember()` + `upsert()` paths
- Reciprocal updates on detection
- Recall-time: pairwise pass with `ANNOTATE_BOTH` default
- Thresholds module + unit tests for the four classifier cases (CONFLICT, DUPLICATE, UNRELATED, NEAR-MISS)

### Deferred to v0.3+
- Embedding-based residual (ROADMAP #4 prerequisite)
- LLM-judge fallback for ambiguous pairs (Mem0 pattern, but only if false-positive rate >5%)
- Pattern mining over the conflict graph (PaTeCon-style temporal constraints)
- User-facing `relay memory conflicts <id>` CLI subcommand

---

## 10. Open questions for design review

1. **Should `superseded_by` and `conflicts_with_json` co-exist or unify?** `superseded_by` is the deterministic dedup output; `conflicts_with_json` is the heuristic semantic output. Keeping them separate preserves auditability.
2. **Does the recall pairwise pass need to honor pinned status?** Recommend: yes — never drop pinned memories, only annotate.
3. **Where does workdir scoping live for cross-workdir memories (`workdir IS NULL`)?** Default to comparing only within the active workdir to start; revisit if global decisions need cross-workdir conflict.
4. **Token-budget interaction:** when a loser is dropped, its budget is reclaimed — should we backfill from the omitted list, or accept the saved budget? Recommend: backfill (preserves greedy packing invariant).

---

## Sources

### HIGH confidence (papers + code)
- δ-mem paper, arXiv 2605.12357 — equations 1–2 extracted from PDF via pdftotext
- declare-lab/delta-Mem GitHub repository — implementation reference
- DeltaNet, arXiv 2406.06484 (NeurIPS 2024) — origin of the delta-rule formulation for memory states
- DeltaNet explainer, Songlin Yang blog: https://sustcsonglin.github.io/blog/2024/deltanet-1/ — `Sₜ = Sₜ₋₁ − βₜ(Sₜ₋₁ kₜ − vₜ)kₜᵀ` quoted verbatim
- A-MEM, arXiv 2502.12110 (NeurIPS 2025) — SBERT embedding + retroactive update mechanism
- Mem0, arXiv 2504.19413 — ADD/UPDATE/DELETE/NOOP operations + 0.1 default threshold
- Generative Agents, Park et al., arXiv 2304.03442 — importance + retrieval scoring formula
- Relay codebase: `src/memory/memory-store.ts`, `src/memory/memory-engine.ts:195`, `src/memory/db-migrations.ts:16–89` — schema and recall-loop anchors

### MEDIUM confidence (technical writeups, surveys verified against papers)
- Mem0 architecture overview — medium.com/@zeng.m.c22381 (algorithm details cross-checked against Mem0 paper)
- deepwiki.com/mem0ai/mem0 — operation semantics
- Multi-agent memory survey — techrxiv.org LLM_MAS_Memory_Survey_preprint
- Letta context-repositories blog — letta.com/blog/context-repositories
- Detect-Then-Resolve KG conflict resolution — mdpi.com 2227-7390/12/15/2318
- PaTeCon temporal KG conflict, arXiv 2304.09015

### LOW / informational
- Hacker News δ-mem discussion — news.ycombinator.com/item?id=48158506 (community context only)
- emergentmind.com/topics/mem0-system — secondary summary
- D-MEM (arXiv 2603.14597) — *different paper*, dopamine-gated routing, **not the δ-mem cited here**. Disambiguation note.

---

## Metadata

**Confidence breakdown**
- δ-mem equations: HIGH — extracted from PDF Section 2, cross-verified against DeltaNet derivation
- Prior art: HIGH — all major systems (Mem0, A-MEM, Letta, Generative Agents) have paper-level sources
- Tag+content heuristic as published technique: MEDIUM — composition is novel; primitives are standard
- Threshold values (0.5, 0.3, 2): LOW — placeholder defaults, must be calibrated on real data before `DROP_LOSER` mode

**Research date:** 2026-05-18
**Valid until:** 2026-08-18 (90 days — memory-systems field is moving fast)
