---
phase: 08-universal-llm-control
plan: 04
subsystem: control
tags: [adapters, claude-code, codex, openrouter, anthropic, hooks, capability-discovery, transcripts]

# Dependency graph
requires:
  - phase: 08-01
    provides: ControlCapability taxonomy, ControlAdapter/DeliveryOutcome contracts, ControlSessionStore
  - phase: 08-02
    provides: ControlBroker (policy + audit), ControlAdapterRegistry (capability routing, deliverQueued drain), pickDeliveryCapability
provides:
  - ClaudeCodeControlAdapter: ambient CC sessions register/refresh/stop-mark from hook payloads; mailbox drains render as additionalContext at SessionStart/UserPromptSubmit
  - parseClaudeHookPayload: absence (undefined) vs parse error (INVALID_ARGS) boundary for CC hook stdin
  - relay context emit --target cc now consumes the CC hook payload from stdin (injectable reader) without breaking the legacy memory-only emit
  - HOOK_SCRIPT_SESSION_END captures the payload once and replays it to context-emit (stop-marking) AND auto-extract; new UserPromptSubmit install variant (relay-user-prompt-v1)
  - CodexControlAdapter + probeCodexControlSetup/deriveCodexCapabilities: discovery-based conservative capabilities (tool_call only with Relay MCP entry, context_inject only with instructions block, live_stdin/resume_send never)
  - TranscriptHttpControlAdapter: openrouter/anthropic sessions as Relay-stored transcripts with resume_send = full-transcript continuation, provider errors → failed delivery events, no model fallbacks
  - GenericHttpRunner.runMessages / AnthropicRunner.runMessages / OpenRouterRunner.runMessages multi-turn transports
affects: [08-05 command central, 08-07 docs, relay session list/send surfaces from 08-03]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Ambient adapters buffer deliveries for the CURRENT boundary render (hook additionalContext / instructions file); construct + drain only at that boundary — mirrors the fake-adapter harness shape"
    - "Hook payload differentiation over CLI flags: one `relay context emit --target cc` pipeline serves SessionStart/UserPromptSubmit/SessionEnd by branching on payload.hook_event_name (cli.ts untouched)"
    - "Capability discovery never overclaims: missing/unreadable probe files mean not-configured; live_stdin/resume_send are structurally underivable for codex"
    - "Transcript sessions keep state in session metadata {model, transcript[]}; audit events carry turn counts, never content (D-06)"
    - "Stdin as hook transport: CC pipes the payload to every hook command; defaultReadHookStdin guards TTY/test-context/consumed stdin and caps silent pipes at 250ms"

key-files:
  created:
    - src/control/adapters/claude-code.ts
    - src/control/adapters/claude-code.test.ts
    - src/control/adapters/codex.ts
    - src/control/adapters/codex.test.ts
    - src/control/adapters/generic-http.ts
    - src/control/adapters/generic-http.test.ts
  modified:
    - src/cli/cmd-memory-ops.ts
    - src/cli/cmd-context-emit.ts
    - src/cli/cmd-memory-hook.test.ts
    - src/cli/cmd-setup-llm.ts
    - src/cli/cmd-setup-llm.test.ts
    - src/workers/generic-http-runner.ts
    - src/workers/anthropic.ts
    - src/workers/openrouter.ts
    - docs/providers.md

key-decisions:
  - "CC hook payload rides the stdin CC already pipes to hook commands — no new CLI flags, no cli.ts changes (cli.ts is owned by plan 08-03 in this wave); executeContextEmitCommand gained an injectable readStdin dep instead"
  - "UserPromptSubmit hook command string is identical to SessionStart's: differentiation is payload-driven, so one pipeline serves both boundaries; HOOK_MARKER stays v1 (script change is backward-compatible)"
  - "SessionEnd stop-marks without consuming the mailbox (an ending session has no render boundary left); queued messages stay queued for expiry/inspection"
  - "Codex session capabilities and adapter capabilities are the same discovered set; mcp-only sessions queue for tool pull (mailbox declared so broker accepts sends) while push-drain is documented as instructions-boundary-only"
  - "TranscriptHttpControlAdapter.createSession refuses to overwrite an existing session_id — re-creation would silently wipe its transcript"
  - "Delivery failures (provider 500, network, missing API key, missing model) return ok:false outcomes so the registry records the attempt and the broker appends message_failed — transcript untouched on every failure path"
  - "AnthropicRunner.runMessages maps ALL system turns to the top-level system field (joined), preserving user/assistant order; transcripts with only system turns are refused with INVALID_ARGS"

