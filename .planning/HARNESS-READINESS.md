# Harness readiness — verdict + sequence

Verified 2026-06-29 on `phase-9-v04`.

## Verdict: NOT ready for harness/loop work (incl. the split-trust Excel idea)

Evidence:
- **No verify/close-the-loop in code.** `quality_gate` is a declared schema field
  (`src/contracts/delegate.ts:171`) with no executor. The agentic loop is OPEN —
  `src/workers/lmstudio-agentic.ts:814` returns success on "no tool calls", never
  checks the task was actually done.
- **The harness analysis was off-trunk.** `HARNESS-LOOPS.md` was a gap-analysis doc on
  the divergent branch `claude/local-model-git-access-rlplk3`, not on trunk, not built.
- **Two Phase-9 branches diverged:** 53 commits unique to `phase-9-v04`, 8 unique to the
  other, overlapping on core MCP files (`server.ts`, `cmd-mcp.ts`, `db.ts`). New loop
  work cannot land cleanly until one branch is trunk.

## Sequence to get ready

1. **Reconcile branches — and it's a product choice, not a harvest.** The two branches
   carry two *different* MCP servers:
   - ours (`phase-9-v04`): exactly 2 tools (`relay_memory_recall`/`save`), the locked
     v0.4 scope; SDK-probe guarded; version read from package.json.
   - theirs (cloud): 7 tools (adds `memory_search`, `get_memory`, `corpus_query`,
     `browse_runs`, `compare_runs`) + a `relay-context` prompt — a richer ops-layer
     surface where `browse_runs`/`compare_runs` match the EXTERNAL-TOOLS-ASSESSMENT
     "Git for agent work" positioning, but it breaks the v0.4 two-tool lock without
     re-authorization, hardcodes the version, and imports the SDK directly.

   So this is the anti-bloat gate vs the documented ops-layer direction, in tension.
   **Decide the philosophy (minimal vs ops-layer) before merging.** Then keep the cleaner
   base (SDK-probe, version-from-package.json) and harvest the clean non-conflicting wins
   regardless: `HARNESS-LOOPS.md`, the control-e2e CI fix (`4dbd476`), phase-9 PRD/SUMMARY.
2. **Build the foundational loop.** Make `quality_gate` execute — run a user-supplied
   check command and loop on its exit code (instruct → execute → verify → re-instruct).
   Mechanism, not policy: the user defines the check, Relay runs it and loops on the
   result; Relay never decides what "done" means. This is the spine — escalation and
   split-trust both depend on it.
3. **Then split-trust orchestration is buildable.** Frontier writes the procedure (sees
   structure, never values); the local model executes on the confidential data
   on-machine; verify locally; re-instruct with redacted gaps.

The split-trust Excel intermediary needs steps 1 + 2 first. Not now.
