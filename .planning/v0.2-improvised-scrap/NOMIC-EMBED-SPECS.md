# nomic-embed-text-v1.5 — Relay v0.2 Embedding Backbone Spec

**Researched:** 2026-05-18
**Domain:** Local semantic embeddings via LM Studio HTTP
**Confidence:** HIGH (specs/endpoint), MEDIUM (M4 Max latency — extrapolated)
**Loaded in LM Studio:** `text-embedding-nomic-embed-text-v1.5` (84.11 MB, Q4_K_M GGUF) per `lms ls`

---

## 1. Embedding Dimensions

- **Native:** 768 float32 dimensions [VERIFIED: huggingface.co/nomic-ai/nomic-embed-text-v1.5]
- **Matryoshka:** Yes — model is trained with Matryoshka Representation Learning (MRL) so any truncation in [64, 768] is valid. Documented benchmark breakpoints:

| Dim | MTEB score | Memory vs 768 | Notes |
|-----|-----------|---------------|-------|
| 768 | 62.28 | 1.00x | Native; reference quality |
| 512 | 61.96 | 0.67x | Outperforms OpenAI ada-002 at 3x compression |
| 256 | 61.04 | 0.33x | Recommended sweet spot for local RAG |
| 128 | 59.34 | 0.17x | Acceptable for coarse recall |
| 64  | 56.10 | 0.08x | Aggressive; quality drop noticeable |

Binary embeddings also supported (1 bit/dim) but not relevant for Relay v0.2. [CITED: nomic.ai/news/nomic-embed-matryoshka]

**Truncation MUST follow this order or cosine math breaks:**
```
raw_embedding -> layer_norm -> truncate[:dim] -> L2_normalize -> store/compare
```
Skipping renormalize-after-truncate corrupts magnitude and silently degrades cosine similarity. [CITED: huggingface.co/nomic-ai/nomic-embed-text-v1.5]

**Relay recommendation:** store 768-dim full vectors. LM Studio's `/v1/embeddings` returns the post-layer-norm full vector; truncation is a downstream choice. Defer the truncation decision until we benchmark recall quality on real Relay corpus. `[ASSUMED]` — based on standard MRL guidance; verify against Relay's actual recall@k once corpus exists.

---

## 2. Input Token Limit

- **LM Studio / llama.cpp default:** 2048 tokens [VERIFIED: huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF]
- **Theoretical max:** 8192 tokens via Dynamic NTK-Aware RoPE scaling
- **llama.cpp 8K support:** Requires `--rope-scaling yarn --rope-freq-scale .75` at server start; **not exposed in LM Studio UI as of research date** `[ASSUMED]` — verify in LM Studio settings before assuming 8K is available
- **Practical Relay budget:** Plan for **2048 tokens** per embed call. Chunk longer texts upstream.

---

## 3. LM Studio HTTP Endpoint

### Request

**Endpoint (OpenAI-compatible):** `POST http://localhost:1234/v1/embeddings`
**Endpoint (LM Studio native):** `POST http://localhost:1234/api/v0/embeddings`
Both accept identical body. Default port `1234` (configurable in LM Studio Server tab). [VERIFIED: lmstudio.ai docs]

**Body schema:**
```json
{
  "model": "text-embedding-nomic-embed-text-v1.5",
  "input": "search_document: your text here"
}
```

`input` accepts either a single string or a string array for batching.

### Curl Example (single)

```bash
curl http://localhost:1234/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{
    "model": "text-embedding-nomic-embed-text-v1.5",
    "input": "search_document: Relay is a local-first agent orchestration tool."
  }'
```

### Curl Example (batch)

```bash
curl http://localhost:1234/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{
    "model": "text-embedding-nomic-embed-text-v1.5",
    "input": [
      "search_document: first chunk",
      "search_document: second chunk"
    ]
  }'
```

### Response Shape

```json
{
  "object": "list",
  "data": [
    {
      "object": "embedding",
      "embedding": [-0.016731496900320053, 0.028460891917347908, -0.1407836228609085, "...765 more floats..."],
      "index": 0
    }
  ],
  "model": "text-embedding-nomic-embed-text-v1.5@q4_k_m",
  "usage": {
    "prompt_tokens": 0,
    "total_tokens": 0
  }
}
```

