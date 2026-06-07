# Phase 8 Execution Gates

**Status:** Pre-execution checklist
**Purpose:** Define the gates that must pass before spawning implementation subagents for Phase 8 in either Claude Code or Codex.

## Current Gate State

| Gate | Status | Evidence / Action |
|------|--------|-------------------|
| GSD plan structure | PASS | `gsd-sdk query init.plan-phase 8` reports 9 plans; every `08-*-PLAN.md` validates. |
| GSD coverage | PASS | Gap analysis covers CONTROL-01 through CONTROL-17 and D-01 through D-15. |
| Executor portability | PASS | `EXECUTOR-COMPATIBILITY.md` maps Claude Code and Codex execution mechanisms. |
| Codex CLI version | PASS | Local `codex --version` reports `codex-cli 0.137.0`, which satisfies grill-me-codex's >=0.130 prerequisite. |
| PAUL active command pack | BLOCKED | Active `~/.claude/commands/paul/*.md` is missing. Archived PAUL files exist under `~/.claude/_archive/pre-cleanup-2026-05-19/`. Restore or explicitly use archived PAUL semantics before claiming PAUL gates are active. |
| Worktree isolation | PASS | Implementation worktree exists at `.worktrees/phase-8-control` on branch `phase-8-control`; `.worktrees/` is ignored and committed on main. |
| Baseline build/tests | PASS | In the implementation worktree, `npm run build` passed and `npm test` passed with 1371 tests, 0 failures. |
| Baseline doctor | BLOCKED | `node dist/cli.js doctor --json` failed: LM Studio endpoint unreachable and hook-roundtrip failed; anthropic, auto-extract, lmstudio-loaded, and consent-files are missing. Resolve or explicitly accept before subagents. |
| Grill/Codex plan review | NOT RUN | Run read-only Codex adversarial review over the Phase 8 GSD plan set before implementation. |

## Required Preflight Order

1. **Commit planning artifacts.**
   - Commit the Phase 8 GSD plan split and gate file before implementation work begins.
   - Leave unrelated `.claude/tsc-cache/...` changes untouched.

2. **Repair or explicitly bypass active PAUL shims.**
   - Preferred: restore active PAUL command shims from the archived command pack, or reinstall PAUL.
   - If not repaired, use the archived PAUL Plan/Apply/Unify semantics only as a documented manual gate and say PAUL is not actively installed.

3. **Confirm isolated worktree.**
   - Use `.worktrees/phase-8-control`.
   - Verify the worktree is on branch `phase-8-control` and expected base SHA before every subagent edit.

4. **Resolve baseline doctor blocker.**
   - Build/test baseline has passed.
   - Doctor still fails because local provider/hook environment is not fully healthy.
   - Fix LM Studio reachability and hook roundtrip, or record explicit human acceptance that implementation can proceed with those external checks failing.

5. **Run grill-me-codex / codex-review as a pre-execution plan review.**
   - Because Phase 8 already has GSD plans, use the repo's `codex-review` flow rather than the full requirements interview.
   - Codex must be read-only every round.
   - Use a bounded max round count, recommended `MAX_ROUNDS=3` for this plan.
   - Review the full Phase 8 plan set, not one file in isolation.
   - Store the review log under `.planning/phases/08-universal-llm-control/08-CODEX-PLAN-REVIEW-LOG.md`.

6. **Apply GSD/PAUL execution gates per plan.**
   - PLAN gate: plan validates, coverage passes, Codex review is approved or unresolved issues are explicitly accepted by the user.
   - APPLY gate: each implementation plan uses TDD red/green/refactor, commits production changes, creates SUMMARY.md, and commits the summary.
   - UNIFY gate: reconcile plan vs actual, update STATE/ROADMAP if needed, run final verification, and record deviations.

7. **Dispatch subagents by wave only.**
   - Wave 1: `08-01`
   - Wave 2: `08-02`
   - Wave 3: `08-03` and `08-04` may run in parallel if their write scopes remain disjoint.
   - Wave 4: `08-05` and `08-06` may run in parallel after their dependencies pass.
   - Wave 5: `08-07`
   - Wave 6: `08-08`
   - Wave 7: `08-09`

8. **Review every subagent result.**
   - Spec compliance review first.
   - Code quality/security review second.
   - Full verification after each wave.
   - No next wave until open review findings are fixed or explicitly deferred.

## Claude Code / Codex Runtime Contract

Every Phase 8 plan references `EXECUTOR-COMPATIBILITY.md`. Claude Code and Codex should execute the same plan semantics, but with different tool mappings:

- Claude Code can use GSD's native `gsd-executor`, Task, Edit/Write, and AskUserQuestion surfaces.
- Codex uses `apply_patch`, shell commands, `update_plan`, plain-text checkpoints, and `multi_agent_v1.spawn_agent` only when subagents are explicitly permitted.
- Both runtimes must produce the same artifacts: production commits, SUMMARY.md, verification output, and any STATE/ROADMAP updates.

## grill-me-codex Fit For This Project

The referenced `grill-me-codex` repository provides three Claude Code skills:

- `grill-me-codex`: user interview plus Codex adversarial plan review.
- `grill-with-docs-codex`: same, with docs/glossary/ADR pressure.
- `codex-review`: adversarial review only for an existing plan.

For Phase 8, the correct fit is `codex-review` because the plan already exists. It should run before any implementation subagent writes code. Codex reviews in a read-only sandbox, returns `VERDICT: APPROVED` or `VERDICT: REVISE`, and the same Codex session is resumed across rounds so it remembers prior critiques. If the round cap is reached without approval, that is a real deadlock to surface to the user, not a reason to pretend the plan is approved.

## Hard Rules

- Do not spawn implementation subagents from the dirty main workspace.
- Do not run two implementation subagents against overlapping write sets.
- Do not let Codex/grill review write files.
- Do not proceed past a failed RED/GREEN test gate.
- Do not claim PAUL gates are active until the active PAUL command pack is restored or the manual archived semantics are explicitly accepted.
- Do not skip SUMMARY.md for any executed GSD plan.
