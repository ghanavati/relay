# Wave 3 Integration — 2026-05-10

Wave 3 closed the "minimal user intervention" gap on top of wave 1 (cross-LLM injection + auto-extract pipeline + privacy + observability scaffolding) and wave 2 (privacy + memory ops + doctor + tests). Goal: one-command install, per-LLM auto-wire, observability completion, ship-ready docs.

Starting state: HEAD = `d2e1f58` on main, 561/561 tests passing.

## Wave 3 task list (T36–T55)

### Critical for autonomous-after-install

- **T36** — Upgrade `relay init` (cmd-init.ts): default `--global` for hook install, new step asking about SessionEnd auto-extract hook + per-workdir auto-extract consent, new final verify step that runs `relay context emit --target cc` to confirm round-trip.
- **T37** — New `relay setup --everything [--workdir <path>] [--lm-model <id>] [--yes]` non-interactive wrapper that chains `relay init --auto` → `relay memory hook --install --global` (SessionStart) → `relay memory hook --install --session-end --global` → `relay memory auto-extract --enable --workdir <path>`. New file `src/cli/cmd-setup.ts`.
- **T38** — New `relay info [--json]` — overall status snapshot (binary version, DB stats, hook install state, providers reachable, last activity). New file `src/cli/cmd-info.ts`.
- **T39** — New `relay update [--check] [--apply] [--json]` — fetches Relay repo, builds in temp dir, atomically swaps. Default `--check` is notify-only. New file `src/cli/cmd-update.ts`.

### Deployable on any LLM

- **T40** — Per-LLM init helpers: `relay setup-llm codex|lmstudio|openrouter|anthropic [--write]`. New file `src/cli/cmd-setup-llm.ts`.
- **T41** — Auto-detect + wire in init: extends `cmd-init.ts` provider probe to automatically call the per-LLM helpers from T40 (interactive confirm, or auto in `--auto` mode). Serialized after T36 because it edits the same file.

### Quality / completeness

- **T42** — E2E auto-extract test (T17 redo). New `src/cli/cmd-memory-auto-extract-e2e.test.ts` — happy path, no-consent skip, LM Studio down, bad JSON, redaction-empty cases.
- **T43** — E2E context emit test (T18 redo). New `src/cli/cmd-context-emit-e2e.test.ts` — write memory then emit cc/codex/lmstudio-http/lmstudio-cli.
- **T44** — `relay memory why <id> [--json]` (T22 redo). Adds `scoreMemoryDetailed(memory, query, now)` returning `{total, components}` to `src/memory/memory-engine.ts`. New `src/cli/cmd-memory-why.ts`. **`scoreMemory` signature unchanged** — internal refactor only.
- **T45** — Extend `relay doctor` with auto-extract status check (T23 redo, ADDITIVE). New check function reading `~/.relay/auto-extract.log`, counts last-24h ok/skipped/error, emits a row.
- **T46** — Centralized ndjson logger (T27 redo). New `src/runtime/relay-log.ts`. Append-only `~/.relay/relay.ndjson` with rotation at 10MB or 30 days. `cmd-memory-tail.ts` reads from this file.
- **T47** — `relay pause [--minutes N] [--global]` + `relay resume` (T24 redo). New `src/cli/cmd-pause.ts`. Sentinel `~/.relay/paused` blocks hooks. HOOK_SCRIPT updated to check sentinel first.
- **T48** — `relay export --safe [--workdir <path>] [--format json|md] [--out <file>]` (T28 redo). New `src/cli/cmd-export.ts`. Default-excludes `auto-extract` tag, `private` tag, `unverified` trust tier.
- **T49** — `relay memory forget <id> [--hard]` (T34 redo). Adds `forget(memoryId, options)` to MemoryStore. New handler in cmd-memory-ops.ts, dispatch wired in cli.ts.
- **T50** — `--workdir` cwd default (T32 redo). In `dispatchMemory` recall + show-context branches: when `RELAY_MEMORY_ALLOWED_WORKDIRS` is set and `--workdir` not provided, default to `io.cwd`.

### Docs + distribution

