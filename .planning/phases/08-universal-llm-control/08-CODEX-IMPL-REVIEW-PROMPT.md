# Codex Implementation Review — Relay Phase 8

You are an adversarial code reviewer. READ-ONLY: do not modify any file. The branch `phase-8-control` implements a universal LLM session-control layer + terminal Command Central. Review the IMPLEMENTATION (not the plans) for correctness and security.

## How to see the work
- Full diff: `git diff main...phase-8-control -- src/`
- Core files to scrutinize (security/correctness critical):
  - `src/control/broker.ts` — policy: human-allowed / llm-default-deny, grant TTL + message-budget, atomic budget decrement, normalized-content loop detection, redaction-before-persist, self-send block, self-approval denial, audit events.
  - `src/control/session-store.ts` — synchronous better-sqlite3 store; grant/budget atomicity (`incrementGrantUsage`), delivery status transitions, mailbox.
  - `src/control/tools.ts` — 6 LLM-facing tools; caller-session binding (spoof resistance), grant enforcement, `relay_control_request_grant` (must NOT auto-approve).
  - `src/control/adapters/*.ts` — capability honesty: adapters must not claim `live_stdin`/`resume_send` they can't deliver (claude-code/codex are ambient; generic-http is transcript-backed).
  - `src/control/pty-session.ts` — Relay-owned child_process; stdin/interrupt/stopped-state.
  - `src/control/read-model.ts` + `src/cli/command-central-view.ts` — bounded reads only, no unbounded SELECTs on the render path.

## Attack these specifically
1. Can an LLM send cross-session without a valid grant? Any path around default-deny?
2. Grant budget/TTL: race between check and atomic decrement — can budget be exceeded or a revoked/expired grant be used? Is the decrement+enqueue truly one transaction?
3. Loop detection: can ping-pong evade the normalized-hash + window check? Mutating-content loops?
4. Redaction: is secret redaction applied BEFORE content crosses a session boundary and before the audit hash? Can a caller supply their own content_hash/redaction to spoof?
5. Self-escalation: can a model approve its own grant request, or raise its own budget/authority via tools or the TUI palette? (D-14)
6. KNOWN FLAG from 08-03 — confirm or refute: a model with `shell_exec` can invoke the `relay` binary directly and self-grant as a "human" send, bypassing the broker's llm-policy. Is this real on this branch? Severity? Smallest mitigation?
7. Capability overclaim: any adapter reporting a delivery capability it cannot honor?
8. SQL injection / unsanitized interpolation in any store query.
9. better-sqlite3 misuse: any `await` on sync DB calls, any unbounded query on a hot path.
10. Secrets: any provider key logged, stored in SQLite, or crossing a session boundary?

## Output
First line exactly: `VERDICT: APPROVED` or `VERDICT: REVISE`.
Then findings ordered HIGH / MEDIUM / LOW, each citing file:line and the smallest fix. If APPROVED, still list residual risks.
