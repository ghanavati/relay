# ~/.relay/config.json schema

This file is created by `relay init`. Edit it manually to set defaults.

## Full schema
```json
{
  "providers": {
    "default": "codex|lmstudio|openrouter|anthropic",
    "codex": { "model": "gpt-5.4", "reasoning_effort": "low|medium|high" },
    "lmstudio": { "model": "zai-org/glm-4.7-flash" },
    "openrouter": { "model": "anthropic/claude-opus-4-5" }
  },
  "memory": {
    "default_workdir": null
  }
}
```

## Field reference
| Path | Type | Default | Effect |
|---|---|---|---|
providers.default | string | "codex" | Default provider name |
providers.codex.model | string | "gpt-5.4" | Codex model identifier |
providers.codex.reasoning_effort | string | "low" | Codex reasoning effort level |
providers.lmstudio.model | string | "zai-org/glm-4.7-flash" | LM Studio model identifier |
providers.openrouter.model | string | "anthropic/claude-opus-4-5" | OpenRouter model identifier |
memory.default_workdir | string \| null | null | Default working directory for memory |

## Resolution order
1. CLI flag (`--provider`, `--model`)
2. Env var (e.g. `OPENROUTER_API_KEY`)
3. Config file value
4. Hardcoded default

## Examples
Minimal config (codex only):
```json
{ "providers": { "default": "codex" } }
```
LM Studio default with GLM:
```json
{ "providers": { "default": "lmstudio", "lmstudio": { "model": "zai-org/glm-4.7-flash" } } }
```