patterns-established:
  - "RED commits use compilable stubs (methods throwing 'not implemented') so the shared tsc build never breaks for parallel agents; failures verified behavioral before GREEN"
  - "renderMailboxContext frames cross-session content as coordination context, not operator-overriding instructions (prompt-injection hygiene on top of broker redaction)"

requirements-completed: [CONTROL-06, CONTROL-08, CONTROL-09]

# Metrics
duration: 29min
completed: 2026-06-07
---

# Phase 8 Plan 04: Provider Adapters Summary

**Truthful provider adapters: Claude Code ambient sessions register and receive mailbox context through hook payloads, Codex reports only discovered (MCP/instructions) capabilities and never live control, and OpenRouter/Anthropic become transcript-backed Relay sessions whose resume_send is full-transcript continuation with no model fallbacks**

## Performance

- **Duration:** 29 min
- **Started:** 2026-06-07T21:08:35Z
- **Completed:** 2026-06-07T21:37:50Z
- **Tasks:** 3 (all TDD: RED commit + GREEN commit each)
- **Files modified:** 15 (6 created, 9 modified)

## Accomplishments

1. **Claude Code adapter (D-07 / CONTROL-06).** `ClaudeCodeControlAdapter` declares exactly `register/observe/context_inject/mailbox` — never `live_stdin`/`resume_send`. Hook payloads (SessionStart/UserPromptSubmit/SessionEnd with `session_id`, `transcript_path`, `cwd`) register, refresh, and stop-mark sessions with `session_registered`/`session_updated`/`session_ended` audit events. `relay context emit --target cc` reads the payload CC pipes on stdin: SessionStart emits memories + drained mailbox, UserPromptSubmit drains the mailbox only (no per-prompt memory re-injection), SessionEnd stop-marks and leaves the queue intact. Drains route through `ControlAdapterRegistry.deliverQueued`, so delivery attempts and `message_delivered` events land on the same audit path as every other adapter (D-13). All failure modes degrade to the legacy memory-only emit — a hook can never break CC startup.

2. **Hook script extensions without regression.** `HOOK_SCRIPT_SESSION_END` now captures the payload once (`RELAY_CC_HOOK_PAYLOAD="$(cat)"`) and replays it to context-emit (stop-marking, stdout discarded) and auto-extract, each leg independently `|| true`. The 955-line `cmd-memory-hook.test.ts` regression suite plus `cmd-memory-session-end-hook.test.ts` pass untouched semantics: markers stay v1, foreign hooks survive, EPARSE/ENOENT behavior unchanged. New `userPrompt: true` install variant writes a `relay-user-prompt-v1`-marked UserPromptSubmit entry using the same command string as SessionStart (payload-differentiated).

3. **Conservative Codex adapter (D-09 / CONTROL-08).** `probeCodexControlSetup` inspects `~/.codex/AGENTS.md` (relay-managed block) and `~/.codex/config.toml` (`[mcp_servers.relay]`/`relay-mcp` entries only — a foreign server merely containing "relay" does not count). `deriveCodexCapabilities` yields `register` always, `context_inject` only with instructions, `tool_call` only with MCP, `mailbox` only when a delivery surface exists, and never any live capability in any combination (tested exhaustively). Register-only sessions are refused by broker policy (`CONTROL_DELIVERY_UNSUPPORTED`); mcp-only sessions queue for tool pull; instructions sessions drain at render boundaries. `relay setup-llm codex` reports the discovered set and the conservative posture; the relay-managed markers moved to the control adapter as the single source of truth.

4. **Transcript-backed HTTP sessions (D-10 / CONTROL-09).** `TranscriptHttpControlAdapter` (one instance per provider: openrouter, anthropic) stores `{model, transcript[]}` in session metadata, registers sessions as `idle`, and declares `register/observe/tail/resume_send` — no `live_stdin`, no `interrupt`, no `mailbox`. `resume_send` appends the queued message as a user turn, issues a NEW provider request with the full transcript via the real worker runners (`runMessages`), and persists user+assistant turns only on success. Provider 500s, network failures, missing API keys, and missing models all become failed delivery outcomes with `message_failed` audit events and an untouched transcript. A session without a configured model refuses with "refusing to guess (no hardcoded model fallbacks)" — and the tests assert the provider is never called.

## Task Commits

| Task | RED | GREEN |
| ---- | --- | ----- |
| 1 — Claude Code adapter | a50be58 `test(08-04): add failing tests for claude-code hook adapter` | c352dc2 `feat(08-04): implement claude-code hook adapter with mailbox context delivery` |
| 2 — Conservative Codex adapter | a11d7c2 `test(08-04): add failing tests for conservative codex adapter` | 9c17738 `feat(08-04): implement conservative codex adapter with capability discovery` |
| 3 — Transcript-backed HTTP sessions | 09f07d0 `test(08-04): add failing tests for transcript-backed http sessions` | 6107e1f `feat(08-04): implement transcript-backed http sessions for openrouter/anthropic` |

