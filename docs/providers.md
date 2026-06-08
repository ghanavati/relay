# Providers

Relay dispatches tasks to one of these workers:

| Provider | Type | Cost | Best for |
|---|---|---|---|
| codex | Subprocess (codex-cli 0.128+) | OpenAI usage | Agentic shell + tool use; default |
| lmstudio | HTTP (OpenAI-compatible) | $0 (local) | Parallel test generation, mechanical edits |
| openrouter | HTTP (chat-completions) | per-model API price | Frontier models for one-shot reasoning |

Anthropic native worker shipped in v0.1.0 as a slim Messages API client (text-only, no tool-use loop). For agentic Claude with tool-use, route via OpenRouter using `--model anthropic/claude-...`.

## Codex setup

1. Install codex CLI: `npm i -g @openai/codex` (requires `codex login` afterwards).
2. Verify: `codex --version` (must be >= 0.128.0).
3. Optional: `RELAY_CODEX_NETWORK_MODE=dangerous` skips approval flow (recommended for solo).
4. Models: `gpt-5.4`, `gpt-5.3-codex`, `gpt-5.2-codex`, etc. — see Codex docs.
5. Limit: account-level token quota — `relay doctor` flags when limit hits.

Dispatch:
```bash
relay run 'fix the failing test' --provider codex --model gpt-5.3-codex
```

## LM Studio setup

1. Install LM Studio app: https://lmstudio.ai
2. Load a model via the Models tab. Recommended models:
   - `zai-org/glm-4.7-flash` — 16-lane parallel, fastest, schema work
   - `qwen/qwen3.6-35b-a3b` — 8-lane, stronger reasoning
3. Start LM Studio's local server (default `http://localhost:1234`).
4. Verify: `curl http://localhost:1234/v1/models`.
5. Set in env (optional): `LMSTUDIO_ENDPOINT=http://localhost:1234` (default), `LMSTUDIO_API_KEY` (only if behind proxy).

Dispatch:
```bash
relay run 'write tests for src/foo.ts' --provider lmstudio --model zai-org/glm-4.7-flash
```

## OpenRouter setup

1. Sign up at https://openrouter.ai, get an API key.
2. Set env: `export OPENROUTER_API_KEY=sk-or-...`
3. Browse models: https://openrouter.ai/models. Solo-friendly picks: `anthropic/claude-opus-4-5`, `deepseek/deepseek-r1`, `google/gemini-2.5-flash`.
4. Per-request billing — set a budget cap with `relay budget set openrouter 10` (USD).

Dispatch:
```bash
relay run 'analyze this codebase for SQL injection risk' --provider openrouter --model anthropic/claude-opus-4-5
```

## Session control capabilities

Relay's control layer (Phase 8) reports per-provider session capabilities explicitly. The command surface is universal; delivery semantics are adapter-specific and never overclaimed — commands refuse unsupported operations instead of silently degrading.

| Provider | Capabilities | Delivery semantics |
|---|---|---|
| claude-code | register, observe, context_inject, mailbox | Ambient sessions register via CC hooks (SessionStart/UserPromptSubmit/SessionEnd). Queued messages render as `additionalContext` at the next hook boundary. No live stdin — hooks are not an input channel. |
| codex | register (+context_inject, mailbox with instructions block; +tool_call, mailbox with Relay MCP entry) | Conservative, discovery-based. `relay setup-llm codex` reports what is currently discoverable. Messages ride along with instructions renders or wait for MCP tool pull. |
| lmstudio | Relay-native tool loop | Relay owns the process — strong in-process control through agentic tool handlers. |
| openrouter | register, observe, tail, resume_send | Transcript-backed Relay session. `resume_send` = append to the stored transcript and make a new provider request. The provider API is stateless; the session state lives in Relay. |
| anthropic | register, observe, tail, resume_send | Same transcript-backed semantics as openrouter, against the Anthropic Messages API. |
| Relay-owned process | register, observe, tail, mailbox, live_stdin, interrupt | Launched by `relay session spawn --provider <name> <command...>`. Relay owns the pipes: line-based stdin writes (`live_stdin`), SIGINT interrupt, and stdout/stderr tailed as control events. This is the one path with real live control. Full-TTY CLIs (claude, codex) detect non-TTY stdio and change behavior, so a spawned claude/codex reports `live_stdin` absent — observe and interrupt still apply. |

Strong (live) control is exclusive to Relay-owned processes — the sessions you start with `relay session spawn`. Every other adapter is observe + queued/transcript delivery; none of them get a live stdin channel.

What Relay never claims:

- `live_stdin` into Claude Code or Codex sessions Relay did not launch. Full-TTY CLIs are out of live-injection scope in v1; the capability is reported truthfully absent.
- Provider-native session resume for OpenRouter/Anthropic — `resume_send` there means Relay-transcript continuation, not provider-side live state.
- Any hardcoded model fallback: transcript sessions refuse to send when no model is configured rather than guessing.

## Routing rules (when to use which)

| Task | Provider |
|---|---|
| Pattern repetition across ≥ 2 files | LM Studio (GLM if schema, Qwen if logic) |
| Single-file complex reasoning | Codex |
| Cross-file architectural critique | OpenRouter (claude opus or deepseek-r1) |
| Cost-sensitive bulk work | LM Studio |
| Time-sensitive frontier reasoning | OpenRouter |

## Health check

```bash
relay doctor
```
Probes each provider, reports auth status, latency, available models.