# Relay v0.4 — working scope (as of 2026-06-09)

Settled through scrutiny this session. Companion to `LESSONS-FROM-RELAY-MCP.md`. Written into the Phase 9 plan set 2026-06-09 (`.planning/phases/09-mcp-server/09-01..05-PLAN.md` + 09-CONTEXT.md) — that is now the executable form of this scope.

## What Relay is (the agreed read)
A local-first, **model-agnostic delegation + cross-tool memory** layer. Its one genuinely unique value (not duplicated by hosts/providers): **persistent memory that follows you across sessions AND across tools.** Everything else either duplicates the hosts or is marginal.

## BUILD — lean v1 (4 things)
1. **Agnostic dispatch** — `relay run --provider <any> --model <x>` for any OpenAI-compatible endpoint via env config (`RELAY_PROVIDER_<NAME>_URL|TYPE|KEY|HEADER_*|ADAPTER`); generic OpenAI-compatible runner as default; native adapters only where the wire differs (Anthropic messages, Codex subprocess). Port the proven pattern from relay-mcp `config/providers.ts`+`registry.ts`; delete all closed provider unions.
2. **Memory** — SQLite + FTS5 store/recall, workspace-scoped, token-budgeted, `entity_key` wiki-upsert (no bloat), `unverified`-by-default + trust rises from outcomes, secrets redacted. **VERIFIED EXISTING 2026-06-09** — codebase inventory found every one of these already implemented (scoping, upsert+supersession, budgetedRecall, TrustLevel+markRecallSuccess, redaction-on-save, FTS5+bm25, plus conflict detection and optional lazy embeddings). No build needed; evidence table in `.planning/phases/09-mcp-server/09-CONTEXT.md`. **No RAG/embeddings in v1** (relay-mcp's own verdict: keep FTS5, defer vectors, never ChromaDB/pgvector). Biggest recall lever is **scoping**, not vectors. RAG = measured upgrade later ONLY if recall is proven the bottleneck.
3. **CLI** — run/delegate, remember/recall, run records storing the **raw provider-returned token usage** (a receipt; no price map, no $ math).
4. **Thin MCP server (stdio)** — exposes `relay_memory_recall` + `relay_memory_save` to MCP hosts; stdout-clean; SDK pinned + build-time verified; tool list derived from registry.

## Transport tiers (MCP reach)
- **v1 stdio** → Claude Desktop, Claude Code, Cursor, Codex, Windsurf, and any harness that runs those agents (e.g. **Conductor** runs Claude Code/Codex/Cursor — Relay rides in at the agent layer if MCP config passes through). Zero hosting.
- **v2 remote** (later, optional) → **ChatGPT** + web clients. Needs HTTP/streamable transport (SDK supports it) + **OAuth 2.1 Dynamic Client Registration**, fronted by OpenAI's **Secure MCP Tunnel** (May 2026) so Relay stays local, NOT a multi-tenant hosted SaaS. OAuth DCR is the real work. Do NOT slide into hosting.
- Rule: Relay works with any app that is an **MCP client** on one of these transports. Non-MCP apps are out.

## KILLED (with reason)
- **Cost tracking** — duplicates provider dashboards (the TUI argument); a price map needs forever-upkeep and drifts into a confident *wrong* number (trust bug). Keep only the free raw-usage receipt.
- **Trader/finance/market/sentiment features** — the relay-mcp grave (it died chasing finance/MRM, seeded by a Grok chat). Memory-as-journal is a fine *use*; finance built *into* Relay is forbidden.
- **Berry built-in** — external/optional only; git diff is the truth signal; Berry only scores cited claims and costs ~2 model passes/claim.
- **MCP-client bridge** (Relay consuming other MCP servers, e.g. figma-console-mcp's 106 tools) — hosts already mount MCP servers directly; bridging fat servers explodes context cost; relay-mcp built it and it didn't matter.
- **Session-control over MCP / Command Central TUI extension** — not the mission; don't extend Phase 8.

## DEFERRED (post-v1, only if measured-needed)
- RAG/embeddings for memory (see #2).
- LLM lesson-extraction self-distill (keep only the free outcome-trust half).
- Operator/worker promotion ladder (ceremony for solo; cheap source-tag + unverified covers it; revisit for multi-actor).
- v2 remote MCP transport + OAuth (ChatGPT).

## Addendum 2026-07-18 — productization + bring-your-own-database (shipped)

Trigger: owner brief 2026-07-17 ("make Relay installable for strangers; memory must travel
across sessions, models, suppliers, and the user's choice of database"). Direct user demand —
passes the anti-bloat gate.

Shipped on branch `productize` (grounding: `.planning/productize/`):
- Driver: better-sqlite3 → libsql. Same sync API, same file format, FTS5 kept, prebuilt
  binaries for 9 platforms (no compiler requirement anywhere). NOT a driver registry — one
  driver, two targets.
- BYO-DB: `RELAY_DB_URL` (+ `RELAY_DB_AUTH_TOKEN`) selects an embedded replica synced against
  Turso or any libsql server. Local default unchanged. One schema, one code path. Verified
  cross-machine against a live sqld. Offline: reads from replica, saves refused (B-13).
- Install: `relay init` now also registers the MCP server with Claude Code/Desktop, Cursor,
  Codex; doctor gains per-client registration checks. Tarball stripped of tests/fixtures.
  Author-machine migration script removed.
- Distribution: npm REGISTRY publishing is parked by owner decision — install is git clone or
  a release tarball. The `relay`-name-is-taken problem is deferred with it.

Kill list unchanged and still binding. hosted-Relay ≠ hosted-DB: Relay still runs only on the
user's machine; only the database moved.
