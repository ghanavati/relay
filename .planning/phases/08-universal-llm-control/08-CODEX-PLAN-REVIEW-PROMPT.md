# Codex Plan Review Prompt

You are the adversarial `codex-review` reviewer for Relay Phase 8.

## Scope

Review the Phase 8 GSD plan set only. Do not modify files. Do not propose implementation code unless needed to explain a concrete concern.

Read these files:

- `.planning/phases/08-universal-llm-control/LLM-HANDOFF.md`
- `.planning/phases/08-universal-llm-control/EXECUTOR-COMPATIBILITY.md`
- `.planning/phases/08-universal-llm-control/08-00-EXECUTION-GATES.md`
- `.planning/phases/08-universal-llm-control/CONTEXT.md`
- `.planning/phases/08-universal-llm-control/RESEARCH.md`
- `.planning/phases/08-universal-llm-control/08-01-PLAN.md`
- `.planning/phases/08-universal-llm-control/08-02-PLAN.md`
- `.planning/phases/08-universal-llm-control/08-03-PLAN.md`
- `.planning/phases/08-universal-llm-control/08-04-PLAN.md`
- `.planning/phases/08-universal-llm-control/08-05-PLAN.md`
- `.planning/phases/08-universal-llm-control/08-06-PLAN.md`
- `.planning/phases/08-universal-llm-control/08-07-PLAN.md`
- `.planning/phases/08-universal-llm-control/08-08-PLAN.md`
- `.planning/phases/08-universal-llm-control/08-09-PLAN.md`
- `.planning/REQUIREMENTS.md`
- `.planning/ROADMAP.md`
- `AGENTS.md`

## What To Check

Attack the plan from these angles:

1. Can Claude Code execute it without Codex-only assumptions?
2. Can Codex execute it without Claude-only assumptions?
3. Are subagent waves safe, or do file write sets overlap in ways that will cause merge conflicts?
4. Are GSD/PAUL gates understandable and runnable by another LLM?
5. Are TDD RED/GREEN requirements strong enough for each code-producing task?
6. Are acceptance/verification commands concrete and scoped?
7. Does any plan overclaim live control for Claude Code, Codex, OpenRouter, Anthropic, or ambient sessions?
8. Does Command Central route through the same broker path as CLI and model tools?
9. Are safety gates sufficient for model-driven control: no self-grants, TTLs, budgets, loop detection, audit visibility?
10. Are there missing dependencies between plans or hidden shared-file conflicts?
11. Are external blockers recorded honestly: PAUL, LM Studio, hook roundtrip, grill review, worktree baseline?
12. Is the handoff readable enough for a future LLM to continue without this conversation?

## Output Format

Return exactly one of:

```text
VERDICT: APPROVED
```

or

```text
VERDICT: REVISE
```

Then provide findings ordered by severity:

- `HIGH`: must fix before implementation.
- `MEDIUM`: should fix before implementation or explicitly accept.
- `LOW`: useful clarity improvements.

Each finding must cite the exact file and, when possible, a line number or section title.

If the verdict is `APPROVED`, still list any residual risks or preflight blockers.