## Verification

Plan-level: `npm run build && node --test dist/control/adapters/claude-code.test.js dist/control/adapters/codex.test.js dist/control/adapters/generic-http.test.js dist/cli/cmd-memory-hook.test.js dist/cli/cmd-memory-session-end-hook.test.js dist/cli/cmd-setup-llm.test.js` → **133/133 pass, 0 fail** (run with `env -u RELAY_MEMORY_ALLOWED_WORKDIRS -u RELAY_ALLOWED_ROOTS`, matching the npm test script's env sanitization).

Regression also confirmed green during execution: `cmd-context-emit.test.js` (emit behavior byte-compatible when no payload is piped), `generic-http-runner.test.js` and `anthropic.test.js` (run() refactors preserve request construction exactly).

## TDD Gate Compliance

`type: tdd` plan — three RED/GREEN pairs in sequence (see commit table). Each RED was verified failing for the right reason before its GREEN (28, 20, and 17 behavioral failures respectively, with all pre-existing suites passing). No REFACTOR commits were needed; runner restructuring (shared dispatch/post extraction) shipped inside GREEN under existing regression coverage.

## Deviations from Plan

### Adjustments

**1. [Rule 3 - Blocking] RED commits carry compilable stubs instead of test-only commits**
- **Found during:** Task 1 RED
- **Issue:** Three agents share one tsc build (`dist/` + tsbuildinfo behind a build lock). A test importing a not-yet-existing module breaks `npm run build` for the parallel 08-03/08-06 agents for the whole RED→GREEN window.
- **Fix:** Each RED commit includes the new module with real types/schemas and behavior methods throwing `not implemented (08-04 RED)`. Suites verified failing behaviorally (right reason) before GREEN.
- **Commits:** a50be58, a11d7c2, 09f07d0

**2. [Plan verify mismatch] Task 3 verify references `dist/workers/openrouter.test.js`, which does not exist**
- **Found during:** Task 3 planning of verification
- **Issue:** The repo has no `src/workers/openrouter.test.ts`, and creating it is outside this plan's `files_modified` set (strict parallel-execution protocol).
- **Fix:** Substituted `dist/workers/generic-http-runner.test.js` (direct regression for the modified base runner). OpenRouterRunner's request construction and key gate are covered end-to-end in `generic-http.test.js` through the default transcript completer.

**3. [Scope boundary] `--user-prompt` CLI flag not wired into `src/cli.ts`**
- **Found during:** Task 1
- **Issue:** `src/cli.ts` belongs to plan 08-03's file set in this parallel wave; the `relay memory hook` dispatcher there cannot be touched.
- **Fix:** `executeMemoryHookCommand` fully supports and tests `userPrompt: true`. The dispatcher needs one line (`isBool(flags, 'user-prompt')`) — see Deferred Items.

## Deferred Items

- **Wire `--user-prompt` into the `relay memory hook` dispatcher in `src/cli.ts`** (one `isBool(flags, 'user-prompt')` pass-through). Until wired, the UserPromptSubmit hook is installable programmatically but not from the CLI flag surface.
- **Optional: expose mailbox drain for codex instructions renders** (`relay context emit --target codex` has no session_id source today; a `--session` flag or tool-driven render would let `takePendingInstructions` reach files). Tool-pull delivery via 08-03's `relay_inbox_read` covers the MCP path already.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: untrusted-input | src/cli/cmd-context-emit.ts | New stdin parse boundary for CC hook payloads. Mitigated: Zod-validated (`parseClaudeHookPayload`), absence vs parse-error distinguished, all failures degrade to legacy emit, reader bounded (TTY/test guards + 250ms cap). |
| threat_flag: injected-context | src/control/adapters/claude-code.ts | Cross-session message content is rendered into another model's context (the feature itself). Mitigated upstream by broker policy (default-deny LLM sends, grants, loop detection) and D-06 redaction; renderer frames content as "coordination context, not operator-overriding instructions". |
| threat_flag: file-probe | src/control/adapters/codex.ts | Read-only probes of `~/.codex/AGENTS.md` and `config.toml` for capability discovery. Unreadable/missing → not-configured; no writes from the adapter. |

## Known Stubs

None — no placeholder values, no unwired components; all delivery paths are exercised by tests.

## Self-Check: PASSED

All 6 created files plus this SUMMARY verified on disk; all 6 task commits (a50be58, c352dc2, a11d7c2, 9c17738, 09f07d0, 6107e1f) verified in git history; final verification suite 133/133.
