# Phase 9 PRD — Relay MCP Server

**Status:** PLANNED — not implemented. PLAN gate not yet passed.
**Date:** 2026-06-12
**Origin:** Session findings — relay has MCP-shaped tool handlers (`src/tools/*.ts` return `McpToolResult`) but no MCP server entry point, no protocol dependency, and no way for any MCP client to reach them.
**Framework note:** This PRD follows GSD phase conventions (this directory layout, numbered plan packets, SUMMARY.md per executed plan) and embeds PAUL gates (PLAN / APPLY / UNIFY) as defined in `.planning/phases/08-universal-llm-control/08-00-EXECUTION-GATES.md`.

> **SEED disclaimer — read before trusting the SEED section.** No SEED framework exists in this repo or was findable in the execution environment (unlike GSD and PAUL, which are both on disk). The SEED block below is an *interpretation*: a seed pass in the sense used by swarm-style planners — pre-loaded verified context, key questions, and focus areas established before any execution, so no plan starts from zero. If SEED means something specific on your machine, correct this section before the PLAN gate.

---

## SEED — pre-loaded state for this phase

### Verified facts (checked against source in this session, 2026-06-12)

| Fact | Evidence |
|---|---|
| Tool handlers already return MCP-shaped results | `src/tools/recall.ts`, `remember.ts`, `memory_search.ts`, `get_memory.ts`, `corpus_query.ts`, `browse_runs.ts`, `compare-runs.ts`; shared shape in `src/tools/mcp-result.ts` |
| No MCP server exists | No stdio JSON-RPC entry point, no `@modelcontextprotocol/sdk` in `package.json`, no `relay mcp` subcommand in `src/cli/` |
| `src/contracts/mcp.ts` is client-side only | It validates MCP *attachments* relay passes to Codex runs — it does not serve anything |
| Read audit is already MCP-ready | `memory_reads.read_source` defaults to `'mcp'` (`src/runtime/store/db.ts:129`) |
| Trust-tier machinery exists and gates recall | `--min-trust=provisional` is already the `context emit` default; `unverified` entries are prefixed and excluded by default |
| Write path already sanitizes | Secret redaction + `<private>` stripping + length caps at `MemoryStore.remember()` |
| Packaging blocks distribution | `package.json` has `private: true`, version `0.1.2` (README claims 0.2.0), not published to npm |

### Key questions this phase must answer

1. How does a desktop MCP client (no meaningful cwd) scope memory to a workdir? (REQ-MCP-04)
2. Is the write tool exposed to arbitrary MCP clients safe by default? (D-03)
3. Official SDK dependency or hand-rolled stdio JSON-RPC? (D-01)
4. What is the interim install story while `private: true` stands? (D-02)

### Explicitly out of scope (honest framing)

- **This is a door, not a moat.** Free competitors (OpenMemory/mem0, Basic Memory, others) already ship memory MCP servers. This phase buys installability and presence inside Claude Desktop / Cursor / Windsurf — parity, not advantage. No requirement in this PRD claims differentiation.
- **No ambient injection.** MCP tools are model-invoked. The model calls `recall` when it decides to, which is unreliable without prompting. The MCP prompt (REQ-MCP-07) is one-tap, not zero-tap. Claims of "it just knows" are prohibited in docs produced by this phase.
- No HTTP transport, no remote/multi-user serving, no auth. Stdio only. Local only.
- No new memory features. The server exposes what exists.

---

## Problem

Relay's memory is unreachable from every MCP client. The handlers were written for MCP (the result type is named `McpToolResult`) but were never served. Consequence: relay cannot be tried by anyone inside Claude Desktop, Cursor, Windsurf, or Zed, and the project's only consumption surface is a CLI that requires git clone plus a Node toolchain.

## Users

1. **The owner** — wants relay memory reachable from Claude Desktop without manual invocation ceremony.
2. **Evaluators** — MCP-client users who will give relay one config-snippet's worth of patience.
3. **Harness builders** — anything that speaks MCP over stdio (Python harnesses included) gets a memory backend without relay's CLI.

## Requirements

Each requirement is testable. IDs are stable for plan packets.

