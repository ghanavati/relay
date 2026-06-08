# Codex Implementation Review Log — Phase 8

**Reviewer:** Codex (codex-cli 0.137.0, `codex exec -s read-only`), 2026-06-08. Credits available (the 21:44 plan-review attempt died on `has_credits:false`; refilled by this run).
**Scope:** `git diff main...phase-8-control -- src/`, focused on control core. Read-only — no files modified, no tests run by Codex.

## VERDICT: REVISE

### Confirmed sound (Codex positives)
- Brokered LLM tool sends are caller-bound and default-deny.
- Grant budget decrement + enqueue is transactional (no budget-overrun race via the broker path).
- Redaction happens before broker persistence and before the audit hash.
- Command Central read model uses bounded helpers.

### HIGH — shell_exec → relay-binary control bypass (confirms 08-03 flag)
`src/cli/cmd-session.ts:403,501,668`, `src/workers/lmstudio-agentic.ts:64,217`, `src/cli/cmd-run.ts:155`.
A `lmstudio-agentic` run exposes both `shell_exec` and the in-process Relay control tools. The mutating `relay session ...` CLI always acts as `kind: human`. So a model with `shell_exec` can shell out to `relay session send` (bypassing llm default-deny entirely) or `relay session grant <self> <target>` / `approve` (minting its own authority). `shell_exec` env preserves `HOME` and non-secret-shaped `RELAY_*` (e.g. `RELAY_DB_PATH`), so direct SQLite mutation of the control DB is also reachable.
**Smallest fix:** keep the Relay control DB/binary out of model shell reach — strip `RELAY_DB_PATH` and `RELAY_*` control vars in the `shell_exec` env allowlist, and make mutating `relay session` commands refuse (or downgrade to `kind: llm`, grant-required) when an agentic-sandbox env marker is present. Design intent: models use the in-process caller-bound tools, never the human CLI.

### MEDIUM
1. **Codex MCP-only mailbox can drop messages** — `src/control/adapters/codex.ts:109,201`, `adapter-registry.ts:107`. MCP-only sessions report `mailbox`, but registry push-drain calls `deliver()` then marks delivered; with no instructions render boundary the message can vanish before the model pulls it. Fix: split pull-mailbox from push-delivery capability, or make `CodexControlAdapter.deliver()` leave queued unless `context_inject` exists.
2. **Unbounded mailbox reads on hot paths** — `session-store.ts:442`, `tools.ts:402`, `adapter-registry.ts:107`, `pty-session.ts:401`. Read-all-then-limit / full-queue drains; a large mailbox can block model tools or delivery polling. Fix: `LIMIT ?` target-mailbox queries + `COUNT(*)` helper + batched drains.
3. **Spawned-process secret leak** — `pty-session.ts:153,185,260,291`. Relay-owned children inherit parent env; raw stdin/stdout/stderr/command text persists to control events/metadata, so a child printing env/args can store provider keys in SQLite and surface them in Command Central. Fix: sanitized child env + run the shared redactor before persisting process I/O and command metadata.

### LOW
1. **Mutating-content loops evade detection** — `broker.ts:101,381`. Normalized-hash loop detection misses `ping 1`, `ping 2`, …; only the grant budget stops them. Fix: pair-level rate/alternation detection independent of content hash.
2. **Swallowed audit/recording failures** — `pty-session.ts:295,338,490`. Contrary to project error-handling rules. Fix: log with context or append a fallback failure event.
3. **`relay parallel` lacks control wiring** — `cmd-parallel.ts:54,172`. `lmstudio-agentic` under `relay parallel` exposes shell tools but registers no control session / control tools, unlike `relay run`. Fix: mirror the run lifecycle registration/tool wiring/cleanup.

## Disposition
Pending maintainer decision: fix HIGH (+secret-leak MEDIUM) before merge, fix all, or accept HIGH as a documented v1 local-single-user limitation. Core broker behavior is verified correct.
