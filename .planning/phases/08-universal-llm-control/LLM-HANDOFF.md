# Phase 8 LLM Handoff

**Read this first if you are taking over Phase 8.**

## Current State

Phase 8 is planned, not implemented. The goal is to build Universal LLM Control plus Command Central:

- A broker/session layer where supported LLM surfaces can register, expose truthful capabilities, send/receive brokered messages, and be audited.
- A terminal-native `relay tui` Command Central over the same broker.
- Model-driven control through Relay tools, with explicit grants, loop detection, budgets, and no self-escalation.

The plan is intentionally executable by both Claude Code and Codex. Do not assume one runtime.

## Read Order

1. `LLM-HANDOFF.md` - this file.
2. `EXECUTOR-COMPATIBILITY.md` - maps Claude Code and Codex execution tools.
3. `08-00-EXECUTION-GATES.md` - preflight blockers and execution gate order.
4. `CONTEXT.md` - decisions D-01 through D-15.
5. `RESEARCH.md` - research backing for broker, adapters, Command Central, and grill/codex review.
6. `08-01-PLAN.md` through `08-09-PLAN.md` - subagent-ready execution packets.

## Plan Index

| Plan | Wave | Purpose |
|------|------|---------|
| `08-01-PLAN.md` | 1 | Control types and synchronous SQLite session-control store. |
| `08-02-PLAN.md` | 2 | Broker policy, grants, loop detection, adapter registry, fake adapter. |
| `08-03-PLAN.md` | 3 | `relay session ...` CLI and LLM-facing control tools with LM Studio wiring. |
| `08-04-PLAN.md` | 3 | Claude Code, Codex, OpenRouter, and Anthropic adapters. |
| `08-05-PLAN.md` | 4 | Relay-owned process sessions, E2E diagnostics, control docs. |
| `08-06-PLAN.md` | 4 | Shared `ControlSnapshot` and Command Central layout. |
| `08-07-PLAN.md` | 5 | Command palette, inbox, grant approval queue. |
| `08-08-PLAN.md` | 6 | Model-driven operation visibility and TUI performance bounds. |
| `08-09-PLAN.md` | 7 | Command Central docs, diagnostics, UAT, final full verification. |

## Current Blockers Before Implementation

- PAUL command shims are restored at `~/.claude/commands/paul/*.md`, and workflows are restored at `~/.claude/paul-framework/`.
- Worktree isolation is ready: `.worktrees/phase-8-control` exists on branch `phase-8-control`, and `.worktrees/` is ignored.
- Baseline build/tests passed in the implementation worktree: `npm run build` passed and `npm test` passed with 1371 tests, 0 failures.
- Baseline doctor is blocked: `node dist/cli.js doctor --json` reports failed checks for LM Studio reachability and hook roundtrip, plus missing Anthropic key, auto-extract log, loaded LM Studio model, and consent files.
- grill-me-codex / `codex-review` adversarial plan review has not run.

## Required Preflight

1. Commit these planning artifacts.
2. Restore PAUL command shims or explicitly use archived PAUL semantics as a manual gate.
3. Resolve or explicitly accept the doctor blocker before implementation subagents:

   ```bash
   node dist/cli.js doctor --json
   ```

4. Run read-only Codex adversarial plan review over the full Phase 8 plan set. Store log at:

   ```text
   .planning/phases/08-universal-llm-control/08-CODEX-PLAN-REVIEW-LOG.md
   ```

5. Only after review approval or explicit human acceptance of unresolved issues, start wave execution.

## Runtime Rules

- Claude Code may use GSD `gsd-executor`, Task, Edit/Write, and AskUserQuestion.
- Codex must use `apply_patch`, `update_plan`, plain-text checkpoints, and `multi_agent_v1.spawn_agent` only when the user explicitly permits subagents.
- Both runtimes must run the same verification commands and produce the same SUMMARY.md artifacts.
- Do not spawn implementation agents from the dirty main workspace.
- Do not run two agents with overlapping file write sets.
- Do not skip TDD RED/GREEN verification.
- Do not skip SUMMARY.md for any executed plan.

## Fresh Validation Already Run

The following planning validations passed after the split into 9 plans:

```bash
gsd-sdk query init.plan-phase 8
gsd-sdk query verify.plan-structure .planning/phases/08-universal-llm-control/08-*-PLAN.md
gsd-sdk query check.decision-coverage-plan .planning/phases/08-universal-llm-control .planning/phases/08-universal-llm-control/CONTEXT.md
node ~/.claude/gsd-core/bin/gsd-tools.cjs gap-analysis --phase-dir .planning/phases/08-universal-llm-control --phase-req-ids "CONTROL-01,CONTROL-02,CONTROL-03,CONTROL-04,CONTROL-05,CONTROL-06,CONTROL-07,CONTROL-08,CONTROL-09,CONTROL-10,CONTROL-11,CONTROL-12,CONTROL-13,CONTROL-14,CONTROL-15,CONTROL-16,CONTROL-17"
git diff --check
```

Result summary:

- `plan_count=9`
- all plan structures valid
- decisions covered: `15/15`
- requirements + decisions covered: `32/32`
- whitespace check clean

## Dirty Worktree Warning

There are unrelated `.claude/tsc-cache/...` dirty files in the main workspace. Leave them alone unless the user explicitly asks to clean them.