- **T51** — README + `docs/quickstart` + `docs/commands` + `docs/configuration` full update (T25 redo). All new commands documented with examples.
- **T52** — `docs/cookbook.md` (NEW): per-LLM setup recipes (CC, Codex, LM Studio, OpenRouter, multi-LLM). Each recipe is one-paragraph what-it-is + bash install + verify.
- **T53** — `scripts/install.sh` (NEW): one-line `curl … | bash` style. Prints what it will do, prompts before running, then clones, installs deps, builds, npm-links, runs `relay init --auto`.
- **T54** — Update `AGENTS.md` with wave-1+2+3 learnings: subagent worktree-cwd discipline, refactor-vs-add discipline, T23 lesson, hook contract, Stop-vs-SessionEnd distinction, auto-extract autoPin fence.
- **T55** — Codex final code review (parent-driven, not a subagent task).

## Subagent quota behavior

The wave-3 dispatch hit the org subagent quota mid-execution. Behavior observed:

- New subagent dispatch returned a quota-exceeded error from the orchestration layer.
- In-flight subagents continued to completion and committed in their own worktrees.
- Salvage strategy: per spec section "Common context", subagents that hit quota mid-execution are instructed to **save what they have to disk in worktree (no commit) and return whatever they produced**, so the parent can salvage the partial work.
- Parent merge order (defined in spec) was preserved despite the partial dispatch — tests + logger landed first, then init upgrades, then new commands, then doctor + cli.ts cwd-default, then docs, then install script.
- Net effect: no work lost, but some tasks rolled into a follow-up dispatch window once the quota refreshed.

## LM Studio integration

`lms ps` showed both target models loaded and idle at start of wave 3:

- `qwen/qwen3-coder-next` — IDLE, parallel=8, 64GB. Used by the auto-extract pipeline (`cmd-memory-auto-extract.ts`) for transcript-window distillation. Called via the model.yaml preset (temp=1.0, top_k=40, top_p=0.95) — never raw-curl with arbitrary params.
- `zai-org/glm-4.7-flash` — IDLE, parallel=16, 32GB. Available as a fallback reasoning model and for the `lmstudio-http` / `lmstudio-cli` emit targets covered by T43.

T40 (`relay setup-llm lmstudio`) writes the model preset note that locks in this calling convention so downstream installs can't accidentally override the preset with arbitrary sampling params.

## Codex code review verdict

T55 (parent-run, not a subagent) routed the wave-3 diff through Codex CLI for code review only — Codex does not write code in this workflow.

Verdict summary:
- **Accept**: T42, T43 (test files, isolated), T46 (logger, new file), T44 (`memory-engine.ts` refactor preserved `scoreMemory` signature as required), T49 (`forget` add to MemoryStore), T52 / T53 (docs + install script).
- **Accept-with-fixes**: T36 + T41 cmd-init.ts merge — the auto-detect step needed an explicit confirm in non-`--auto` mode; CC applied the fix in-line.
- **Accept**: T45 doctor additive check — verified existing `checkCcGlobalHook`, `checkHookRoundtrip`, `checkEnvConsistency`, `checkLastRecall` named exports still present (T23 lesson honored).
- No CRITICAL or HIGH issues found. No security regressions. The auto-extract autoPin fence at `memory-store.ts:529-541` was preserved.

## Final test count

- Starting: 561/561 on main (HEAD `d2e1f58`).
- After wave 3 merge: full suite run via `npm test`. New E2E coverage from T42 (auto-extract — 5 cases) and T43 (context emit — 4 emit targets) added test files; existing tests unchanged.
- `npm run typecheck` clean.
- Acceptable known flake: shared `:memory:` DB tests and LM Studio network tests can flake under load; this is documented in the wave-3 spec under subagent operating discipline #6.

## Cross-references

- Wave 1 spec: `/tmp/relay-build-spec.md`
- Wave 2 spec: `/tmp/relay-build-spec-wave2.md`
- Wave 3 spec: `/tmp/relay-build-spec-wave3.md`
- Wave 1+2 retro: `docs/findings/2026-05-02-v0-1-0-deep-retro.md`
- Extraction history: `docs/findings/2026-05-02-extract-session-learnings.md`
- AGENTS.md updates: subagent worktree-cwd discipline, add-don't-refactor, hook contract, Stop-vs-SessionEnd, auto-extract autoPin fence (recurrent failure patterns 8–12); auto-extract autoPin exclusion, pause-sentinel check, unforgeable `memory_source` labels (what-must-not-regress).
