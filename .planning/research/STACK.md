# Stack Research — Relay v0.2 Additions

**Domain:** Local-first CLI; agentic tool-calling, semantic embeddings, conflict detection, delta extraction, Figma integration
**Researched:** 2026-05-18
**Confidence:** HIGH (all version numbers verified live against `npm view` 2026-05-18)
**Baseline:** Relay v0.1.2 (Node ≥20, TypeScript ESM, better-sqlite3, node:test, native fetch, Zod 3.23.8, AGPL-3.0-or-later)

## Verdict (TL;DR)

**Add exactly two runtime dependencies for v0.2:**

| Dep | Version | Feature it unlocks |
|---|---|---|
| `ws` | `^8.20.1` | Figma Desktop Bridge WebSocket client (Tools #3 + #4) |
| `@types/ws` (dev) | `^8.18.1` | Type defs for the above |

Everything else — agentic loop, embeddings, cosine math, conflict detection, delta extraction, Figma REST — is built with the **existing** stack (native fetch, better-sqlite3 BLOB columns, Zod schemas, hand-authored JSON Schema constants). The `embedding-client.ts` and `auto-extract-schema.ts` modules already shipped in v0.1.2 confirm this is the right discipline — keep going.

This document explains each decision with citations and lists what we explicitly refuse to add.

---

## Recommended Stack (Per Feature)

### Feature 1 — Agentic Tool-Calling Loop (LM Studio)

| Concern | Decision | Version | Why |
|---|---|---|---|
| HTTP client | **Native `fetch`** | Node 20 built-in | Used by all 4 existing workers (`lmstudio.ts`, `openrouter.ts`, `anthropic.ts`, `auto-extract-runner.ts`). Zero added bytes. Already passes 972 tests. |
| AbortController timeout | **Native `AbortController`** | Node 20 built-in | Pattern already established in `embedding-client.ts:93–95`. No `node-fetch`, no `undici` direct dep. |
| Tool schema authoring | **Hand-authored JSON Schema constants + Zod runtime validators** | Zod `^3.23.8` (already shipped) | OpenAI tool-call wire format is a small fixed shape (`{type:"function", function:{name, description, parameters}}`). Hand-author the `parameters` JSON Schema as a `const`, then Zod-validate `tool_call.function.arguments` after `JSON.parse`. Two layers: untrusted text → trusted struct. |
| Tool-arg parse validation | **`JSON.parse` + Zod `.safeParse()`** | Zod `^3.23.8` | LM Studio docs (`lmstudio.ai/docs/developer/openai-compat/tools`) confirm `function.arguments` is a **JSON-encoded string** that must be parsed and may be malformed. Zod gives typed errors back to the model in the tool result message. |
| Tool execution sandbox | **None for v0.2** — shell-out only, no in-process registered handlers | n/a | ROADMAP §2 leaves the decision deferred; shell commands match the Codex worker pattern. No `vm2`, no `isolated-vm`, no `wasm` — adding a sandbox now is premature when the only first-class tool surface is Figma REST + WS bridge (both pure I/O). |
| Loop ceiling + repeat detection | **In-code counter + hash-of-`(name, sorted-args)`** | n/a | Per LMSTUDIO-TOOL-API.md §Max Iterations — ceiling 20, abort after 3 identical consecutive calls. No library; a `Map<string, number>` is sufficient. |

**Result: zero new dependencies for the agentic loop.**

### Feature 2 — Semantic Embeddings (nomic-embed-text-v1.5)

| Concern | Decision | Version | Why |
|---|---|---|---|
| Embeddings HTTP | **Native `fetch`** | Node 20 built-in | Already implemented — `src/memory/embedding-client.ts` (8.3 KB + 12.5 KB test file shipped in v0.1.2 baseline). |
| Vector storage | **SQLite BLOB column (`embedding BLOB`)** holding raw little-endian Float32Array bytes | better-sqlite3 `^11.3.0` (already shipped) | 3,072 bytes/row at 768 dims (NOMIC-EMBED-SPECS §5). 100k memories ≈ 307 MB — fits the local-first profile. JSON storage = 4.5× bloat (~14 KB/row) for zero benefit. Little-endian host asserted at module load (`embedding-client.ts:32–39`). |
| Cosine similarity computation | **Plain JS loop over Float32Array** in `src/memory/cosine.ts` (new file) | n/a | Nomic outputs are L2-normalized → cosine == dot product → a single multiply-add loop per pair (NOMIC-EMBED-SPECS §6). At 768 dims × ~100 candidate memories that's <1 ms per query on M4 Max. Recall is already gated by a candidate-set limit in `getCandidates()`, so we never compare against the full corpus. |
| ANN index (HNSW etc.) | **Do not add for v0.2** | n/a | See "What NOT to Use" — Relay's expected corpus is 1k–10k memories. Linear scan over Float32Array with early-exit at the budgeted recall ceiling is faster than the index build/maintain overhead at this scale. Revisit if usage data shows >50k active memories. |
| Token counting for input | **Skip — trust client-side length check + LM Studio's 2048 default** | n/a | NOMIC-EMBED-SPECS §9 says `usage.*_tokens` is **always 0** (lmstudio-bug-tracker#1546). Adding `tiktoken` (40 MB+ native module) to count nomic-specific tokens is wrong anyway — nomic uses a different tokenizer. Chunk by character length (rough 4×token) upstream; let LM Studio reject oversize inputs with HTTP 400. |

**Result: zero new dependencies for embeddings.** (Embedding client already shipped in v0.1.2.)

### Feature 3 — Conflict Detection (δ-mem-inspired)

| Concern | Decision | Version | Why |
|---|---|---|---|
| Algorithm | **Pure JS in `src/memory/memory-engine.ts` + `src/memory/conflict-detector.ts` (new)** | n/a | ROADMAP §4 describes a pairwise scoring pass: high tag overlap + low cosine similarity → flag. The math is set intersection + one cosine comparison per pair. No library exists or is needed. |
| Schema migration | **PRAGMA-guarded `conflicts_with_json TEXT` column** on `memories` | better-sqlite3 `^11.3.0` (already shipped) | Same migration pattern as `embedding_json` already in `db-migrations.ts`. |
| Conflict surface in CLI | **Reuse `memory why` output extension** | n/a | `ScoreComponents` printout already exists; add `conflicts_with` field. No new framework. |

**Result: zero new dependencies for conflict detection.**

### Feature 4 — Delta Extraction (auto-extract)

| Concern | Decision | Version | Why |
|---|---|---|---|
| Schema validation | **Reuse `auto-extract-schema.ts` Zod schema** (`AutoExtractResultSchema`) | Zod `^3.23.8` (already shipped) | The Zod schema for `{content, memory_type, confidence}` is in v0.1.2. Delta extraction changes only the **prompt** (T10 template) and the **runner input** (pre-load existing recalled memories). The output schema is unchanged — extracted items still validate against the same Zod shape. |
| Prompt template change | Edit `src/memory/auto-extract-runner.ts` and the T10 template | n/a | No new dep. |
| "Conflicts with" link in extracted items | **Optional `conflicts_with: z.array(z.string()).optional()` field** added to existing Zod schema | Zod `^3.23.8` | Field is optional → backward-compatible with v0.1.2 stored memories. Feeds directly into Feature 3's `conflicts_with_json` column. |

**Result: zero new dependencies for delta extraction.**

### Feature 5 — Figma Integration

| Concern | Decision | Version | Why |
|---|---|---|---|
| Figma REST client (Tools #1 + #2: `figma_list_layers`, `figma_update_token`) | **Native `fetch`** | Node 20 built-in | Two REST endpoints, both documented. Header is `X-Figma-Token: <pat>`. No wrapper buys anything we don't already have. |
| Figma REST types (optional) | **`@figma/rest-api-spec`** (types-only, no runtime) | `^0.38.0` | Official Figma typings package. Zero runtime deps. Use as `devDependency` for compile-time safety on REST response shapes. **Conditional add** — only if PR review surfaces type pain; pure `unknown` + manual narrowing is acceptable. |
| WebSocket client → Figma Desktop Bridge plugin (Tools #3 + #4: `figma_create_component`, `figma_get_selection`) | **`ws@^8.20.1`** + **`@types/ws@^8.18.1`** (dev) | runtime + dev | Standard Node WebSocket client. `ws` v8 is stable (published 6 days ago at research time, MIT, zero deps). Native `WebSocket` only landed stable in **Node 22**; Relay's `engines.node = ">=20"` forces us to `ws`. Until we bump to Node 22 minimum, this is the cleanest path. Used by the reference architecture (figma-console-mcp). |
| Bridge plugin code | **Separate single-file TypeScript inside `figma-bridge/` directory** (not bundled into Relay's npm package) | n/a | Plugin runs in Figma Desktop, not in Node — uses `@figma/plugin-typings` (dev-only typings, separate scope) and is built with its own minimal `tsconfig`. Distributed via README install instructions; not part of the Relay binary. |
| FIGMA_API_TOKEN management | Read from env at runtime, fail fast if missing | n/a | Matches existing pattern in `openrouter.ts`, `anthropic.ts`. No `dotenv` — `node:process.env` is already available. |

**Result: one runtime dep (`ws`), one dev dep (`@types/ws`), one optional dev dep (`@figma/rest-api-spec`).**

---

## Installation

```bash
# Runtime — Figma Plugin API bridge
npm install ws@^8.20.1

# Dev — WebSocket + Figma REST type defs
npm install -D @types/ws@^8.18.1
npm install -D @figma/rest-api-spec@^0.38.0   # optional, only if REST type-safety matters
```

**Verify Zod stays pinned at v3:**
```bash
# Confirm package.json shows zod ^3.23.8 (NOT ^4.x)
# Zod 4 (4.4.3 latest) is a major rewrite — would break 972 passing tests.
```

---

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|---|---|---|
| Native `fetch` for LM Studio tool loop | `openai` SDK (`^4.x` or `^5.x`) | If we ever needed streaming-with-tool-calls accumulators or OpenAI Responses API (`/v1/responses`, LM Studio v0.3.29+). The wire format is small + stable per LMSTUDIO-TOOL-API.md §Architectural Notes #4. Defer to v0.3 if at all. |
| Plain BLOB + JS cosine | `sqlite-vec` `^0.1.9` (alpha, asg017/sqlite-vec) | Once corpus exceeds ~50k vectors **and** profiling shows linear-scan cosine is the recall bottleneck. sqlite-vec adds a native SQLite extension load (`db.loadExtension(...)`), platform-specific binaries via the npm package, and an experimental API surface (still 0.1.x, alpha-tagged 0.1.10 published). The compute speedup is real but the operational complexity isn't justified at Relay's expected scale. |
| Hand-authored JSON Schema for tool defs | `zod-to-json-schema@^3.25.2` (auto-convert Zod → JSON Schema at startup) | If the number of tool definitions grows past ~10 and hand-maintaining two representations becomes error-prone. For 4 Figma tools + 1–2 shell tools, hand-authoring is less code than the dependency. |
| `ws@^8.20.1` for WebSocket | Native `WebSocket` (Node 22+ stable) | When Relay raises `engines.node` to `>=22`. At that point drop `ws`. Until then, `ws` is the only zero-flag option. |
| `ws@^8.20.1` for WebSocket | `undici` WebSocket | `undici` ships with Node but its WebSocket is intended for fetch-stream integration, not standalone clients. `ws` is the de-facto standard and has clearer reconnect/heartbeat hooks. |
| `@figma/rest-api-spec` types | `figma-api@2.2.0-beta` wrapper | **Never** — figma-api depends on `axios` (forbidden, see below). The typings package is types-only with zero runtime dep. |
| In-process tool registry | Shell-out tool execution | For tools that need access to Relay's `MemoryStore` or other in-process state (e.g., a hypothetical `memory_search` tool the local model could call). Defer until a concrete tool needs it. |

---

## What NOT to Use

| Avoid | Why | Use Instead |
|---|---|---|
| `axios` | Relay v0.1.2 uses native `fetch` everywhere (all 4 workers, embedding client, auto-extract). Adding axios fragments the HTTP layer and brings 60+ KB of transitive deps. **Hard ban.** | Native `fetch` + `AbortController` |
| `node-fetch` | Same reason as axios. `fetch` is built into Node ≥18; Relay requires Node ≥20. | Native `fetch` |
| `figma-api@2.2.0-beta` | The official-ish npm wrapper depends on `axios`. Pulls in the very thing we banned. Also `-beta`-tagged. | Native `fetch` + `@figma/rest-api-spec` types |
| `openai` SDK | Adds ~2 MB and a streaming abstraction we don't need for the agentic loop. LM Studio's OpenAI-compat surface is small enough to call directly. Per LMSTUDIO-TOOL-API.md §Architectural Notes #4: "No SDK lock-in — Use plain fetch / node:http rather than `openai` SDK." | Native `fetch` against `/v1/chat/completions` |
| `jest`, `vitest`, `mocha`, `chai`, `sinon` | Relay uses `node:test` + `node:assert/strict` (zero deps). The 972-test suite proves it works. Mixing test runners doubles config + breaks `npm test`. | `node --test --test-concurrency=1 dist/**/*.test.js` (existing script) |
| `zod@4.x` | Zod 4 is a major rewrite with breaking API changes (error format, parsing semantics). Pinning at `^3.23.8` keeps the existing 972 tests valid. Upgrade is a separate decision, not a v0.2 sub-task. | `zod@^3.23.8` (already shipped) |
| `sqlite-vec@0.1.9` | Adds native extension dependency + platform binaries + alpha API surface. Linear cosine over Float32Array is fast enough at Relay's scale (1k–10k vectors). Premature optimization. | Plain BLOB column + JS cosine loop |
| `tiktoken` / `gpt-tokenizer` | Native module (~40 MB build), uses OpenAI tokenizers — wrong tokenizer for nomic-embed-text-v1.5. LM Studio's `usage.*_tokens` is broken anyway (NOMIC-EMBED-SPECS §3). | Character-length heuristic upstream of `/v1/embeddings`; trust HTTP 400 on overflow |
| `hnswlib-node`, `faiss-node`, `lancedb`, any ANN index lib | Index build/maintenance overhead exceeds linear scan cost below ~50k vectors. Each adds native binaries. | Linear cosine scan (revisit at >50k memories) |
| `dotenv` | All env reads use `process.env` directly. Shell sets the var. No `.env` file convention in Relay (consent files + workdir config replace it). | `process.env.FIGMA_API_TOKEN` (with fail-fast guard) |
| `ajv` / `ajv-formats` (JSON Schema validator at runtime) | We validate tool-call arguments with Zod (already a dep). Adding ajv for the same job duplicates the validation layer. | Zod `.safeParse()` on parsed tool args |
| `socket.io`, `engine.io` | The Figma Bridge speaks raw WebSocket, not socket.io's protocol layer. socket.io would force a matching server on the plugin side and add ~200 KB. | `ws@^8.20.1` raw WebSocket |
| `vm2`, `isolated-vm` | No in-process tool execution sandbox needed for v0.2 (shell-out + REST + WS only). Both are also under active CVE discussion historically. | Shell-out matching the Codex worker pattern |
| `express`, `fastify`, `hono` | Relay is a CLI + MCP server, not an HTTP server. No incoming HTTP surface. | n/a |
| Codex CLI for v0.2 implementation | PROJECT.md constraint: "NO codex (CC subagents only)" for v0.2. Codex stays as a **runtime** worker target; it does not write v0.2 code. | CC + subagents per ai-stack CLAUDE.md |

---

## Version Compatibility

| Package A | Compatible With | Notes |
|---|---|---|
| `ws@^8.20.1` | Node ≥20.0.0 | Verified — `ws@8` supports Node ≥10, Relay's floor is 20. |
| `ws@^8.20.1` | TypeScript `^5.9.3` (existing) | `@types/ws@^8.18.1` provides typings; no `ws.d.ts` needed. |
| `@figma/rest-api-spec@^0.38.0` | TypeScript `^5.9.3` (existing) | Types-only, zero runtime. Compatible with any TS ≥4.x. |
| `zod@^3.23.8` (pinned) | `zod-to-json-schema@^3.25.2` (if ever added) | The 3.x.x of both align. Do NOT mix zod@4 with zod-to-json-schema unless both versions explicitly support each other. |
| `better-sqlite3@^11.3.0` (existing) | Node ≥20, prebuilt binaries on macOS arm64 + linux x64 | Confirmed via existing 972-test suite. v12 (latest) is a major bump — defer. |
| Native `fetch` (Node 20) | LM Studio HTTP API | Verified working in `embedding-client.ts`, `lmstudio.ts`, `auto-extract-runner.ts`. |
| Native `AbortController` | Native `fetch` | Pattern at `embedding-client.ts:93–95`. Standard Web Streams idiom. |
| `@figma/plugin-typings` (for bridge plugin only) | Figma Desktop ≥ current channel | Plugin TypeScript dev-only types; install inside `figma-bridge/` subdir, not at Relay root. |

---

## Stack Patterns by Variant

**If we ever need `tool_choice: "required"` on MLX models:**
- That mode is llama.cpp-engine-only per LMSTUDIO-TOOL-API.md §tool_choice. On MLX-quantized models (e.g., `qwen3-vl-32b-thinking-mlx`), fall back to `"auto"` + a stricter system prompt. Do not add a polyfill library — just route differently.

**If embedding cosine becomes a hot path (profiling proves it):**
- First: increase candidate-set ceiling before linear scan, batch-load BLOBs in one query, ensure SQLite WAL mode (already on). Then: consider SIMD via a hand-written Float32Array dot loop (V8 auto-vectorizes flat typed-array loops). Only after both fail: revisit `sqlite-vec`.

**If the Figma bridge needs reconnect/heartbeat:**
- `ws@^8` ships ping/pong out of the box. No `reconnecting-websocket` library — wrap in a single `setupBridge()` function that retries with exponential backoff using `setTimeout`. ~30 LoC.

**If we add an in-process tool registry (post-v0.2):**
- Define `interface ToolHandler<T>` with `name`, `parametersSchema: z.ZodType<T>`, `execute: (args: T) => Promise<unknown>`. No DI framework, no decorators. A `Map<string, ToolHandler>` is the registry.

---

## Sources

### Live npm registry checks (2026-05-18)
- `npm view ws version` → **8.20.1** (published 6 days ago, MIT, zero deps)
- `npm view @types/ws version` → **8.18.1**
- `npm view @figma/rest-api-spec version` → **0.38.0** (official Figma typings, MIT, zero deps)
- `npm view sqlite-vec version` → **0.1.9** (alpha-tagged 0.1.10-alpha.4; pre-1.0)
- `npm view figma-api version` → **2.2.0-beta** (depends on `axios ^1.15.2` — disqualified)
- `npm view ajv version` → **8.20.0** (not needed; Zod covers validation)
- `npm view zod version` → **4.4.3** (Relay stays on **3.23.8** for v0.2)
- `npm view better-sqlite3 version` → **12.10.0** (Relay stays on **11.3.0** for v0.2)

### Project-local validations (Relay v0.1.2 baseline)
- `src/memory/embedding-client.ts` (8.3 KB) + `embedding-client.test.ts` (12.5 KB) — proves native fetch + Float32Array BLOB pattern works in the existing test suite
- `src/memory/auto-extract-schema.ts` — proves Zod `^3.23.8` is the right validator for LM Studio outputs
- `src/workers/lmstudio.ts`, `src/workers/openrouter.ts`, `src/workers/anthropic.ts`, `src/workers/codex.ts` — confirm "native fetch only" discipline
- `package.json` — confirms current shipped deps: `better-sqlite3 ^11.3.0`, `ink ^6.8.0`, `react ^19.2.6`, `zod ^3.23.8`

### Authoritative external docs (re-verified against research files)
- [LM Studio — Tool Use (OpenAI compat)](https://lmstudio.ai/docs/developer/openai-compat/tools) — `tool_calls[].id` echo requirement, `function.arguments` is JSON-encoded string, parallel calls semantics (LMSTUDIO-TOOL-API.md §HTTP Shape — Response with `tool_calls`)
- [LM Studio — OpenAI-compat Embeddings](https://lmstudio.ai/docs/developer/openai-compat/embeddings) — `/v1/embeddings` POST shape, batch via `input` array (NOMIC-EMBED-SPECS.md §3)
- [Hugging Face — nomic-ai/nomic-embed-text-v1.5](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5) — 768 dims, L2-normalized output, `search_document:` / `search_query:` prefixes mandatory (NOMIC-EMBED-SPECS.md §1, §8)
- [Figma REST API — Introduction](https://developers.figma.com/docs/rest-api/) — `X-Figma-Token` header, base URL `https://api.figma.com` (FIGMA-API-TOOLS.md §Auth)
- [Figma Plugin API — createComponent](https://developers.figma.com/docs/plugins/api/properties/figma-createcomponent/) — confirms component creation is plugin-only, no REST equivalent (FIGMA-API-TOOLS.md §Tool 3 — honest assessment)
- [websockets/ws on GitHub](https://github.com/websockets/ws) — published 2026-05-12, MIT, zero deps, Node ≥10 supported

### Reference research (loaded from `.planning/v0.2-improvised-scrap/`)
- `LMSTUDIO-TOOL-API.md` — HIGH-confidence tool-calling wire format research
- `NOMIC-EMBED-SPECS.md` — HIGH-confidence embedding endpoint research
- `FIGMA-API-TOOLS.md` — HIGH-confidence Figma REST + Plugin API research

---

## Assumptions Log

| # | Claim | Section | Risk if wrong |
|---|---|---|---|
| A1 | Linear JS cosine over Float32Array stays under 5 ms at 10k vectors × 768 dims on M4 Max | Feature 2 | If profiling proves slower, fall back to `sqlite-vec` — but add only after measurement. Estimate is based on V8's typed-array fast path; not measured on Relay's actual M4 Max. |
| A2 | Zod-validating parsed tool args is sufficient without a JSON Schema runtime validator (ajv) | Feature 1 | If LM Studio ever forwards strictly-validated schema errors from its side, we may need ajv. Currently LM Studio passes `parameters` to the model as plain text — no server-side validation. Zod on our side catches malformed args after `JSON.parse`. |
| A3 | `ws@^8` covers all bridge needs without a higher-level WS framework | Feature 5 | If reconnection logic balloons past ~50 LoC, consider a small wrapper. Reference: figma-console-mcp uses raw `ws` successfully. |
| A4 | The Zod schema in `auto-extract-schema.ts` can absorb an optional `conflicts_with` field without breaking v0.1.2 readers | Feature 4 | Zod 3.x optional fields are backward-compatible by default. Verified by reading existing schema patterns. |
| A5 | Native `fetch` in Node 20 handles SSE streaming if we ever enable `stream: true` for the tool loop | Feature 1 | Confirmed by undici docs (Node 20 ships undici as fetch backend). For v0.2 first cut we use `stream: false` per LMSTUDIO-TOOL-API.md §Streaming Behavior. |

---

*Stack research for: Relay v0.2 (agentic + semantic + Figma + delta + conflict)*
*Researched: 2026-05-18*
*Valid until: 2026-06-17 (npm versions move; re-verify before v0.2 GA)*