**Important:** `usage.prompt_tokens` and `usage.total_tokens` are **always 0** in current LM Studio releases — this is a known upstream bug (lmstudio-bug-tracker#1546). Do NOT rely on these for token accounting. [VERIFIED: github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1546]

---

## 4. Latency Expectations on M4 Max

**No first-party Nomic benchmarks for M4 Max exist as of research date.** Numbers below extrapolate from M2/M3 Metal benchmarks scaled to M4 Max GPU/bandwidth. Treat as planning estimates, not guarantees.

| Scenario | Estimate | Source |
|----------|----------|--------|
| Single short text (~30 tokens) | **5–15 ms** | `[ASSUMED]` — extrapolated from M3 Max Metal benchmarks; Q4_K_M GGUF, model already loaded |
| Single 512-token chunk | **20–40 ms** | `[ASSUMED]` |
| Single 2048-token chunk | **80–150 ms** | `[ASSUMED]` |
| Batch of 32 short texts | **80–200 ms total** (~2,000–6,000 tok/s) | `[ASSUMED]` |
| Cold start (model load from disk) | **300–800 ms one-time** | `[ASSUMED]` |

**Action item for Relay v0.2:** add a benchmark task that times 100 single + 10 batch calls on the actual dev machine before committing to embed-on-every-recall vs cache strategy.

---

## 5. Storage Footprint per Embedding

768 float32 dimensions:

| Format | Bytes | Notes |
|--------|-------|-------|
| Raw `float32` array (BLOB) | **3,072** | 768 × 4 bytes. Most compact. |
| `float16` BLOB (half precision) | 1,536 | ~1% recall loss typical, acceptable for retrieval |
| JSON array, compact (no whitespace) | **~13,000–15,000** | ~17–20 chars per float (`-0.016731496900320053,`) |
| JSON array, pretty-printed | ~20,000–25,000 | Avoid for storage |
| Base64-encoded float32 blob | ~4,100 | If you must use a text column |

**Relay recommendation:** **store as SQLite BLOB column** (float32, 3,072 bytes/row). At 100k embeddings that's ~307 MB. JSON storage would be ~1.4 GB for the same — 4.5x bloat for zero benefit. `[ASSUMED]` — based on standard vector storage practice; sqlite-vec also accepts raw float32 BLOBs directly.

For Matryoshka truncation: 256-dim float32 BLOB = 1,024 bytes/row (3x reduction).

---

## 6. Similarity Metric

- **Recommended:** **Cosine similarity** [VERIFIED: huggingface.co/nomic-ai/nomic-embed-text-v1.5]
- Because nomic outputs are L2-normalized after the prescribed pipeline (layer_norm → truncate → normalize), **cosine == dot product** mathematically. Either operation gives identical ranking.
- Use **dot product** in SQL if you've pre-normalized at store time — it's one multiply per dimension, no division, no sqrt. Faster.
- sqlite-vec exposes both `vec_distance_cosine` and `vec_distance_L2`; for nomic-normalized vectors, `vec_distance_cosine` is correct and fastest.

---

## 7. Query-Time Strategy: Fresh vs Cached

**Tradeoff:**

| Strategy | Cost per recall | Recall consistency | When to use |
|----------|-----------------|-------------------|-------------|
| **Embed query fresh every recall** | +5–15 ms latency, 1 HTTP call | Always consistent | Default; queries are usually one-shot |
| **Cache by query hash** | ~0 ms on hit, hash lookup overhead | Stale if model swapped | Repeated identical queries (e.g., autocomplete) |

**Recommendation for Relay v0.2:** **embed fresh.** Reasons:
1. Single short-query embed is ~5–15 ms — same order as a SQLite point lookup. Cache hit ratio for natural-language queries is typically <5%.
2. Cache invalidation gets hairy if you ever swap embedding models, change dimension, or change prefix strategy.
3. Memory and disk used for the cache is better spent on more stored embeddings.

If profiling later shows query embedding is a hot path (e.g., interactive UI re-querying on keystroke), add an LRU cache keyed by `sha256(prefix + query_text + model_id + dim)` with low TTL (10 min) and explicit invalidation hook on model swap. `[ASSUMED]` — recommendation based on typical RAG access patterns; verify against actual Relay query patterns once usage data exists.

---

## 8. Required Text Prefix (still required in v1.5)

**Yes, prefixes are still mandatory in v1.5.** Quality degrades measurably without them. [VERIFIED: huggingface.co/nomic-ai/nomic-embed-text-v1.5]

| Task | Prefix |
|------|--------|
| Stored documents / corpus | `search_document: ` (note trailing space after colon) |
| User queries / retrieval | `search_query: ` |
| Topic clustering / dedup | `clustering: ` |
| Classification features | `classification: ` |

**Mismatched prefix at query vs store time = severely degraded recall.** Always pair `search_document:` (store) with `search_query:` (query).

**Relay enforcement:** wrap the LM Studio HTTP call in a single typed function that takes `(text, task: 'document' | 'query' | 'clustering' | 'classification')` and prepends the prefix internally. Never let raw text reach the endpoint without a prefix.

---

## 9. Failure Modes & Handling

| Failure | Symptom | Detection | Mitigation |
|---------|---------|-----------|------------|
| **Model not loaded** | HTTP 404 or 400 with "model not found" | Response status != 200, or `error.code == "model_not_found"` | Probe `GET /v1/models` at startup; surface clear error to user; suggest `lms load text-embedding-nomic-embed-text-v1.5` |
| **LM Studio not running** | Connection refused (ECONNREFUSED) | Network error before HTTP | Health check on startup; backoff retry 3x; fail loud with install/start hint |
| **Network timeout** | Hangs beyond expected latency | Wrap call in 5s timeout for short, 30s for batch | AbortController / signal; log and either retry once or fail the recall (don't silently drop) |
| **OOM / context overflow** | HTTP 500 or 400, "context length exceeded" | Input > 2048 tokens | Pre-count tokens client-side; chunk inputs; never trust LM Studio to gracefully truncate |
| **Wrong model loaded** | Returns embeddings of wrong dim (e.g., 1024 instead of 768) | Validate `data[0].embedding.length == expected_dim` | Hard assert dimension on every response; if mismatch, refuse to store and alert |
| **Empty input** | Some servers return zero-vector, others 400 | Check before calling | Validate input length > 0 client-side |
| **Quantization mismatch in stored vs new** | Subtle recall degradation | No automatic detection | Record `model.qmpath` (e.g., `@q4_k_m`) alongside each stored vector; refuse cross-quant comparison |

**Critical:** when the server returns a 200 but the response body is malformed (e.g., truncated stream), `JSON.parse` will throw. Always wrap parse in try/catch and treat as a transient failure.

---

## 10. Quick Reference for v0.2 Implementation

```
Model id (LM Studio):     text-embedding-nomic-embed-text-v1.5
Endpoint:                 POST http://localhost:1234/v1/embeddings
Native dim:               768 (float32)
Storage per vector:       3,072 bytes (BLOB) | ~14 KB (JSON) — prefer BLOB
Similarity:               cosine (== dot product on normalized vectors)
Max input tokens:         2,048 (default in LM Studio)
Required prefix (store):  "search_document: "
Required prefix (query):  "search_query: "
Pipeline:                 layer_norm -> truncate -> L2_normalize (if shrinking)
Query strategy:           embed fresh per recall
Expected single-call:     5-15 ms (M4 Max, short text) [ASSUMED]
```

---

## Sources

### Primary (HIGH confidence)
- [Hugging Face — nomic-ai/nomic-embed-text-v1.5](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5) — model card, prefixes, dims, Matryoshka, normalization order
- [Hugging Face — nomic-embed-text-v1.5-GGUF](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF) — quantization variants, llama.cpp context handling
- [Nomic Blog — Matryoshka announcement](https://nomic.ai/news/nomic-embed-matryoshka) — MRL details, dim/MTEB tradeoffs
- [LM Studio REST API docs](https://lmstudio.ai/docs/app/api/endpoints/rest) — endpoint paths and OpenAI compatibility
- [LM Studio OpenAI compatibility — Embeddings](https://lmstudio.ai/docs/developer/openai-compat/embeddings) — `/v1/embeddings` shape
- [LM Studio bug tracker #1546](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1546) — `usage.*_tokens` always-zero bug

### Secondary (MEDIUM confidence)
- [Hakuna Matata — LM Studio Text Embedding](https://www.hakunamatatatech.com/our-resources/blog/lm-studio-text-embedding) — sample response JSON cross-check
- [Medium — Matryoshka embeddings: vector search 5x faster](https://medium.com/data-science-collective/matryoshka-embeddings-how-to-make-vector-search-5x-faster-f9fdc54d5ffd) — normalization order
- [sqlite-vec — Matryoshka guide](https://alexgarcia.xyz/sqlite-vec/guides/matryoshka.html) — storage and truncation patterns
- [Hugging Face blog — Matryoshka intro](https://huggingface.co/blog/matryoshka) — general MRL background

### Tertiary (LOW — extrapolated, not measured)
- M4 Max latency numbers are extrapolated from M2/M3 Metal benchmarks; no first-party M4 Max benchmarks were found. Mark for in-situ measurement.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | M4 Max latency 5–15 ms for short embed call | §4 | Performance budgeting; if 2–3x slower, may need to cache or batch more aggressively |
| A2 | LM Studio UI doesn't expose 8K RoPE scaling | §2 | If wrong, can chunk less aggressively |
| A3 | sqlite-vec / SQLite BLOB is the right store | §5 | If we pick a different vector store, format may differ |
| A4 | "Embed fresh per recall" is right default | §7 | If query patterns are highly repetitive, caching wins |
| A5 | 768-dim native is the right default store size | §1 | If recall is fine at 256, we'd 3x our capacity |

---

**Valid until:** 2026-06-15 (30 days — LM Studio and Nomic both ship fast). Re-verify endpoint shape and version pinning before v0.2 GA.
