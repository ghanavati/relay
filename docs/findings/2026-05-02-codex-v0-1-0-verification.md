# Relay v0.1.0 — Codex Verification
**Reviewer:** Codex gpt-5.3-codex (high)
**Date:** 2026-05-02
**Verdict:** FIX-FIRST

## Build status
Command run exactly as requested:
`cd /Users/ghanavati/ai-stack/Projects/Relay && npx tsc --ignoreDeprecations 5.0 2>&1 | grep -c 'error TS'`

Result: `0` (clean typecheck by this criterion).

## CLI surface verification
| Command | Handler | Dispatcher | Help | Status |
|---|---|---|---|---|
| `relay run <task>` | `src/cli/cmd-run.ts` (`executeRunCommand` at line 30) | `src/cli.ts:270` | yes | OK |
| `relay memory remember <content>` | `src/cli/cmd-memory-ops.ts` (`executeRememberCommand` at line 6) | `src/cli.ts:175` | yes | OK |
| `relay memory recall [<query>]` | `src/cli/cmd-memory-ops.ts` (`executeRecallCommand` at line 37) | `src/cli.ts:201` | yes | OK |
| `relay memory show-context <query>` | **missing** (`cmd-memory-ops.ts` has no `show-context` handler) | **missing** (`dispatchMemory` has no `action === 'show-context'` branch) | yes | **FAIL (claimed-but-missing)** |
| `relay memory get <memory_id>` | `src/cli/cmd-memory-ops.ts` (`executeGetMemoryCommand` at line 74) | `src/cli.ts:221` | yes | OK |
| `relay memory hook --install | --uninstall` | `src/cli/cmd-memory-ops.ts` (`executeMemoryHookCommand` at line 93) | `src/cli.ts:231` | yes | OK |
| `relay memory to-rules <memory_id>` | `src/cli/cmd-memory-ops.ts` (`executeMemoryToRulesCommand` at line 131) | `src/cli.ts:237` | yes | OK |

Observed runtime proof for the missing command:
`node dist/cli.js memory show-context test-query` returns unknown action (exit 2), despite being listed in both CHANGELOG and `--help`.

Wired-but-undocumented in `CHANGELOG.md` `[0.1.0]` section:
- Wired in dispatcher + help, but not listed under `[0.1.0] Added`: `relay doctor` (`src/cli.ts:271`), `relay history` (`src/cli.ts:276`), `relay diff` (`src/cli.ts:287`), `relay init` (`src/cli.ts:294`), `relay compare` (`src/cli.ts:299`).

Additional changelog/help contradictions:
- `[0.1.0] Known limitations` says `relay run` is not implemented and exits 64 (`CHANGELOG.md:66`), but `run` is implemented in `src/cli/cmd-run.ts` and dispatched in `src/cli.ts:270`.
- `[0.1.0] Known limitations` says HOOK_SCRIPT still points to `relay-mcp recall` (`CHANGELOG.md:68`), but code now uses `relay memory recall` (`src/cli/cmd-memory-ops.ts:89`).
- `--help` says `relay compare` and `relay init` are “NOT YET IMPLEMENTED” while both are wired (`src/cli.ts:294-305`).

## Bloat / duplication findings
- `AGENTS.md` size is `5006` bytes (< 6KB): PASS.
- No obvious duplicate sections inside `AGENTS.md`: PASS.
- `README.md` does not duplicate AGENTS rules content: PASS.
- Docs structure is mostly coherent by topic (`architecture`, `commands`, `configuration`, `memory`, `providers`, `quickstart`, `troubleshooting`, `recipes`, `findings`), but there are stale surfaces:
  - `docs/commands.md` documents commands not wired in v0.1.0 (`memory lint/gc/status/promote/consolidate`, `corpus *`).
  - `src/cli/cmd-corpus.ts` exists but is unreachable from dispatcher (`src/cli.ts:307-311` returns “not implemented” for `corpus`). This is obvious dead/unreachable CLI code in v0.1.0.
- `README.md` claims Anthropic direct delegation (`README.md:24`), but providers docs say native Anthropic worker is dropped in v0.1.0 (route via OpenRouter), so docs are inconsistent.

## Fluff found
- No placeholder text stubs, empty exports, or commented-out code blocks found in scanned files.
- One TODO exists with context (not fluff):
  - `src/memory/memory-lint-extra.test.ts:57` TODO for future contradictory-lesson lint test.

## Critical bugs (if any)
- `relay memory show-context` is advertised in CHANGELOG/help/docs but not implemented in dispatcher/handler (user-facing command break).
- Documentation/help/changelog contract is internally contradictory for shipped surface (`run`, `compare`, `init`, HOOK_SCRIPT note), which makes the release state ambiguous.

## Minor issues (if any)
- `src/cli/cmd-corpus.ts` is dead/unreachable in v0.1.0 dispatcher.
- `docs/commands.md` includes non-shipped commands without clear version gating.
- `package.json` includes `"files": ["bin/"]` but repo has no `bin/` directory (harmless but stale).
- `package.json` has `"private": true`, so npm publish is blocked unless intentionally toggled.

## Recommended fixes before tagging v0.1.0 final
1. Implement `relay memory show-context` in `dispatchMemory` + `cmd-memory-ops.ts` (or remove from help/changelog/docs if intentionally deferred).
2. Reconcile release messaging in one pass: `CHANGELOG.md [0.1.0]`, `src/cli.ts` help text, and `docs/commands.md` should describe the same shipped command surface.
3. Remove or gate unreachable `corpus` CLI code/docs for v0.1.0 to reduce dead surface.
4. Decide publish intent explicitly: keep `private: true` for GitHub-only install, or remove it before npm publish.

## Bottom line
TypeScript build is clean, package metadata largely looks correct (`prepublishOnly`, `bin`, `engines`, shebang), and sampled tests are sensible with no skip patterns found in the sampled checks. However, a documented command (`relay memory show-context`) is missing at runtime and release docs/help/changelog disagree on what v0.1.0 actually ships. This should be fixed before calling the tag ship-quality.