| ID | Requirement |
|---|---|
| REQ-MCP-01 | `relay mcp serve` starts a stdio MCP server: handshake/initialize, `tools/list`, `tools/call`, clean shutdown on stdin close. Protocol errors map to JSON-RPC errors; `RelayError` maps to tool-result `isError` with the user-facing message. No silent failures (AGENTS.md rule). |
| REQ-MCP-02 | Read tools exposed: `relay_recall`, `relay_memory_search`, `relay_get_memory`, `relay_corpus_query`, `relay_browse_runs`, `relay_compare_runs` — thin adapters over the existing handlers in `src/tools/`. Zod schemas at the boundary reuse `src/contracts/`. |
| REQ-MCP-03 | Write tool `relay_remember` exposed per D-03 outcome. Every MCP-originated write is tagged with a distinct `memory_source` and enters at `unverified` trust. Existing redaction path applies unchanged. Writes are rollback-compatible (`relay memory rollback` semantics). |
| REQ-MCP-04 | Workdir semantics for cwd-less clients: explicit `workdir` tool argument wins; else `RELAY_MCP_DEFAULT_WORKDIR` from the client's server config `env` block; else the tool returns a clear error instructing configuration. Never silently falls back to a global/unscoped read or write. `RELAY_MEMORY_ALLOWED_WORKDIRS` is enforced identically to the CLI path. |
| REQ-MCP-05 | Recall over MCP defaults to `min_trust=provisional` (same as `context emit`). `unverified` entries are reachable only by explicit argument. Combined with REQ-MCP-03 this means MCP-written memories do not surface over MCP until promoted — the poisoning loop is closed by existing machinery, not new code. |
| REQ-MCP-06 | Every MCP read logs to `memory_reads` with `read_source='mcp'`; every write logs to the relay activity log. No new audit tables. |
| REQ-MCP-07 | One MCP prompt, `relay-context`: returns the rendered recalled-lessons layer (existing `context emit` content path) for the resolved workdir, for one-tap context loading in Claude Desktop. |
| REQ-MCP-08 | Docs: a Claude Desktop `claude_desktop_config.json` snippet and a Cursor snippet, copy-paste runnable, in `docs/mcp.md` + README section. Install path per D-02 outcome. |
| REQ-MCP-09 | Tests: `node:test`, `RELAY_DB_PATH=':memory:'`, concurrency 1. Protocol-level e2e: spawn the server, run initialize → tools/list → one call per exposed tool against a seeded store, assert shapes and audit rows. Full existing suite stays green (1804 at phase-8 merge). |
| REQ-MCP-10 | Scope guard: server shell (transport + registration + arg mapping) stays under ~600 production LOC. The moment it wants more, the phase stops and UNIFY records why. |

## Decisions required before PLAN gate

| ID | Decision | Recommendation |
|---|---|---|
| D-01 | `@modelcontextprotocol/sdk` dependency vs hand-rolled stdio JSON-RPC | Take the SDK. The repo's lean-dependency ethos is real (4 runtime deps), but hand-rolling a moving protocol trades one-time dep aversion for permanent drift risk. |
| D-02 | Distribution: drop `private: true` + publish (enables `npx`) vs document absolute-path `node dist/cli.js mcp serve` config | Publishing is the point of the phase; if deferred, ship absolute-path config as interim and say so in docs. Also reconcile the 0.1.2 / 0.2.0 version split — it precedes any public artifact. |
| D-03 | Write tool default: on, or read-only with `--allow-write` flag | On, because REQ-MCP-03 + REQ-MCP-05 quarantine MCP writes at `unverified` until human promotion. If that argument fails adversarial review, flip to read-only default. |
| D-04 | Tool name prefix | `relay_` prefix on all tools — avoids collisions in multi-server clients. |
| D-05 | SEED semantics | Confirm or correct the SEED interpretation at the top of this PRD. |

## PAUL gates for this phase

- **PLAN gate:** D-01..D-05 resolved or explicitly accepted; plan packets 09-01..09-04 validate against GSD plan structure; adversarial review (Codex `codex-review` or equivalent) run over the full packet set, log stored at `09-CODEX-PLAN-REVIEW-LOG.md`; unresolved findings explicitly accepted by the human.
- **APPLY gate:** per packet — TDD red/green/refactor; production commit; SUMMARY.md written and committed. No skipped RED states.
- **UNIFY gate:** reconcile plan vs actual; update `.planning/STATE.md` and `ROADMAP.md`; record deviations (especially any REQ-MCP-10 breach); final full-suite verification; phase SUMMARY.

## Plan packet split (waves)

| Packet | Wave | Scope |
|---|---|---|
| `09-01-PLAN.md` | 1 | Protocol skeleton: `relay mcp serve` command, D-01 transport, initialize/tools-list/shutdown, error mapping. |
| `09-02-PLAN.md` | 2 | Read tools (REQ-MCP-02) + workdir resolution (REQ-MCP-04) + read audit (REQ-MCP-06) + e2e tests. |
| `09-03-PLAN.md` | 2 | Write tool (REQ-MCP-03) + trust quarantine recall defaults (REQ-MCP-05) + rollback compatibility + tests. |
| `09-04-PLAN.md` | 3 | `relay-context` prompt (REQ-MCP-07), docs + client snippets (REQ-MCP-08), D-02 execution, UAT script. |

## Success criteria (measurable, no adoption claims)

1. From the docs snippet alone, a fresh Claude Desktop config reaches `tools/list` in under 2 minutes.
2. Every exposed tool round-trips from a real MCP client harness against a seeded DB, with correct audit rows.
3. Full suite green; new tests cover handshake + every tool + workdir-refusal path + write-quarantine path.
4. REQ-MCP-10 LOC guard holds.

## Risks

| Risk | Standing |
|---|---|
| Parity, not advantage — category already served by free competitors | Accepted by design; this phase is an enabler. Differentiation is out of scope here. |
| Model-invoked recall is unreliable without prompting | Mitigated only partially by REQ-MCP-07. Documented honestly per SEED scope rules. |
| Memory poisoning via open write path | Closed by REQ-MCP-03 + REQ-MCP-05 quarantine; adversarial review must attack this specifically. |
| Desktop workdir ambiguity → cross-project leakage | REQ-MCP-04 refuses rather than guesses. |
| Protocol drift | D-01 SDK recommendation. |
| Scope creep (this repo's recurring failure mode) | REQ-MCP-10 hard guard + UNIFY deviation record. |

## Verification commands

```bash
npm run build && npm run typecheck && npm test
node dist/cli.js mcp serve --selfcheck   # to be added in 09-01: handshake against itself, exit 0
node dist/cli.js doctor --json           # existing health surface; must not regress
```
