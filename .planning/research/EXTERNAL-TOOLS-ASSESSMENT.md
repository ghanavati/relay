# External Tools Assessment — May 2026

**Session:** AEGIS, TurboVec, figma-console-mcp evaluation against Relay roadmap
**Confidence:** HIGH — based on direct code read + live repo fetches

---

## 1. AEGIS (alejadxr/AEGIS)

Full cybersecurity platform — ransomware detection, EDR, SOAR, honeypots. 99% irrelevant.

### What's already in the codebase (AEGIS-inspired)

- `src/contracts/guardian.ts` — `AegisEvidence` 7-layer schema, `AutoAction` (none/alert/abort), guardian types (security, performance, integrity, shadow_audit)
- `src/runtime/capability/` — trust states (unknown → observed → reliable → unreliable → broken), risk levels (low/standard/critical), 4-step dispatch filter
- `src/runtime/store/migrations/auth.ts` — auth_users with team_id, auth_sessions (future path, not v0.2)

### Gaps worth closing — not in v0.2, but when multi-user ships

1. **Guardian policy → dispatch feedback loop** — `GuardianPolicyRow.auto_action` exists but dispatch-filter.ts doesn't check it. A fired `abort` guardian event has no effect on subsequent dispatches. One check needed in `dispatch-filter.ts`.

2. **Shannon entropy on worker diffs** — completely absent. After a run, compute entropy of changed content vs task scope. Anomalous = `guardian_type: 'integrity'` event. Add `diff_entropy` to `WorkerResult`.

3. **Canary memories** — plant synthetic memories with known-wrong content. If a worker output shows signs of acting on them → prompt injection detected → `guardian_type: 'security'` critical event. `MemoryStore` + guardian already exist, just not wired.

4. **Temporal kill-chain correlation** — `consecutive_failures` is per-capability in isolation. No sliding-window correlation across heterogeneous event sequences. Deferred.

### What NOT to take from AEGIS

Sigma rules, RaaS threat feeds, ransomware kill-chains, SSH honeypots, nmap scanning, firewall blocking. Wrong domain entirely.

---

## 2. TurboVec (RyanCodrai/turbovec)

Rust + Python vector index using TurboQuant algorithm. 16x compression at 2-bit, beats FAISS, data-oblivious quantization.

### Current decision (STACK.md) — correct

`embedding BLOB` (raw little-endian Float32Array) + JS cosine scan. Revisit at >50k memories. This is right for now.

### Key insight for when scale hits

**Data-oblivious quantization is the only viable approach for multi-tenant.** Traditional product quantization (FAISS PQ, Qdrant scalar) needs a calibration pass on representative data. With heterogeneous per-user memories there's no shared corpus to train on. TurboQuant uses random rotation + precomputed Lloyd-Max boundaries — no training needed.

### Migration path when 50k threshold triggers

1. **Phase 1 (now):** BLOB + JS cosine. Good to ~50k memories per deployment.
2. **Phase 2:** `sqlite-vec` — same-process, no sidecar, BLOB data directly usable. STACK.md called it alpha but it's the right next step.
3. **Phase 3 (if cloud/hosted):** Qdrant with collection-per-workdir isolation + TurboVec sidecar if recall quality matters more than operational simplicity.

No Node.js bindings exist for TurboVec. Not directly usable. Algorithm is the reference.

---

## 3. figma-console-mcp (southleft)

**106 tools** via Figma Desktop Bridge WebSocket plugin. Creates components, manages tokens, reads selection, builds layouts, syncs variables bidirectionally.

### Relay's own Figma tools — honest state

- `figma_list_layers` — live, read-only, works on any plan
- `figma_update_token` — live but **requires Enterprise plan** for variable writes
- `figma_get_selection` — deferred to v0.3 (needs Desktop Bridge)
- `figma_create_component` — deferred to v0.3 (needs Desktop Bridge)

**These are not a substitute for figma-console-mcp.** 2 live tools vs 106.

### What actually works now

Use **Claude Code + figma-console-mcp** for Figma work. That's the 106 tools. Relay doesn't add anything to this flow that a `design-system.md` file in the repo doesn't already handle better — a well-maintained design system file is more readable, version-controlled, and doesn't need a database.

### Relay + LM Studio + figma-console-mcp — not possible today

Relay's lmstudio-agentic worker uses its own tool registry. It doesn't speak MCP as a client. You cannot point a local LLM at figma-console-mcp's 106 tools through Relay. They're separate systems.

To combine them, Relay would need MCP client capability in the agentic worker — discover MCP tools, translate to OpenAI tool-call format, pass to LM Studio. Not built.

### Design system file vs Relay memory for Figma

A `design-system.md` (or referenced in `CLAUDE.md`) is better than Relay memory for deliberate, stable design system knowledge. Relay memory is for things that **accumulate dynamically** — lessons from past sessions, decisions made mid-task, contradictions caught over time. Not for intentionally authored reference material.

---

## 4. What Relay is actually for

**Core value:** Carrying memory + agency across LLM sessions so context isn't lost every time.

**The real differentiators:**
- Memory that persists across CC sessions (hook-injected at SessionStart)
- Conflict detection when you've told Claude Code contradictory things over months
- Delegation to local LLMs (LM Studio) for coding tasks — no API cost
- Auto-extract captures lessons without manual effort

**Not the differentiator:** Figma tools (too thin), multi-user features (out of scope for v0.2), being a security platform.

---

## 5. v0.2 scope — don't add anything from this assessment

All items above are for after v0.2 ships. The 6 remaining phases:

1. Agentic LM Studio runner — local tool-calling loop, no API cost
2. Embeddings wire-up — semantic recall, not just word-overlap
3. Conflict detection — contradicting memories flagged at recall
4. Delta extraction — auto-extract stops re-writing known patterns
5. Figma REST tools — already shipped (thin but done)
6. Verify budget command chains with schema_version

Ship those. Nothing else.
