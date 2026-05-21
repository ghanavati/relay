# nomic-embed-text-v1.5 — Production Characteristics for Phase 4 (Apple Silicon M4 Max)

**Researched:** 2026-05-20
**Domain:** Production reliability & perf budget for LM Studio embed-at-write
**Confidence:** HIGH (failure modes, dim/MTEB), MEDIUM (latency on M4 Max — extrapolated), MEDIUM (LM Studio bugs — confirmed open, scope partial)
**Companion:** `NOMIC-EMBED-SPECS.md` (API shape, prefixes, storage)
**Subject:** `text-embedding-nomic-embed-text-v1.5` Q4_K_M GGUF via LM Studio HTTP

---

## TL;DR for Phase 4

1. **`embed-at-write` is fine on M4 Max** — single short embed ~5–15 ms warm. Sub-second user-visible latency budget intact.
2. **LM Studio v0.3.34 has a confirmed embedding crash regression** with nomic Q4_K_M after 2–5 sequential embeds (Issue #171). **Not fixed in 0.3.35 / 0.3.36** per changelog scan. We MUST either (a) pin LM Studio to a known-good version (≤0.3.33), (b) detect HTTP 400 "model has crashed" and reload, or (c) keep word-overlap fallback resilient enough to absorb crashes. Phase 4's word-overlap-fallback design already provides (c).
3. **`usage.prompt_tokens` still always 0** (Bug #1546, opened Feb 2026, still open). `embedding-client.ts` already ignores it — no change.
4. **5s timeout in `embedding-client.ts` is appropriate for single embeds** (10–100× headroom). Insufficient for batch>32 of 2048-tok chunks — Phase 4 doesn't batch on the write path, so unchanged.
5. **No batching needed for Phase 4** — write path is `queueMicrotask`-per-memory, naturally serialized by event loop; LM Studio default concurrency is 4 which absorbs burst writes.

---

## 1. Latency Benchmarks on M4 Max

**No first-party Nomic or LM Studio benchmarks for M4 Max published as of research date.** Numbers below are extrapolated from the only documented Metal-accelerated embedding benchmark on llama.cpp (BERT-33M on M-series, Discussion #4167) scaled to nomic's 137M params (~4× the work) and adjusted for M4 Max's GPU vs the M1/M2 baseline.

| Scenario | Estimate (warm) | Source / Reasoning |
|----------|-----------------|---------------------|
| Single short text (~30 tok, `search_query: ` prefix included) | **5–15 ms** | [ASSUMED] Extrapolated from BERT 32-tok @ 8,952 tok/s on Metal → nomic ~4× slower → ~2,200 tok/s → 32 tok in ~14 ms |
| Single 512-tok chunk | **20–40 ms** | [ASSUMED] BERT 512-tok @ 24,147 tok/s → nomic ~4× slower → 512 tok in ~85 ms baseline; M4 Max likely 2× faster than baseline → 20–40 ms |
| Single 2048-tok chunk | **80–150 ms** | [ASSUMED] Scaling from above, near the saturation point of llama.cpp Metal kernel |
| Batch of 10 short texts (one HTTP call, `input: [...]`) | **30–80 ms** | [ASSUMED] Continuous batching overhead small; ~3–6 ms per item amortized |
| Batch of 100 short texts (one HTTP call) | **300–600 ms** | [ASSUMED] Linear in tokens; LM Studio crash-risk window per Issue #171 |

**Action:** Phase 4 plan should include a one-shot calibration task — embed 100 sequential single-call + 1 batch-of-10 against the actual dev machine, log to `.planning/measurements/embed-latency.json`. Replace estimates with measurements before Phase 5's cosine-calibrated false-positive gate.

Sources: [llama.cpp Apple Silicon perf discussion](https://github.com/ggml-org/llama.cpp/discussions/4167), [llama.cpp embeddings tutorial](https://github.com/ggml-org/llama.cpp/discussions/7712).

---

## 2. Cold-Start vs Warm-Call Latency

| Event | Observed / Estimated | Source |
|-------|----------------------|--------|
| `lms load text-embedding-nomic-embed-text-v1.5` (cold disk→VRAM) | **300–800 ms** one-time | [ASSUMED] 84 MB Q4_K_M off NVMe + Metal kernel JIT; consistent with `34–56 ms` "load time" reported in llama.cpp Issue #5846 for similar-size embedding model — those numbers measure the model-init phase only, not the full `lms load` workflow (which adds Metal compilation + server warmup) |
| First embed after load (kernel cold) | **+20–100 ms** vs warm | [CITED: llama.cpp #5846 — observes Metal kernel JIT compilation on first inference] |
| Steady-state warm | per §1 above | — |
| Model auto-unload after idle (LM Studio default) | TTL ≈ 5 min idle | [CITED: LM Studio "Just-In-Time Model Loading" docs] — next call re-incurs cold-start |

**Implication for Phase 4:** `queueMicrotask`-after-INSERT pattern (already in plan) is unaffected by cold-start because writes are fire-and-forget. **User-visible recall path** can hit cold-start if no embeds have run for ≥5 min. Mitigation options:

- (A) Accept ~500 ms first-recall latency after idle — acceptable for v0.2 (recall is interactive but not keystroke-hot)
- (B) Probe `/v1/models` on Relay daemon startup to pin the model loaded (already done by `probeEmbeddingsModel` in `embedding-client.ts`)
- (C) Disable LM Studio idle unload via UI (manual, not enforceable from Relay)

**Recommendation:** ship (A) + (B). Document (C) as user opt-in in the v0.2 setup guide.

---

## 3. Memory Overhead per Request on Metal Backend

| Component | Estimate | Notes |
|-----------|----------|-------|
| Resident model (Q4_K_M, loaded) | **~250–350 MB unified memory** | [CITED: morphllm.com — "nomic-embed-text v1.5 ~300MB VRAM"]; on Apple Silicon unified memory = system RAM |
| Per-request KV cache (ctx=2048) | **~12–24 MB** | [ASSUMED] KV ≈ 2 × n_layers × n_heads × head_dim × ctx × 2 bytes (FP16) — nomic has 12 layers × 12 heads × 64 head_dim → ~6 MB per 1024 tokens |
| Per-request transient activations | **~10–30 MB** | [ASSUMED] Freed after response |
| Peak with 4 concurrent (LM Studio default) | **~400–500 MB total** | (A) Model + 4× (KV + activations) |

**Headroom on M4 Max (36–128 GB unified):** trivial. Embedding model coexists with Codex/Qwen3-Coder LLM loads — no contention.

**Pitfall:** unified KV cache pre-allocation per LM Studio Parallel Requests docs means real RSS may be larger than per-request math suggests, but still <1 GB total.

Sources: [morphllm.com — Ollama Embedding Models](https://www.morphllm.com/ollama-embedding-models), [LM Studio Parallel Requests](https://lmstudio.ai/docs/app/advanced/parallel-requests).

---

## 4. Throughput Ceiling (tokens/sec)

| Mode | Tok/s (Metal, warm, M4 Max) | Notes |
|------|------------------------------|-------|
| Single-call serial (Phase 4 default) | **~2,000–4,000 tok/s** effective | [ASSUMED] |
| Batched (input: array of 16+) | **~5,000–10,000 tok/s** | [ASSUMED] Continuous batching enabled by default in LM Studio 0.4.0+ |
| Hard ceiling (Metal saturation) | **~30,000 tok/s** for 256-tok chunks per BERT-33M data | [CITED: llama.cpp #7712] Nomic 4× larger ≈ ~7,500 tok/s practical ceiling |

**Phase 4 demand:** writes are ~1 embed per `memory remember` call. Even at 100 remembers/min that's <100 tok/s — three orders of magnitude under ceiling. **Throughput is not a constraint for Phase 4.**

Source: [llama.cpp #7712 embeddings tutorial](https://github.com/ggml-org/llama.cpp/discussions/7712).

---

## 5. Best Practices for `embed-at-write` (Single vs Batch, Backpressure)

**Recommendation: single-call, no client-side batching, no explicit backpressure beyond `queueMicrotask`.**

Rationale:

1. **Write paths are naturally serialized.** `memory remember` is interactive; users don't ship 100 memories/sec.
2. **Batching adds latency to the first-stored memory** in the batch — defeats `queueMicrotask` "store-then-embed" pattern (memory becomes recallable immediately, embedding fills in async).
3. **LM Studio v0.3.34 crash window** [CITED: Issue #171] is 2–5 sequential embeds before crash. Batching would compress the crash window into a single HTTP call — worse failure mode (all-or-nothing) vs trickle (single-failure-isolated).
4. **`Max Concurrent Predictions` default = 4** [CITED: LM Studio Parallel Requests docs]. Concurrent writes >4 will queue server-side — fine because client never awaits.

**If batch is needed later** (e.g., Phase 8 backfill of historical memories):

- Cap batch at **16 inputs** per HTTP call (well under crash window for one call)
- Sequential batches, not concurrent (avoid the v0.3.34 OOM trigger)
- Bump per-call timeout to **15 s** for batch-of-16 of 2048-tok chunks
- Add `model has crashed` retry-with-probe (re-fire `/v1/models`, reload via `lms load` shell-out, retry once)

Sources: [LM Studio Parallel Requests](https://lmstudio.ai/docs/app/advanced/parallel-requests), [lmstudio-python Issue #171](https://github.com/lmstudio-ai/lmstudio-python/issues/171).

---

## 6. Failure Modes When Model Unloaded (LM Studio HTTP Codes)

| Scenario | HTTP Status | Body Shape | `embedding-client.ts` `reason` Coverage |
|----------|-------------|-----------|------------------------------------------|
| LM Studio not running | (no HTTP — TCP refused) | — | `unreachable` ✓ |
| LM Studio running, no model loaded | **404** "No models loaded. Please load a model in the developer page." | OpenAI-style `{ error: { message, type, code } }` | `http-4xx` ✓ — could refine to `not-loaded` by parsing body |
| Model loaded but wrong type (chat model on embed endpoint) | **400** "Model is not embedding" | error envelope | `http-4xx` ✓ |
| Model crashed mid-request (v0.3.34 bug) | **400** "The model has crashed without additional information. (Exit code: 18446744072635812000)" | error envelope | `http-4xx` ✓ — distinctive note; could route to `not-loaded` for retry-with-reload |
| Input > ctx (>2048 tok) | **400** "context length exceeded" | error envelope | `http-4xx` ✓ |
| Slow / hung | (timeout fires) | — | `timeout` ✓ |
| Response truncated mid-JSON | 200, then parse fail | malformed | `parse-error` ✓ |
| 503 / 5xx server distress | **500–599** | varies | `http-500` ✓ |

**Current `embedding-client.ts` reason taxonomy is complete for the v0.2 happy path.** Optional polish:

- Inspect 4xx body for `"crashed"` substring and surface a new `reason: 'crashed'` so callers can trigger `lms load` recovery instead of falling back to word-overlap silently.
- `probeEmbeddingsModel` already differentiates `not-loaded` via `/v1/models` — that's the canonical pre-flight check; in-flight 404 should be rare if probe ran first.

Sources: [Flowise #3157](https://github.com/FlowiseAI/Flowise/discussions/3157), [lmstudio-python #171](https://github.com/lmstudio-ai/lmstudio-python/issues/171).

---

## 7. Matryoshka Dim Truncation (768 → 256 → 64) — Storage vs Recall

| Dim | MTEB | Bytes/row | vs 768 storage | Quality drop | Verdict for Relay v0.2 |
|-----|------|-----------|----------------|--------------|------------------------|
| **768** | 62.39 | 3,072 | 1.00× | baseline | **Ship this.** Phase 4 plan stores 768-dim BLOB. |
| 512 | 61.96 | 2,048 | 0.67× | −0.7% | Defer — saves 33% disk for <1% recall loss; not worth ship-time complexity |
| 256 | 61.04 | 1,024 | 0.33× | −2.2% | Worth considering at >50k stored memories |
| 128 | 59.34 | 512 | 0.17× | −4.9% | Aggressive; only if storage becomes hot |
| 64 | 56.10 | 256 | 0.08× | −10.1% | Quality drop noticeable; not recommended |

**Recommendation:** **Stay at 768 for v0.2.** At expected scale (≤10k memories per user year-one), full-dim BLOB is 30 MB total — negligible. Defer Matryoshka truncation until either (a) measured recall@10 at 256 dims stays within 5% of 768 on real Relay corpus, OR (b) DB size becomes a UX concern.

**Critical invariant if we ever truncate:** the pipeline MUST be `layer_norm → truncate[:dim] → L2_normalize`. Skipping the post-truncate renormalize silently corrupts cosine math. [CITED: huggingface.co/nomic-ai/nomic-embed-text-v1.5]

Sources: [Nomic Matryoshka announcement](https://www.nomic.ai/news/nomic-embed-matryoshka), [HF model card](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5), [zilliz model guide](https://zilliz.com/ai-models/nomic-embed-text-v1.5).

---

## 8. `usage.prompt_tokens` Bug #1546 Status

**Status: OPEN, unresolved as of research date.** [VERIFIED: github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1546]

- Opened: Feb 22, 2026
- No fix in changelogs through **0.3.36** (last release reviewed, Dec 18, 2025 — note: 0.3.36 predates the bug report; bug filed against later releases, fix has not appeared in 0.4.x changelog scans either)
- All 4 embedding models tested return `usage.prompt_tokens: 0` and `usage.total_tokens: 0`
- **Real risk** for downstream consumers: RAG systems that gate "did embedding succeed?" on `usage > 0` will store zero-vectors. Multiple projects hit this.

**Relay's current handling:** `embedding-client.ts` ignores `usage.*` entirely; success is determined by `data[0].embedding` being a 768-float array (the `EXPECTED_EMBEDDING_DIM` check). **No change needed.** Document this as a deliberate decision in code comment (already present at line 13–14).

**If LM Studio ever fixes this:** opportunistic gain — we could add token accounting for Phase 7's `relay budget` command. Not load-bearing for v0.2.

Sources: [Bug #1546](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1546).

---

## 9. Alternative Embedding Models (if nomic unavailable)

| Model | Dim | Params | MTEB | Prefix? | GGUF? | LM Studio? | Drop-in replacement? |
|-------|-----|--------|------|---------|-------|------------|----------------------|
| **nomic-embed-text-v1.5** (incumbent) | 768 | 137M | 62.39 | yes (`search_document: `/`search_query: `) | ✓ | ✓ | — |
| BGE-small-en-v1.5 | **384** | 33M | ~62.0 | no | ✓ | ✓ (≥0.2.19) | ❌ dim mismatch breaks 768-dim BLOB schema |
| BGE-base-en-v1.5 | 768 | 109M | ~63.5 | no | ✓ | ✓ | ✓ dim match; prefix-free → swap prefix logic for empty string |
| mxbai-embed-large-v1 | **1024** | 335M | 64.68 | yes (different prefix) | ✓ | ✓ | ❌ dim mismatch; higher quality but 33% more storage |
| snowflake-arctic-embed-m | 768 | 109M | ~62.7 | yes (`search_query: `, shares format) | ✓ | ✓ | ✓ dim match; closest swap candidate |
| nomic-embed-text-v2-moe | 768 | MoE | higher | yes | ✓ (some issues) | partial | ❌ llama.cpp issues per Issue #13534 — defer until stable |

**Recommendation:** **No fallback model in Phase 4.** If nomic unavailable → word-overlap fallback (already planned). Rationale:

1. Schema is dim-pinned (768). Switching to BGE-small (384) or mxbai (1024) breaks the BLOB column without migration.
2. Quality delta to alternatives at 768 is <2 MTEB points — not worth shipping a second code path.
3. Word-overlap fallback IS the correct failure mode for "model unavailable" — it's lower quality but always works.

**Future:** if `embedding_model` column (Phase 4 schema add) ever stores a non-nomic value, the comparator must refuse cross-model cosine (recorded in `NOMIC-EMBED-SPECS.md` §9 "quantization mismatch" — applies same here). Already in Phase 4 plan via `embedding_model` column.

Sources: [Mixpeek embedding models 2026](https://mixpeek.com/curated-lists/best-embedding-models), [morphllm.com](https://www.morphllm.com/ollama-embedding-models), [ChristianAzinn GGUFs on HF](https://huggingface.co/ChristianAzinn).

---

## 10. Request Timeout — Is 5s Appropriate?

**Current:** `DEFAULT_TIMEOUT_MS = 5_000` in `embedding-client.ts:23`.

**Assessment:**

| Scenario | Realistic upper bound | 5s verdict |
|----------|----------------------|------------|
| Single short embed (warm) | ~15 ms | **333× headroom** — overkill but harmless |
| Single 2048-tok embed (warm) | ~150 ms | **33× headroom** — comfortable |
| First embed after `lms load` (cold) | ~800 ms (load) + ~100 ms (kernel JIT) ≈ ~900 ms | **5× headroom** — adequate |
| First embed after 5 min idle (auto-unload re-warms) | up to ~1 s | **5× headroom** — adequate |
| Probe `/v1/models` (no model action) | <50 ms warm, <300 ms cold | **15× headroom** |
| Batch of 16 of 2048-tok inputs (NOT used in Phase 4) | ~2–4 s | **>2× headroom but tight** — bump to 15 s if batch path added |

**Verdict: 5s is correct for Phase 4's single-call write path.** Keep as default.

**Future tuning:** if Phase 8 backfill or batch path is added, accept `timeoutMs` per-call (already supported via `EmbedOptions.timeoutMs`). Caller passes 15–30 s for batch; default stays at 5 s for write-path calls.

**One edge case to document:** the `lms load` cold-start itself takes 300–800 ms. If the first user-visible recall triggers a cold load (model was idle-unloaded), the 5s timeout absorbs it. If LM Studio cold-load takes >5s on a slow disk (HDD, throttled NVMe), the call times out and we fall back to word-overlap — acceptable graceful degradation. No code change required.

---

## Summary Table — Phase 4 Action Items From This Research

| # | Finding | Action |
|---|---------|--------|
| 1 | v0.3.34 embedding crash is real, unfixed through 0.3.36 | Document in Phase 4 PLAN under "External dependencies" — recommend pinning LM Studio to ≤0.3.33 OR using 0.4.x once verified stable. Word-overlap fallback already covers crash case. |
| 2 | `usage.prompt_tokens` bug unfixed | No code change. Existing ignore-`usage` comment in client.ts is correct. |
| 3 | 5s timeout appropriate for write path | No change. Keep `DEFAULT_TIMEOUT_MS = 5_000`. |
| 4 | Cold-start 300–800 ms on first recall after idle | Accept. Add a one-line README note for users (optional: disable LM Studio idle-unload in v0.2 setup guide). |
| 5 | No batching needed in Phase 4 | Confirm PLAN.md doesn't add unnecessary batching code. |
| 6 | 768-dim is correct for v0.2 | Confirm PLAN.md stores full 768-dim BLOB. |
| 7 | No fallback embedding model | Confirm PLAN.md only word-overlap fallback, no model alternates. |
| 8 | Measure actual latency on dev machine | Add one-shot calibration task to Phase 4 (`scripts/measure-embed-latency.ts`) — replace [ASSUMED] numbers in this doc with measurements. |
| 9 | Detect `"model has crashed"` in 400 body | OPTIONAL polish for Phase 4: refine `reason: 'http-4xx'` → `reason: 'crashed'` so caller can attempt model reload before falling back. |

---

## Sources

### Primary (HIGH confidence — verified directly)
- [LM Studio Bug Tracker #1546 — `usage` always 0](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1546)
- [lmstudio-python Issue #171 — v0.3.34 embedding crash](https://github.com/lmstudio-ai/lmstudio-python/issues/171)
- [LM Studio 0.3.35 changelog](https://lmstudio.ai/changelog/lmstudio-v0.3.35) (no embed fixes)
- [LM Studio 0.3.36 changelog](https://lmstudio.ai/changelog/lmstudio-v0.3.36) (no embed fixes)
- [LM Studio Parallel Requests docs](https://lmstudio.ai/docs/app/advanced/parallel-requests)
- [HF nomic-embed-text-v1.5-GGUF](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF) — Q4_K_M = 81 MB, 13 quant variants
- [HF nomic-embed-text-v1.5 model card](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5)
- [Nomic Matryoshka announcement](https://www.nomic.ai/news/nomic-embed-matryoshka)

### Secondary (MEDIUM confidence — cross-referenced)
- [llama.cpp Apple Silicon perf discussion #4167](https://github.com/ggml-org/llama.cpp/discussions/4167)
- [llama.cpp embeddings tutorial #7712](https://github.com/ggml-org/llama.cpp/discussions/7712) — BERT-33M Metal benchmarks
- [llama.cpp Issue #5846](https://github.com/ggml-org/llama.cpp/issues/5846) — embedding model 34–56 ms load time
- [morphllm.com — Ollama Embedding Models](https://www.morphllm.com/ollama-embedding-models) — VRAM comparisons
- [Mixpeek best embedding models 2026](https://mixpeek.com/curated-lists/best-embedding-models) — MTEB cross-check
- [Flowise #3157 — LM Studio 404 behavior](https://github.com/FlowiseAI/Flowise/discussions/3157)

### Tertiary (extrapolated — flagged [ASSUMED])
- All M4 Max latency estimates in §1, §2. No first-party M4 Max embedding benchmarks exist; numbers extrapolate from M-series BERT-33M benchmarks adjusted for nomic's 4× param count.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | M4 Max single short embed warm = 5–15 ms | §1 | If 2–3× slower (15–45 ms), still within 5s timeout; no design impact |
| A2 | Cold-start 300–800 ms after `lms load` | §2 | If 2 s+, first-recall-after-idle hits 5s timeout edge; falls back to word-overlap (acceptable) |
| A3 | Per-request KV cache ~12–24 MB at ctx=2048 | §3 | If 2× larger, total RSS ~1 GB — still trivial on M4 Max |
| A4 | LM Studio crash window is 2–5 sequential embeds (Issue #171) | §5, §6 | Reporter saw with 1500-char inputs; may differ at different sizes — calibration task will surface |
| A5 | Word-overlap fallback is sufficient when nomic unavailable | §9 | If recall quality is unacceptable, Phase 5+ blocked — but that's a known-known per ROADMAP |
| A6 | Bug #1546 not fixed in any 0.4.x | §8 | If fixed silently, we lose a free token-accounting source. No code change required. |

---

**Valid until:** 2026-06-20 (30 days). LM Studio ships ~weekly; re-verify Issue #171 status + scan 0.4.x changelog for "embedding" fixes before any Phase 4 deploy-to-user.
