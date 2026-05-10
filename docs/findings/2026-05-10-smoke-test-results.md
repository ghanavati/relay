# Relay smoke-test results — first run (2026-05-10)

T55 of `/tmp/relay-build-spec-wave3.md`. New `scripts/smoke-test.sh` simulates a
fresh user installing Relay from scratch into an isolated `HOME` and exercising
the v0.1.0 surface plus the wave-3 context-emit pipeline.

## Environment

- Host: macOS Darwin 25.4.0
- Node: v20.19.6 (`>=20` engines OK)
- npm: 10.x (bundled with Node 20.19.6)
- Worktree: `worktree-agent-a2967d6383e9d2123`
- Git HEAD: `437ab10c58a5215e310e019245a832ce2263087c` (main: `chore: include context-typed memories in SessionStart hook`)
- Tmp HOME: `mktemp -d -t relay-smoke-XXXXXX` with empty `.relay/` and `.claude/`
- DB: `RELAY_DB_PATH=$HOME/.relay/relay.db`

## Outcome

**6 pass / 1 fail / exit 1**

| # | Step                                                | Result | Notes                                                                             |
| - | --------------------------------------------------- | ------ | --------------------------------------------------------------------------------- |
| 1 | `mktemp -d` HOME bootstrap                          | n/a    | Implicit; no probe                                                                |
| 2 | `npm run build`                                     | PASS   | Clean tsc; `dist/cli.js` chmod +x                                                 |
| 3 | `npm link`                                          | PASS   | Local link, not global registry; `relay` resolves on `$PATH`                      |
| 4 | `HOME=tmp` + `RELAY_DB_PATH` export                 | n/a    | Implicit                                                                          |
| 5 | `relay init --auto --json`                          | PASS   | Exit 0; valid JSON                                                                |
| 6 | `relay memory remember 'fresh smoke test fact' ...` | PASS   | Exit 0; valid JSON                                                                |
| 7 | `relay memory recall 'fresh' --json`                | PASS   | Exit 0; written memory found in JSON via `jq -e`                                  |
| 8 | `relay context emit --target cc --workdir $HOME`    | FAIL   | rc=2 — `relay context` command does not exist on this branch (wave-3 T31/T36/T41) |
| 9 | `relay doctor --json`                               | PASS   | Exit 0; valid JSON                                                                |

## Verbatim run output

```text
[PASS] npm run build
[PASS] npm link
[PASS] relay init --auto --json
[PASS] relay memory remember
[PASS] relay memory recall (memory present)
[FAIL] relay context emit --target cc (rc=2, missing hookSpecificOutput)
[PASS] relay doctor --json

--- smoke-test summary ---
pass: 6
fail: 1
failed steps:
  - relay context emit --target cc (rc=2, missing hookSpecificOutput)
```

## Failure analysis

`relay context emit` is **not yet wired into `src/cli.ts`** at HEAD `437ab10`.
The wave-3 spec references it via `cmd-memory-ops.ts`'s `HOOK_SCRIPT` constant
(`relay context emit --target cc --workdir "${CLAUDE_PROJECT_DIR:-$PWD}" ...`),
but the corresponding `src/cli/cmd-context-emit.ts` and `dispatchContext`
branch in `src/cli.ts` haven't landed in this worktree yet.

This is exactly the class of gap a smoke test catches that unit tests miss: the
SessionStart hook script Relay installs *today* would shell out to a command
that doesn't exist on the user's box, and silently swallow the failure via the
hook's trailing `|| true`. A fresh user wiring up CC would see no
`additionalContext` injected and have no obvious error to debug.

**Fix-forward**: ship T36 + T41 (or whatever wave-3 task delivers
`cmd-context-emit.ts` + the `dispatchContext` wiring) before announcing
"installable for fresh users." Until then, the SessionStart hook is a no-op.

## Steps that did pass — what they prove

- The compiled CLI is truly relocatable: an isolated `HOME` works, the SQLite
  DB initializes under `$RELAY_DB_PATH`, and `relay init --auto --json` writes
  a valid `~/.relay/config.json` without prompting.
- Memory write/read roundtrip works end-to-end through the linked `relay`
  binary (not just through unit-test stubs against `:memory:`).
- `relay doctor --json` parses cleanly even on a box where Codex /
  OPENROUTER_API_KEY / LM Studio / Anthropic are all missing — the probes
  return `missing` not `failed`, so the doctor itself exits 0.

## Cleanup

`trap cleanup EXIT` runs `npm unlink` from the repo root with the *real* HOME
restored, then `rm -rf "$TMP_HOME"`. Confirmed clean — no leftover `relay`
symlink in `$REAL_HOME/.npm-global/bin` after the run.

## Re-run

```bash
relay verify
```

Re-run after each subagent merge to keep the gap list honest.

> Note: `scripts/smoke-test.sh` was deprecated by T16 and now thinly wraps
> `relay verify`. Invoke the CLI command directly going forward.
