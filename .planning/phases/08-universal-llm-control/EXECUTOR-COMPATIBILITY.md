# Executor Compatibility Contract

Phase 8 plans must be executable by Claude Code, Codex, or another capable LLM runtime.

## Runtime-Neutral Rules

- Treat each `08-*-PLAN.md` as the source-of-truth prompt.
- Execute tasks in order within a plan.
- Use TDD for every code-producing task: RED, verify failure, GREEN, verify pass, REFACTOR if needed.
- Preserve immutable object patterns, Zod boundary validation, RelayError for user-facing failures, and synchronous better-sqlite3 semantics.
- Do not assume Claude-only tools are available.
- Do not assume Codex-only tools are available.
- If a referenced skill/tool is unavailable, use the runtime's closest safe equivalent and record the deviation in SUMMARY.md.

## Claude Code Mapping

- File edits: native Edit/Write tools.
- Subagents: GSD `gsd-executor` or Claude Code Task only when GSD execution asks for it.
- Checkpoints: AskUserQuestion when available.
- Plan execution: follow `$HOME/.claude/gsd-core/workflows/execute-plan.md`.
- Summary close-out: create the plan SUMMARY.md, commit production changes first, then commit SUMMARY/STATE/ROADMAP updates.

## Codex Mapping

- File edits: `apply_patch` for manual edits; formatting commands are allowed after edits.
- Subagents: `multi_agent_v1.spawn_agent` only when the user explicitly permits subagents and write scopes are disjoint.
- Checkpoints: ask concise plain-text questions in chat; do not require AskUserQuestion.
- Planning/task tracking: use `update_plan`.
- Plan execution: follow the same GSD plan semantics using local `gsd-sdk`/`gsd-tools.cjs` validators.
- Summary close-out: create SUMMARY.md with `apply_patch`, then commit in the same production-code -> SUMMARY -> STATE/ROADMAP order.

## Shared Subagent Rules

- Never run implementation subagents from a dirty main workspace.
- Use worktree isolation for implementation.
- Give each subagent a single plan or a clearly bounded task range.
- Do not dispatch two agents that edit overlapping files.
- Review every subagent result for spec compliance first, then code quality/security.
- Run plan-level verification after each plan and full verification after each wave.

## Checkpoint Translation

| Intent | Claude Code | Codex |
|--------|-------------|-------|
| Decision | AskUserQuestion | Plain-text question and wait |
| Human verification | AskUserQuestion or checkpoint task | Show evidence, ask for approval or issue |
| Human action | AskUserQuestion | Exact command/action request, wait for done |
| Plan review | grill/codex skill or manual Codex CLI loop | `codex exec -s read-only`; resume with `-c sandbox_mode="read-only"` |

## Non-Negotiables

- No code writes before the pre-execution plan review gate passes or the user explicitly accepts unresolved review issues.
- No self-granting model authority.
- No silent provider capability overclaims.
- No skipped SUMMARY.md after executing a GSD plan.
