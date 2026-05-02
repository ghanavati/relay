# v0.1.0 Retrospective

**Session date:** 2026-05-02
**Outcome:** v0.1.0 tagged (after Codex-found fixes), pushed to `github.com/ghanavati/relay`.
**Time-on-task:** ~6 hours (extract + 3 turns + Codex verification + retro).

## What shipped

- Working solo CLI with **15 commands**: `memory remember/recall/show-context/get/hook/to-rules`, `run`, `doctor`, `history`, `diff`, `compare`, `init`, plus the migration script.
- 70 source files (~70% smaller than the relay-mcp starting tree).
- 11 docs (README, AGENTS.md, 7 docs/, 4 recipes, CHANGELOG, CONTRIBUTING, SECURITY).
- 359/360 tests pass (99.7%); tsc clean.
- npm-pack tarball: 122.8 kB (504 kB unpacked, 123 files).
- AGPL-3.0 license, GitHub-private repo.

## What worked

### Concurrent LM Studio dispatch (worktree + commit-in-prompt)
Validated the peer session's pattern in production. **3 GLM lanes ran 4 docs in 134s vs ~480s sequential.** Total LM Studio compute across the session: ~10 lanes × ~2 min each = ~20 minutes of GLM-time, $0 cost. The worktree-isolation rule is non-negotiable; without it, all tasks serialize through `acquireWorkdirMutex`.

### Fresh-write for orchestration, extract for leaves
The first extract attempt (rsync + exclude) hit 130 tsc errors. Switching to whitelist + writing `cli.ts`, `cmd-run.ts`, `generic-http-runner.ts` from scratch took 2 hours and produced clean code. Extract for memory/, types, leaf utilities. Rewrite for entry points and dispatchers.

### Codex verification caught real shipping defects
At each "ready to ship" moment, Codex found things I missed:
- `relay memory show-context` documented but unwired (caught at v0.1.0 verification).
- CHANGELOG `Known limitations` listed `relay run` as not-yet-implemented even after it shipped.
- `--help` listed `compare`/`init` as unimplemented after they shipped.
- `cmd-corpus.ts` dead/unreachable in dispatcher.

Without the verification step, all four would have shipped. The cost of the Codex pass (~4 min) is trivial relative to a broken release.

## What stalled or backtracked

### Iterative trimming hit diminishing returns at 100 errors
Tried surgical fixes from 130 → 100 errors in 4 cycles. Each cycle cleared 30+, then 5, then 3, then plateaued. **Switched tactics at the residual:** dropped large files (commands.ts, server.ts, mcp/, adapters/, hosted/) wholesale and rewrote slim versions. That cut the tail in 2 cycles.

Rule that came out of this: when error count drops <5 per cycle, stop trimming and switch to fresh-write or bulk delete. Documented in AGENTS.md.

### LM Studio 500 errors mid-dispatch (twice)
First Turn 1 GLM dispatch had 2 of 3 lanes return HTTP 500 instantly. Second-attempt retry succeeded. Root cause unclear (possibly load-spike from prior queries). **Workaround:** retry once before escalating. Retry succeeded both times this session.

### GLM-generated code needed CC fix-up passes
Two GLM-generated files (`cmd-doctor.ts`, `cmd-diff.ts`, `cmd-budget.ts`, `cmd-compare.ts`) had real type bugs after merge:
- Used `io.stdout.write(...)` (treated as stream) instead of `io.stdout(...)` (function).
- Mis-typed RunRow with stricter optionals than the actual export.
- Used `BudgetStore.scope: 'provider'` (doesn't exist; valid scopes are 'model'/'owner'/'global').

Each was fixable in <2 min via Edit/sed. The cleaner pattern: **for files with non-trivial type contracts, give GLM the EXACT contract inline.** Don't make the worker discover it from imports.

### Default DB path was wrong for solo distro
Inherited `~/.relay-mcp/relay.db` from the parent project. First smoke test succeeded but `relay history` showed 0 runs because new runs were going to the parent DB. **Fix:** changed default to `~/.relay/relay.db` in db.ts. Caught by test (history empty after run). One-line fix; should have been on the keep/lose list.

## Process learnings

| Lesson | Where it lives now |
|---|---|
| Whitelist > exclude when extracting from coupled monorepos | AGENTS.md "Extraction methodology" pointer + earlier learnings doc |
| LM Studio = `isolation: worktree` + commit-in-prompt | AGENTS.md (1-line headline) + docs/recipes/parallel-with-lmstudio.md (full rules) |
| `tsc --noEmit` is authoritative for compile claims | AGENTS.md recurrent failure pattern #6 |
| GLM needs API contracts inline; don't make it import-discover | this retro + future spec discipline |
| Codex verification before tagging catches doc/code drift | demonstrated this session, should be permanent gate |
| Fresh-write orchestration (cli, dispatchers, runners) | this retro |
| When error count < 5/cycle, stop trimming, start rewriting | this retro |

## What v0.2 should focus on

Per Codex's strategic verdict from the original extract validation + this session's experience:

1. **`relay parallel`** — peer session's worktree+commit pattern, ported into Relay's CLI. The unique-value feature. Use AGENTS.md headline rule as the implementation guide.
2. **Test suite reinstatement** — write fresh tests for the new cmd-* files (currently inheriting only the memory tests + a few CLI tests). Target: each cmd has a smoke test + a parser-contract test.
3. **`relay budget` redesign** — BudgetStore's scope model (model/owner/global) doesn't natively support per-provider tracking. Either add 'provider' scope or use 'owner' creatively.
4. **Anthropic worker (text-only first)** — drop the broken stub from this session's dropped list, restore as a slim chat-completions client matching openrouter's pattern.
5. **Address the 1 transient test failure** — figure out what it is and fix or skip-with-reason.
6. **npm publish public** — flip `private: true` → `false` if you want the world to install it.

## Velocity note

10 GLM lanes + 4 Codex dispatches were used. Total LM Studio compute: ~$0. Codex compute: probably <$1 worth. The bottleneck was CC-side wiring + smoke testing, not external model spend. **For v0.2, lean even harder on parallel LM Studio for greenfield files.**

## Bottom line

v0.1.0 is a working solo CLI. The Codex verification round prevented 4 doc/code mismatches from shipping. The repo is small (70 src files), well-documented (11 docs), and can be installed via `npm install -g github:ghanavati/relay`. The next focused effort is `relay parallel`, which closes the unique-value loop.
