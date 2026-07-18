# Phase 9 SUMMARY — MCP server (PLAN → APPLY → UNIFY record)

**Executed:** 2026-06-12, single session, branch `claude/irys-stateful-swarms-assess-jwkcds`.
**Outcome:** SHIPPED. `relay mcp serve` works end-to-end; 21 new tests green; full suite shows zero new failures against the clean baseline.

This phase collapsed the four planned packets (09-01..09-04) into one TDD
cycle + one docs pass — deviation recorded below. This file is the per-PRD
SUMMARY and the UNIFY reconciliation in one place.

---

## What shipped (plan vs actual)

| REQ | Status | Where |
|---|---|---|
| REQ-MCP-01 stdio server, error mapping, selfcheck | DONE | `src/cli/cmd-mcp.ts`, `src/mcp/server.ts` (guard) |
| REQ-MCP-02 six read tools | DONE | `src/mcp/server.ts` |
| REQ-MCP-03 quarantined write tool | DONE | `relay_remember` — `worker-mcp` source, `pinned`/`source_run_id` not exposed |
| REQ-MCP-04 workdir gate | DONE | `src/mcp/workdir.ts` — arg > `RELAY_MCP_DEFAULT_WORKDIR` > refuse |
| REQ-MCP-05 provisional recall floor | DONE | `toRecallArgs` defaults `min_trust='provisional'` |
| REQ-MCP-06 audit | DONE | existing `logReads(source:'mcp')` path; asserted in e2e against the DB file |
| REQ-MCP-07 `relay-context` prompt | DONE | mirrors `show-context` defaults (lesson+decision, 800 tokens) |
| REQ-MCP-08 docs | DONE | `docs/mcp.md`, README section, `--help` block |
| REQ-MCP-09 tests | DONE | 21 tests: pure (workdir), in-process (InMemoryTransport client), protocol e2e (spawned binary, raw newline JSON-RPC) |
| REQ-MCP-10 ≤600 LOC guard | DONE | server.ts + workdir.ts + cmd-mcp.ts ≈ 420 production LOC |

## Decisions resolved (PRD D-01..D-05)

- **D-01: SDK.** `@modelcontextprotocol/sdk@^1.29.0` added — registry verified reachable, Zod 3.23.8 peer-compatible. First new runtime dependency in the repo; revisit only if dep weight becomes a complaint.
- **D-02: NOT resolved here — deliberately.** CHANGELOG shows v0.2.0 was never cut; `[Unreleased]` holds phase 8. Bumping package.json or publishing to npm is a release act for the maintainer, not an implementation detail. Docs ship with absolute-path client config until then. README's 0.2.0 badge remains aspirational — flagged, untouched.
- **D-03: writes ON, quarantined.** Strengthened beyond the PRD: `pinned` exposure was identified as a quarantine escape (pinned ⇒ trusted) and removed from the MCP schema entirely, alongside `source_run_id` (rate-limit bypass). Hostile-extras test asserts both are stripped.
- **D-04: `relay_` prefix.** Applied to all seven tools.
- **D-05: SEED.** Still awaiting the human's confirmation of the interpretation used in the PRD.

## Beyond-plan additions (and why)

- **Pause sentinel enforcement** — the PRD missed it; `relay pause` is the documented privacy off-switch and MCP recall would have bypassed it. Recall/search/remember/prompt all return `paused:true` while the sentinel holds. e2e-tested.
- **Found+fixed latent bug** — `RunStore.list()` has referenced `runs.archived_at` since the extraction; no DDL or migration ever created the column, so default listing threw on fresh DBs. Only caller was `handleBrowseRuns` (orphaned until this phase re-served it). PRAGMA-guarded migration added (`migrateRunsArchivedAt`, db.ts). This validates the PRD's framing: the handlers were orphans of relay-mcp, untested against the live schema.

## Verification evidence

- RED: 18/19 new tests failing against stubs (captured in session before implementation).
- GREEN: 21/21 new tests pass.
- Full suite: clean-baseline comparison (stash + `npm run clean` + rebuild — naive stash comparison was contaminated by stale `dist/` orphans, worth remembering):
  - baseline: 1804 tests, 3 fail
  - phase 9: 1825 tests, 3 fail — **identical three**, all container artifacts (2× control-e2e require LM Studio; 1× T7 expects read-only dirs to block writes, container runs as root).
- `tsc --noEmit` clean. Selfcheck exits 0.

## Deviations from PAUL/GSD process

1. Packets 09-01..04 executed as one implementation commit + one docs commit instead of four — `server.ts` registers all tools in one module; artificial splits would have produced non-compiling intermediate commits. RED/GREEN evidence preserved in session transcript.
2. Adversarial Codex plan review (PLAN gate) not run — Codex unavailable in this environment; the human's "run the prd" taken as explicit acceptance per PRD gate language. A retroactive `codex-review` over `src/mcp/` is recommended at next opportunity, attack surface: the quarantine path.
3. D-02 deferred upward (release act), as above.

## Follow-ups for the maintainer

1. Cut the version decision: publish to npm (enables `npx` in client configs, removes absolute paths from docs) or explicitly stay source-install.
2. Retroactive adversarial review of `src/mcp/` (quarantine bypass attempts, workdir gate).
3. Consider exposing `relay memory why` over MCP for in-client provenance checks.
4. Confirm/correct SEED (PRD D-05).
