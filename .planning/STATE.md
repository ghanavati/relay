# State

## Current Position

Phase: Not started (defining requirements for v0.2)
Plan: —
Status: Bootstrap complete, ready for `/gsd-new-milestone` v0.2 flow
Last activity: 2026-05-18 — bootstrap PROJECT.md + MILESTONES.md from existing repo

## Accumulated Context

Relay v0.1.2 is shipped. ROADMAP.md at repo root describes 7 v0.2 items:
1. Schema cleanup
2. Agentic local LLM runner (unblocks Figma + all tool-use)
3. Figma integration (depends on #2)
4. Conflict detection in memory recall (δ-mem inspired)
5. Semantic embeddings (nomic-embed-text-v1.5)
6. Delta extraction in auto-extract
7. Budget command (deferred from v0.1)

Sequencing per ROADMAP §Sequencing: 1 → 2 → 3 (conflicts) → 4 (embeddings) → 5 (delta) → 6 (Figma) → 7 (budget).

Constraints:
- NO codex (CC subagents only)
- TDD strict (RED → GREEN → IMPROVE, 80%+ coverage, node:test framework)
- Local models (qwen3-coder-next + nomic-embed) as RUNTIME targets, not code writers
- Workdir-scoped privacy preserved across all changes

---

Last updated: 2026-05-18
