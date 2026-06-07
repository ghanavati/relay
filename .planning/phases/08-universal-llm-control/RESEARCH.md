# Phase 8: Universal LLM Control - Research

**Date:** 2026-06-07
**Status:** Complete enough for planning

## Core Finding

Universal bidirectional LLM control is feasible only if Relay becomes a session broker with adapter-specific capability reporting. It is not feasible as a single generic "send text to any running agent" primitive because each agent surface exposes different control points.

## Local Code Findings

### Relay Already Has Pieces Of The Fabric

- `src/workers/types.ts` already defines OpenAI-compatible tool declarations and tool-call messages.
- `src/workers/lmstudio-agentic.ts` already implements a Relay-owned tool loop with `shell_exec`, iteration counters, loop detection, and extra tool handlers.
- `src/cli/cmd-run.ts` already merges default agentic tools plus optional Figma tools before calling the LM Studio agentic worker.
- `src/cli/cmd-memory-ops.ts` already writes Claude Code SessionStart and SessionEnd hooks.
- `src/cli/cmd-context-emit.ts` already renders per-target context wrappers for `cc`, `codex`, `lmstudio-http`, and `lmstudio-cli`.

These pieces should not be replaced. The new work should add a control/session layer beside them and then integrate current workers/hooks as adapters.

### Missing Primitives

- No session registry for live or resumable LLM sessions.
- No cross-session message queue.
- No adapter capability taxonomy.
- No policy model for "which session may send to which other session".
- No delivery status model distinct from run status.
- No LLM-facing control tools.
- No CLI surface for `relay session list / inspect / tail / send`.
- No shared Command Central read model for TUI/JSON/tests.
- No operator console that can approve, deny, inspect, and audit model-driven control requests.

## External Surface Findings

### Claude Code

Claude Code hooks provide session metadata (`session_id`, `transcript_path`, `cwd`) and can add context during SessionStart. UserPromptSubmit can also add context alongside a submitted prompt. SessionEnd is cleanup-only. That means ambient Claude Code sessions can be registered and can receive mailbox messages at hook points, but hooks are not a general-purpose live stdin channel.

Claude Code's Agent SDK supports session continuation/resume/fork semantics. A Relay-managed Claude session can therefore be controlled more strongly through SDK calls, while an arbitrary existing interactive terminal session remains hook/mailbox-limited unless Relay launched and owns the process.

Sources:
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/agent-sdk/sessions

### Codex

Codex's current agent loop is built around the Responses API, local tools, MCP-provided tools, and layered instructions. This maps well to Relay control tools: Codex can call Relay through MCP and can receive Relay context through instructions/configuration. Strong live control of an interactive Codex process should be treated as adapter-specific and verified through a Relay-owned subprocess or a documented/resolved CLI resume path.

Source:
- https://openai.com/index/unrolling-the-codex-agent-loop/

### LM Studio

LM Studio exposes OpenAI-compatible tools through `/v1/chat/completions` and `/v1/responses`. Relay already has an in-process LM Studio tool loop, so LM Studio should be the first "strong" bidirectional adapter: Relay can add `relay_session_*` tools directly and store each turn as a Relay session event.

Source:
- https://lmstudio.ai/docs/developer/openai-compat/tools

### Herdr / Command Central Shape

Herdr's useful reference point is not a browser dashboard; it is a terminal-native control surface that keeps real terminal/process context visible while adding session/pane state, keyboard operations, and an API agents can drive. Relay should adapt that shape to LLM sessions: compact session rail, state rollups, selected-session event pane, inbox/grants queue, audit rail, and command palette.

The key architecture lesson is that the UI and model tools must drive the same operations. A human typing "send to Codex" and a model calling `relay_session_send` should produce the same broker event, policy decision, delivery attempt, and audit record.

Source:
- https://herdr.dev/

## Capability Taxonomy

Adapters should report capabilities instead of relying on provider names:

| Capability | Meaning |
|---|---|
| `register` | Adapter can create/update session records. |
| `observe` | Relay can read transcript/events for the session. |
| `tail` | Relay can stream new events. |
| `context_inject` | Relay can add context at a host-defined boundary. |
| `mailbox` | Relay can queue messages for later delivery. |
| `resume_send` | Relay can resume a stored session and send a prompt. |
| `live_stdin` | Relay can write to a running process it owns. |
| `interrupt` | Relay can cancel/interrupt execution. |
| `fork` | Relay can branch a session. |
| `spawn` | Relay can start a new session. |
| `tool_call` | The LLM can call Relay control tools. |

## Architecture Recommendation

Create a `src/control/` subsystem:

- `types.ts` - session, event, adapter, capability, policy, delivery types.
- `session-store.ts` - SQLite-backed registry/event/mailbox store.
- `adapter-registry.ts` - adapter lookup and capability routing.
- `broker.ts` - enqueue, deliver, acknowledge, fail, and loop-detect cross-session messages.
- `tools.ts` - LLM-facing tool definitions and handlers.
- `adapters/*` - provider-specific implementations.
- `read-model.ts` - bounded `ControlSnapshot` builder consumed by `relay tui`, `relay tui --json`, and tests.

## MVP Route

1. Build the store, broker, CLI, policy, and fake adapters first.
2. Add Claude Code hook registration plus mailbox delivery at SessionStart/UserPromptSubmit.
3. Add LM Studio agentic Relay control tools and in-process session events.
4. Add Codex MCP/control-tool integration and a verified subprocess/resume adapter.
5. Add Anthropic/OpenRouter transcript-backed sessions.
6. Add Relay-owned PTY wrapper for any CLI that can be launched from Relay.
7. Upgrade `relay tui` into Command Central using the broker-backed `ControlSnapshot`; expose model-driven operations as visible pending/approved/denied/executed events.

## Main Risks

- Overpromising live control for sessions Relay does not own.
- Infinite agent-to-agent loops.
- Cross-project data leakage through transcripts or memory.
- Confused-deputy failures where one LLM tricks another into using tools it cannot access directly.
- Provider API drift, especially CLI resume/control semantics.
- Large transcript growth without summarization or retention limits.
- TUI becoming a second control implementation if it writes around the broker.
- Models using UI-equivalent tools to self-grant authority or hide actions from the human operator.
- Dashboard latency if active sessions or provider probes run unbounded on the Ink render path.

## Design Constraint

The user-facing product copy must say "universal control fabric with adapter capabilities", not "every provider supports every operation." The command surface can be universal; the delivery semantics are adapter-specific and must be reported clearly.

Command Central must be described as the operational surface over the broker, not as a separate web UI. The model can control Command Central-equivalent operations only through Relay tools and broker policy, with explicit grants and audit-visible outcomes.
