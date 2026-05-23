# Relay Research Log — May 2026

**Purpose:** Living research document for Relay positioning, external tool assessments, and product-scope decisions.
**Rule:** Keep research here until it is either promoted into the roadmap/specs or deleted. If a conclusion becomes stale but still explains a decision, mark it `Deprecated YYYY-MM-DD` with the replacement.
**Latest update:** 2026-05-23 — product-positioning session on Relay as an agent operations/control layer.

---

## Current Conclusions

### Relay's category

**Current conclusion:** Relay should not be framed as a "solo CLI" or "local-first CLI" as the primary category.

Local execution is useful, but it is a wedge: cheap local LM Studio work, privacy by default, and low setup friction. It is not the core value prop. The durable category is:

> Relay is an agent operations/control layer for AI coding work.

That means Relay's job is to make agent work persistent, addressable, inspectable, steerable, and auditable across tools.

### Core value prop

**Current conclusion:** Relay's value is not "another agent that edits code." It is the layer around agents:

- persistent cross-tool memory
- task dispatch across providers/models
- live or near-live visibility into sessions/runs
- ability to supervise, steer, pause, kill, and resume agent work
- current and historical diffs for agent-produced changes
- record of prompts, model/provider, injected context, outputs, tool calls, failures, and lessons
- conflict detection and contradiction management across accumulated memory

Short form:

> Git tracks code history. Relay tracks and supervises the agent work that produces code.

### "Heard of Git?" answer

Git is necessary but too low-level. Git can show what changed after a commit. Relay should show the operational history around the work:

- the task given to the agent
- which model/provider ran it
- what context and memories were injected
- what the agent tried before producing a diff
- failed runs that never became commits
- competing attempts from different agents
- loop/retry/tool-call behavior
- what lessons should affect future sessions

So Relay does not replace Git. Relay records the AI labor layer that Git cannot see unless humans manually compress it into commit messages.

### Session supervision direction

**Current conclusion:** The stronger product shape is addressable live sessions.

The target interface should look roughly like:

```bash
relay session list
relay session tail <session_id>
relay session send <session_id> "..."
relay session inspect <session_id> --memory --diff --status
relay session pause <session_id>
relay session resume <session_id>
relay session kill <session_id>
```

For each live session, Relay should expose:

- active task and assigned owner/model/provider
- current plan/status
- transcript and tool-call stream
- shell commands, file reads/writes, and approvals
- current uncommitted diff
- injected memories/context
- errors, retries, loops, and suspicious behavior
- token/time/cost burn where available
- whether the session is blocked or needs human input

This is the clearest answer to the Git objection: Git is after-the-fact; Relay supervision is before, during, and after the agent acts.

### Current capability boundary

**Current state as of 2026-05-23:** Relay can inspect recorded runs and memory, but it does not yet expose first-class live bidirectional session control.

What works today:

- `relay memory recall` / `remember`
- `relay history`
- `relay diff <run_id>`
- `relay compare <run_a> <run_b>`
- `relay memory tail`
- Claude Code transcript discovery under `~/.claude/projects/.../*.jsonl`
- Claude Code resume/message path via `claude --resume <session_id> --print "..."`

What does not work today through Relay:

- attach to an already-running Claude/Codex/LM Studio session
- stream that session's live tool calls through Relay
- send steering messages through `relay session send`
- pause/resume/kill a specific session through Relay
- inspect a live session's hidden state as a first-class Relay object

For Claude Code session `11f4ce27-5f1d-4d8b-be22-c7ab2d018f6d`, the session exists on disk and can be resumed by Claude CLI. That is not the same as Relay-managed live supervision.

### Who Relay is for

**Current conclusion:** Relay is for people and teams running enough AI coding work that they need continuity and control:

- AI-heavy developers using multiple tools
- technical founders and consultants juggling project context
- tech leads supervising parallel agent work
- small engineering teams adopting autonomous coding workflows
- platform/infra teams that need local or hosted oversight before broader rollout

"Solo" may describe an install mode. It should not define the product.

### What to de-emphasize

- **Deprecated 2026-05-23:** "Solo CLI" as the headline category. Replacement: "agent operations/control layer."
- **Deprecated 2026-05-23:** "Local-first" as the headline value prop. Replacement: "local is one deployment/cost/privacy mode."
- **Still valid but secondary:** LM Studio local execution is useful because it removes cost and quota pressure.
- **Still valid but secondary:** SQLite/local storage is useful for simplicity, privacy, and portability.

---

## Next Product Slice — Relay Session Control

**Intent:** Build the first real product slice behind the new positioning. This is not a README smoke test and not a marketing exercise. The goal is to make the core product behavior real enough that skeptical LLMs and skeptical users can test it directly.

### Product thesis

