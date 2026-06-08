# Codex Fix Re-Review Log — Phase 8

**Reviewer:** Codex (codex-cli 0.137.0, `codex exec -s read-only`), 2026-06-08. Read-only; ran node one-liners to prove the env-matcher gap, did not run the test suite.
**Scope:** the security fix `1de6cc3..HEAD` (commits bd03439 RED, 468a035 fix, c5ec4f4 SECURITY.md).

## VERDICT: REVISE (HIGH resolved; 2 new MEDIUM in the fix)

### HIGH — RESOLVED
The original `relay session` control bypass is adequately mitigated when the sandbox marker is inherited: `relay` command heads blocked in `shell_exec`, and `cmd-session` denies everything except `list`/`inspect`/`tail` under `RELAY_AGENTIC_SANDBOX` (fail-closed). Confirmed: `RELAY_DB_PATH` stripped from shell_exec + owned-child envs; `defaultShellExec` reinjects the marker; network-binary blocking unchanged.

### MEDIUM 1 — `sanitizeChildEnv` secret-name matcher too weak
`src/security/env-sanitize.ts:21`. `_` is a regex word char, so `KEY\b`/`AUTH\b` misses `_`-delimited names. Codex proved: `AWS_ACCESS_KEY_ID`, `GOOGLE_APPLICATION_CREDENTIALS`, `SSH_AUTH_SOCK`, `MYSQL_PWD` all return false → survive into Relay-owned children (`pty-session.ts:161`). Fix: delimiter-aware matcher (`_`/`-` as boundaries), add `CREDENTIALS?` and `PWD`, test the named cases.

### MEDIUM 2 — raw spawn_error persisted
`src/control/pty-session.ts:368,380`. Raw `spawn_error` goes into session metadata + `session_ended` event; a binary path containing a token (`spawn /tmp/sk-proj-… ENOENT`) bypasses command redaction. Fix: redact `errorDetail` before metadata/payload; add a failing-spawn test.

### LOW — none.

## Disposition — FIXED 2026-06-08
Both MEDIUMs fixed (opt-1 scope). `isSecretEnvName` rewritten delimiter-aware (split on non-alnum, per-segment + glued match, standalone-PWD kept) — `AWS_ACCESS_KEY_ID`/`GOOGLE_APPLICATION_CREDENTIALS`/`SSH_AUTH_SOCK`/`MYSQL_PWD` now stripped from both shell_exec and owned-child envs (shared matcher). `recordStoppedState` redacts `errorDetail` before metadata/event persistence. New `src/security/env-sanitize.test.ts` + pty spawn-error test. Full suite 1800/1800. Final Codex pass pending.
