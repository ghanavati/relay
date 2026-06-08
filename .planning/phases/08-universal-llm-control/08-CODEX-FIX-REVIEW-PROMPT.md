# Codex Re-Review — Phase 8 Security Fix

READ-ONLY. Do not modify files. You previously reviewed branch `phase-8-control` and returned VERDICT: REVISE with 1 HIGH + 3 MEDIUM + 3 LOW. A fix was applied for the HIGH and one MEDIUM. Verify the fix; do NOT re-litigate the deferred items.

## The fix to verify
Diff: `git diff 1de6cc3..HEAD -- src/ SECURITY.md`
Commits: `bd03439` (RED tests), `468a035` (fix), `c5ec4f4` (SECURITY.md).

Original HIGH: a model with `shell_exec` could shell out to the `relay` CLI (always `kind: human`) to bypass grants / self-grant / mutate `~/.relay/relay.db`.
Original MEDIUM (secret leak): Relay-owned spawned processes inherited parent env and persisted raw stdin/stdout/stderr/command text.

## What the fix claims (verify each against the code)
1. `src/security/env-sanitize.ts` — single source of truth: secret-shaped + entire `RELAY_*` namespace strip; `RELAY_AGENTIC_SANDBOX` marker constant.
2. `src/workers/lmstudio-agentic.ts` — `relay` added to a control-binary denylist (reusing the curl/ssh tokenizer); `buildShellExecEnv` drops `RELAY_*` incl. `RELAY_DB_PATH`; `defaultShellExec` force-injects `RELAY_AGENTIC_SANDBOX=1` per child AFTER the strip.
3. `src/cli/cmd-session.ts` — mutating subcommands (send/grant/approve/deny/revoke/spawn/delegate/pause/resume) refuse under the marker (`CONTROL_SANDBOX_DENIED`); allow-list = list/inspect/tail only (fail-closed).
4. `src/cli/cmd-run.ts`, `src/cli/cmd-parallel.ts` — set the marker on agentic paths.
5. `src/control/pty-session.ts` — `sanitizeChildEnv` for owned children; `redactSecrets` over process I/O + command/args before persisting; live operator mirror stays raw.
6. `SECURITY.md` — documents residuals honestly (NOT claimed airtight).

## Verify specifically
1. Is the env strip applied to BOTH the shell_exec child env AND the marker re-injected so a model can't read it as a normal var to learn it's sandboxed? Any path where `RELAY_DB_PATH` survives into a model-reachable env?
2. Is the CLI guard fail-closed (deny-by-default for unknown/future mutating subcommands)? Can any mutating control action run under the marker?
3. Does `redactSecrets` run BEFORE persistence on every owned-process write path (stdin, stdout, stderr, command, args, metadata)? Any path that persists raw?
4. Does `sanitizeChildEnv` drop secret-shaped + RELAY_* while keeping a usable env? Any secret leak remaining?
5. Are the documented residuals (sh -c / renamed binary / inline marker unset / direct sqlite3 on $HOME) accurate and complete, or is there an UNDOCUMENTED bypass the fix misses?
6. Did the fix introduce any regression in shell_exec's existing network-binary blocking or env behavior? Any over-strip that breaks legitimate use?

## Output
First line exactly: `VERDICT: APPROVED` or `VERDICT: REVISE`.
Then findings HIGH/MEDIUM/LOW with file:line + smallest fix. If APPROVED, confirm the HIGH is adequately mitigated for a local single-user tool and list any residual risk not already in SECURITY.md.