Relay should make AI agent work addressable, visible, and steerable.

The primary object becomes a **session**: a durable unit of AI work tied to a tool, model/provider, transcript, working directory, task, events, files touched, current status, and related memory.

Today Relay can remember context and record delegated runs. The next step is to let a user ask:

- What AI sessions exist?
- Which ones are active or recently active?
- What is this session doing?
- What files and context did it touch?
- Can I send a correction into this specific session?

### First target

Target **Claude Code sessions first**.

Reason: Claude Code already persists session artifacts under `~/.claude/projects/.../*.jsonl`, and the CLI already supports resuming a specific session with:

```bash
claude --resume <session_id> --print "..."
```

Relay does not currently invoke Claude Code as a `relay run --provider claude-code` worker. This slice should not pretend otherwise. It should bridge existing Claude Code session artifacts and expose them through a Relay session surface.

### Initial command surface

```bash
relay session list
relay session inspect <session_id>
relay session tail <session_id> [--follow]
relay session send <session_id> "message"
```

`relay session list` should discover recent Claude Code sessions and show enough information to choose the right one: session ID, title/name when available, cwd, branch, last prompt, last activity time, and inferred state (`active`, `recent`, `stale`, `unknown`).

`relay session inspect <session_id>` should summarize one session: metadata, recent turns, notable tool calls, files touched if extractable, linked PR metadata if present, and Relay memories/context for that workdir when available.

`relay session tail <session_id>` should render a live or near-live transcript stream from Claude's JSONL. Initial rendering can be simple: user messages, assistant text, tool uses, tool results, stop hooks, errors, file-history snapshots, and metadata events. It must not mutate Claude's JSONL files.

`relay session send <session_id> "message"` should send a steering message by invoking Claude Code's resume path. This proves that a Relay-addressed session can receive a correction. It is not full live control yet.

### Product behavior this proves

If this slice works, Relay is no longer only a memory CLI or run-history viewer. It becomes the beginning of an operator layer:

> I have an AI coding session running. Relay can find it, show me what it is doing, and let me intervene.

That is the first credible bridge from "memory + dispatch" to "agent operations/control layer."

### Critical constraints

- Do not corrupt, rewrite, or append directly to Claude JSONL transcripts.
- Do not claim generic multi-tool support until Codex or another tool is also attachable.
- Do not claim pause/kill/approval gates until real process control exists.
- Do not claim Relay can inspect hidden model state. It can inspect persisted transcript/events only.
- Treat malformed or missing session artifacts as user-facing `RelayError`s with context.
- Keep this as a CLI-first slice. A TUI/control room can build on top after the primitives are real.

### What to test with other LLMs

Ask other LLMs to critique this product slice, not the old README:

> Relay wants to become an agent operations/control layer. The proposed first slice is `relay session list/inspect/tail/send` for Claude Code sessions by reading persisted JSONL and using `claude --resume` for steering. Be hostile: is this enough to make the positioning credible, what is still overclaimed, what implementation traps will break user trust, and what would make a skeptical GitHub visitor care?

Expected useful critique:

- whether `send` without pause/kill is enough to call it "steerable"
- whether Claude-only still supports the "across tools" story
- whether transcript tailing is actually live enough
- whether session discovery is reliable across cwd/project layouts
- whether the first demo is obvious and valuable

### Success bar

The slice is successful when it works against a real Claude Code session ID such as `11f4ce27-5f1d-4d8b-be22-c7ab2d018f6d` and a skeptical reviewer can see the product shift in one terminal demo:

1. `relay session list` finds the session.
2. `relay session inspect <id>` explains the session.
3. `relay session tail <id>` shows recent or live activity.
4. `relay session send <id> "..."` sends a real steering message through Claude Code.

Only after that should the public README move from "memory + audit trail" toward "operator console/control layer."

---

## External Tools Assessment — 2026-05-21

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

**Updated current conclusion:** Carrying memory + agency across LLM sessions is correct, but it is the lower-level mechanism. The stronger product frame is agent operations/control: Relay should make agent work durable, addressable, inspectable, steerable, and auditable.

**The real differentiators:**
- Memory that persists across CC sessions (hook-injected at SessionStart)
- Conflict detection when you've told Claude Code contradictory things over months
- Delegation to local LLMs (LM Studio) for coding tasks — no API cost
- Auto-extract captures lessons without manual effort
- Run/session history around prompts, context, outputs, diffs, and failures
- Future live supervision of addressable sessions (`session tail/send/inspect/pause/kill`)

**Not the differentiator:** Figma tools (too thin), being a security platform, or "local-only" as a product category.

**Scope note:** Multi-user features were out of scope for v0.2, but the product framing should not imply Relay is inherently solo. Multi-user/team/cloud modes are natural extensions of the same control-layer model.

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
