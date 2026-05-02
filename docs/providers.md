# Providers

Relay dispatches tasks to one of these workers:

| Provider | Type | Cost | Best for |
|---|---|---|---|
| codex | Subprocess (codex-cli 0.128+) | OpenAI usage | Agentic shell + tool use; default |
| lmstudio | HTTP (OpenAI-compatible) | $0 (local) | Parallel test generation, mechanical edits |
| openrouter | HTTP (chat-completions) | per-model API price | Frontier models for one-shot reasoning |

Note: Relay v0.1.0 dropped the Anthropic native worker (returns later when tool-use loop is reimplemented). For Claude tasks, route via OpenRouter using `--model anthropic/claude-...`.

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