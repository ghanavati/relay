# Phase 8: Universal LLM Control - Context

**Gathered:** 2026-06-07
**Status:** Ready for planning
**Source:** User requests: "control any llm to any llm ... any bidirectional llm control"; "dashboard and make the command central actually a command central"; "could a model then control the command central?"

<domain>
## Phase Boundary

Build Relay's first universal session-control layer: a local-first control bus where any supported LLM surface can register as a session, inspect peers, send messages to peers, receive queued messages, and expose its real control capabilities without pretending every provider supports live stdin injection.

This phase turns Relay from "memory plus worker dispatch" into an agent-control fabric with a real terminal-native Command Central. It must support bidirectional control among Claude Code, Codex CLI, Relay-native LM Studio tool loops, OpenRouter, Anthropic, and future adapters, while giving humans and permitted models one shared command surface.

</domain>

<executor_compatibility>
## Runtime-Neutral Execution

Phase 8 plans must be executable by both Claude Code and Codex. Do not encode Claude-only assumptions into the plans. Claude Code may use its native Task and AskUserQuestion surfaces; Codex must translate those to `multi_agent_v1.spawn_agent` when explicitly permitted, `apply_patch` for edits, `update_plan` for tracking, and plain-text checkpoints. The shared contract is `.planning/phases/08-universal-llm-control/EXECUTOR-COMPATIBILITY.md`.

</executor_compatibility>

<decisions>
## Implementation Decisions

### Control Truth
- **D-01:** Relay must model capabilities explicitly. "Can receive queued context on next prompt" is not the same as "can receive live input while running"; every adapter reports a capability set and commands refuse unsupported operations instead of silently degrading.
- **D-02:** Strong live control requires either a provider session API or a process launched and owned by Relay through PTY/stdin; ambient sessions not launched by Relay can still be observed and messaged through hooks or mailbox delivery when the host supports those mechanisms.

### Bidirectional Agent Flow
- **D-03:** LLM-to-LLM control is implemented as tools plus message bus, not as models directly writing to each other's terminals; a model may call Relay tools such as `relay_session_send` only when its session has an explicit grant to target another session.

### Safety
- **D-04:** Default policy is deny for LLM-initiated cross-session sends; user-initiated sends can target any registered session if the target adapter supports a delivery capability; agent-initiated sends require a grant, TTL, max-message budget, and loop detection.
- **D-05:** Every cross-session message is audited in SQLite with source, target, content hash, status, delivery attempts, and redaction metadata.
- **D-06:** Secrets and private transcript content must be redacted before crossing session boundaries.

### Provider Surface
- **D-07:** Claude Code has hook-based context delivery for ambient sessions and SDK resume/fork semantics for Relay-managed sessions.
- **D-08:** LM Studio agentic sessions are Relay-native and can support strong in-process control.
- **D-09:** Codex can be integrated through MCP/instructions and, for strong live control, through Relay-owned subprocess or any stable CLI resume path that is verified during implementation.
- **D-10:** OpenRouter and Anthropic direct API sessions are stored transcripts managed by Relay; they are controllable as Relay sessions even if the provider API is stateless.

### Command Central
- **D-11:** Command Central is a terminal-native Ink surface over the control broker, not a separate browser dashboard or a second control implementation.
- **D-12:** The TUI reads a shared `ControlSnapshot` read model that is also emitted by `relay tui --json`; UI code must not add direct SQL paths that bypass existing CLI/control helpers.
- **D-13:** Human UI actions and LLM tool actions use the same broker methods, policy checks, grants, loop detection, and audit events.
- **D-14:** Model-driven Command Central is allowed only as broker-mediated tool calls with visible requested, approved, denied, and executed states; models must not approve their own grants or silently raise their own authority.
- **D-15:** The visual/interaction model should be Herdr-inspired: compact terminal panes, workspace/session rail, state rollups, keyboard-first command palette, and operational controls instead of a passive marketing dashboard.

</decisions>

<canonical_refs>
## Code References

- `src/cli.ts` - command parser and help surface.
- `src/cli/cmd-run.ts` - current worker dispatch and LM Studio agentic tool registration.
- `src/workers/types.ts` - WorkerTask, WorkerResult, ToolDef, ToolCallMessage.
- `src/workers/lmstudio-agentic.ts` - current in-process tool loop pattern.
- `src/runtime/store/db.ts` - SQLite schema and migration pattern.
- `src/runtime/store/run-store.ts` - run/event persistence pattern.
- `src/cli/cmd-memory-ops.ts` - Claude Code hook install pattern.
- `src/cli/cmd-context-emit.ts` - target-specific context wrapper pattern.
- `src/cli/cmd-tui.ts` - current Ink snapshot dashboard to upgrade into Command Central.
- `src/cli/cmd-tui.test.ts` - existing TUI snapshot tests to extend.
- `docs/commands.md` - command reference to update.
- `README.md` - product surface and status copy to update.

## External References To Verify During Implementation

- Claude Code hooks: https://code.claude.com/docs/en/hooks
- Claude Code sessions: https://code.claude.com/docs/en/agent-sdk/sessions
- LM Studio tool use: https://lmstudio.ai/docs/developer/openai-compat/tools
- OpenAI Codex agent loop: https://openai.com/index/unrolling-the-codex-agent-loop/
- Herdr terminal control-surface reference: https://herdr.dev/

</canonical_refs>

<non_goals>
## Out Of Scope

- Hosted multi-tenant Relay service.
- Hosted browser/desktop UI for supervising sessions; Phase 8 Command Central is terminal-native Ink.
- Guaranteed live injection into arbitrary already-running third-party CLI sessions that Relay did not launch and that expose no session API.
- Letting one LLM bypass Relay policy to execute another LLM's tools directly.
- Letting models grant themselves new authority, approve destructive actions, or bypass budgets/loop detection through UI automation.
- Hardcoded model IDs or provider-specific defaults.
- Control-event retention/summarization — deferred until `control_events` growth is measured in real use; revisit in a later phase.

</non_goals>
