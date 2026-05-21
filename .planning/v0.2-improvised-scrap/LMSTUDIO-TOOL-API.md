# LM Studio Tool-Calling HTTP API — Research for Relay v0.2 Agentic Runner

**Researched:** 2026-05-18
**Domain:** LM Studio OpenAI-compatible `/v1/chat/completions` tool calling
**Confidence:** HIGH (primary doc + changelog verified); MEDIUM on model-specific reliability
**Server default:** `http://localhost:1234/v1` — start with `lms server start` [CITED: lmstudio.ai/docs/api/openai-api]

## Summary

LM Studio implements the OpenAI Chat Completions tool-calling spec at `/v1/chat/completions` with full request/response symmetry: pass `tools[]`, the model emits `choices[0].message.tool_calls[]` with `finish_reason: "tool_calls"`, you append a `{role:"tool", tool_call_id, content}` message, repeat until `finish_reason: "stop"`. `tool_choice` accepts `"auto"`, `"none"`, `"required"` (last is llama.cpp-only, since v0.3.15). Streaming works — `tool_calls` arrive chunked across deltas and must be accumulated. [CITED: lmstudio.ai/docs/developer/openai-compat/tools, lmstudio.ai/docs/developer/api-changelog]

**Primary recommendation for Relay v0.2:** Build the agentic loop against the standard OpenAI Chat Completions schema (not the newer `/v1/responses` endpoint added in 0.3.29). Use `qwen/qwen3-coder-next` as default driver — it has native tool training and is the only loaded 80B-class MoE built for agentic coding. Set max iterations to **20** as a safety ceiling, with early-exit on `finish_reason == "stop"`. Treat `qwen3-vl-32b-thinking-mlx` as a fallback for vision/Figma tasks.

## Loaded Model Tool-Use Capability

Verified against `lms ls` output and upstream model cards.

| Model (as loaded) | Family | Native Tool Use | Confidence | Notes |
|---|---|---|---|---|
| `qwen/qwen3-coder-next` (80B-A3B) | Qwen3-Coder | **YES** | HIGH | Released Feb 2026; native API tool-call interface, designed for agentic coding (Cline, Qwen Code, Claude Code). Recommended default. [CITED: huggingface.co/Qwen/Qwen3-Coder-Next] |
| `qwen/qwen3.6-35b-a3b` | Qwen3.x MoE | **YES** | HIGH | Qwen3 line has documented function-calling support via the family's standard tool-call format. [CITED: qwen.readthedocs.io/en/latest/framework/function_call.html] |
| `zai-org/glm-4.7-flash` | GLM-4.7 | **YES** | HIGH | GLM-4.7 natively supports OpenAI-style tool descriptions; improved on τ²-Bench over 4.6. [CITED: huggingface.co/zai-org/GLM-4.7] |
| `google/gemma-4-31b` | Gemma 4 | **YES** | MEDIUM | Native tool protocol with `<\|tool_call\|>` special tokens. **CAVEAT:** MLX parser bugs have left `tool_calls` field empty in some setups — verify against this specific build before relying on it. [CITED: github.com/ml-explore/mlx-lm/issues/1096, ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4] |
| `qwen3-vl-32b-thinking-mlx` | Qwen3-VL | **LIKELY** | MEDIUM | Qwen3 family supports tools; VL variant primarily intended for vision+reasoning. Best reserved for Figma/screenshot inputs, not pure tool loops. [ASSUMED — based on Qwen3 family baseline] |
| `liquid/lfm2-24b-a2b` | LFM2 MoE | **YES** | HIGH | Marketed as "tool-calling agents on consumer hardware"; defaults to Pythonic call format — **must add "Output function calls as JSON" to system prompt** for OpenAI-compat shape. [CITED: docs.liquid.ai/lfm/key-concepts/tool-use, liquid.ai/blog/no-cloud-tool-calling-agents-consumer-hardware-lfm2-24b-a2b] |

**LM Studio capability signal:** Models with native support carry a `"capabilities": ["tool_use"]` array on the `/api/v0/models` endpoint (added v0.3.16) and a hammer badge in-app. Programmatically check this before routing a tool-using request to a given model. [CITED: lmstudio.ai/docs/developer/api-changelog]

**Default-tool-use fallback:** Models without native training still work — LM Studio wraps them with a custom prompt/parser. Reliability is lower; expect malformed JSON args more often. [CITED: lmstudio.ai/docs/developer/openai-compat/tools]

## HTTP Shape — Initial Request

```http
POST http://localhost:1234/v1/chat/completions
Content-Type: application/json
```

```json
{
  "model": "qwen/qwen3-coder-next",
  "messages": [
    {"role": "system", "content": "You are a coding agent. Use tools when needed."},
    {"role": "user", "content": "What dell products are under $50?"}
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "search_products",
        "description": "Search product catalog by criteria",
        "parameters": {
          "type": "object",
          "properties": {
            "query":     {"type": "string"},
            "category":  {"type": "string", "enum": ["electronics","clothing","home","outdoor"]},
            "max_price": {"type": "number"}
          },
          "required": ["query"],
          "additionalProperties": false
        }
      }
    }
  ],
  "tool_choice": "auto",
  "temperature": 0.2,
  "stream": false
}
```

## `tool_choice` Semantics

| Value | Behavior | Notes |
|---|---|---|
| `"auto"` (default) | Model decides whether to call a tool or reply directly | Use for normal agent loops |
| `"none"` | Forbids tool calls; model must reply with text | Useful for "final answer" turn |
| `"required"` | Model MUST emit at least one tool call | **llama.cpp engine only** — MLX may not honor it [CITED: lmstudio.ai/docs/developer/api-changelog v0.3.15] |
| `{"type":"function","function":{"name":"X"}}` | Force call to tool `X` | OpenAI-standard named-tool form; LM Studio docs do not explicitly enumerate this, but the OpenAI SDK passes it through and LM Studio's "follows OpenAI's API semantics" wording covers it. [ASSUMED — test with target model before relying] |

## HTTP Shape — Response with `tool_calls`

```json
{
  "id": "chatcmpl-gb1t1uqzefudice8ntxd9i",
  "object": "chat.completion",
  "created": 1730913210,
  "model": "qwen/qwen3-coder-next",
  "choices": [
    {
      "index": 0,
      "finish_reason": "tool_calls",
      "message": {
        "role": "assistant",
        "tool_calls": [
          {
            "id": "365174485",
            "type": "function",
            "function": {
              "name": "search_products",
              "arguments": "{\"query\":\"dell\",\"category\":\"electronics\",\"max_price\":50}"
            }
          }
        ]
      }
    }
  ],
  "usage": {"prompt_tokens": 263, "completion_tokens": 34, "total_tokens": 297}
}
```

**Critical field notes** [CITED: lmstudio.ai/docs/developer/openai-compat/tools]:
- `finish_reason == "tool_calls"` is the gate: loop again. `"stop"` means done.
- `tool_calls[].id` — opaque string, **MUST be echoed back** in the tool result message. LM Studio uses arbitrary numeric strings (e.g. `"365174485"`), not OpenAI-style `call_*`.
- `function.arguments` is a **JSON-encoded string**, not a parsed object. Always `JSON.parse` before executing — and wrap in try/catch (see error modes).
- `message.content` is typically absent/null when `tool_calls` is present, but the model MAY include both text + tool_calls — handle both.
- Parallel tool calls: `tool_calls[]` may contain multiple entries in one turn. Execute all, append all results before next turn.

## HTTP Shape — Follow-up Turn (Append Tool Result)

```json
{
  "model": "qwen/qwen3-coder-next",
  "messages": [
    {"role": "system", "content": "You are a coding agent. Use tools when needed."},
    {"role": "user", "content": "What dell products are under $50?"},
    {
      "role": "assistant",
      "tool_calls": [
        {
          "id": "365174485",
          "type": "function",
          "function": {
            "name": "search_products",
            "arguments": "{\"query\":\"dell\",\"category\":\"electronics\",\"max_price\":50}"
          }
        }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "365174485",
      "content": "[{\"name\":\"Dell Mouse MS116\",\"price\":12.99},{\"name\":\"Dell Keyboard KB216\",\"price\":24.49}]"
    }
  ],
  "tools": [ /* same tools array — keep passing every turn */ ],
  "tool_choice": "auto"
}
```

**Tool result message — required fields** [CITED: lmstudio.ai/docs/developer/openai-compat/tools]:
- `role: "tool"` (literal)
- `tool_call_id` — must match `tool_calls[].id` from the prior assistant turn exactly
- `content` — **string only** (stringify objects/arrays before sending)
- One tool message per tool call. If the assistant emitted 3 calls in parallel, append 3 tool messages before the next request.

## HTTP Shape — Final Answer Turn

After the tool result is appended and you POST again, the model typically returns:

```json
{
  "id": "chatcmpl-final",
  "object": "chat.completion",
  "created": 1730913215,
  "model": "qwen/qwen3-coder-next",
  "choices": [
    {
      "index": 0,
      "finish_reason": "stop",
      "message": {
        "role": "assistant",
        "content": "I found 2 Dell products under $50: the MS116 mouse ($12.99) and the KB216 keyboard ($24.49)."
      }
    }
  ],
  "usage": {"prompt_tokens": 312, "completion_tokens": 41, "total_tokens": 353}
}
```

`finish_reason: "stop"` → exit the agentic loop.

## Streaming Behavior (`stream: true`)

**Tool calls work with streaming** but require accumulation logic [CITED: lmstudio.ai/docs/developer/openai-compat/tools, lmstudio.ai/docs/developer/api-changelog v0.3.17, v0.3.18, v0.3.19].

- Each SSE chunk has `chunk.choices[0].delta.tool_calls[]`
- `function.name` arrives in the first chunk (usually whole)
- `function.arguments` arrives as **JSON fragments across many chunks** — concatenate them, then `JSON.parse` once `finish_reason` arrives
- The chunk carrying `finish_reason: "tool_calls"` is the signal to dispatch
- **Parallel tool calls** in stream: each `delta.tool_calls[]` entry has an `index` field — accumulate by index, not by array position (v0.3.18 fixed dropped chunks for parallel calls)
- v0.3.17 onward streams argument tokens as generated, so partial JSON is observable mid-stream — don't try to parse before completion

For Relay v0.2 first cut, **disable streaming** (`stream: false`) — simpler accumulation, no UX cost until you wire incremental rendering.

## Max Iterations Rationale

ROADMAP suggests 20. Empirical guidance for the target workloads:

| Task class | Typical tool-call turns | Recommended ceiling |
|---|---|---|
| Single-file code edit | 2–5 (read → edit → verify) | 10 |
| Multi-file refactor | 8–15 (read N → analyze → edit N → test) | 20 |
| Figma → code translation | 5–12 (fetch design → query nodes → emit components) | 20 |
| Open-ended agentic debug | 15–40+ | 30 with hard timeout |

**20 is a reasonable default ceiling.** Rationale:
- Most successful agent runs in Cline / Claude Code complete inside 15 turns
- Beyond ~25 turns without progress strongly correlates with loops (model repeats the same tool call with same args)
- An 80B model at ~3B active params (qwen3-coder-next) takes ~5–15s per turn on Apple Silicon → 20 turns ≈ 2–5 minutes wall-clock, acceptable for an interactive coding agent

**Add a loop-detector**, not just a counter: if the same `(function.name, function.arguments)` tuple repeats 3 times consecutively, terminate with a "stuck in loop" error. This catches the failure mode the counter misses. [ASSUMED — pattern from Cline/Aider, not from LM Studio docs]

## Error Modes

| Failure | How it surfaces | Mitigation |
|---|---|---|
| **Malformed `tool_calls` JSON** | LM Studio can't parse model output → falls back to `message.content` with raw text instead of populating `tool_calls`. `finish_reason` will be `"stop"`, not `"tool_calls"`. [CITED: lmstudio.ai/docs/developer/openai-compat/tools] | Detect: if `content` contains tool-call-looking patterns but `tool_calls` is empty, log and retry with stricter system prompt. |
| **Invalid arguments JSON inside well-formed tool_calls** | `function.arguments` is a string that fails `JSON.parse` | Wrap parse in try/catch; on failure, append a tool message with `content: "ERROR: arguments not valid JSON"` and `tool_call_id` matching — let model self-correct. |
| **Tool execution throws** | Your concern, not LM Studio's | Append tool result message with error text: `{"error":"<message>","stack":"<trimmed>"}` — most tool-trained models will reason about the error and retry or change approach. |
| **Model loops** (same call, same args, repeated) | Counter alone won't catch fast loops; budget burns | Hash `(name + sorted args)`; if 3 consecutive matches, abort. |
| **Qwen3-Coder 30B drops `<tool_call>` tag** after text response | `tool_calls` empty even though model "tried" to call | Known issue on 30B; **Qwen3-Coder-Next (80B-A3B) is the newer release and not confirmed affected** — if you see it on the loaded model, switch chat template per the Unsloth fix or add explicit system-prompt reminder. [CITED: github.com/QwenLM/Qwen3-Coder/issues/475] |
| **Gemma 4 MLX empty `tool_calls`** | Native tokens emitted but parser misses them | Bug tracked in ml-explore/mlx-lm#1096; if relying on Gemma 4, verify against current LM Studio MLX runtime build before production use. [CITED: github.com/ml-explore/mlx-lm/issues/1096] |
| **Model not loaded** | HTTP 400 or 404 with model-not-found | Pre-flight `GET /api/v0/models` and verify `id` + `"tool_use"` capability before request |
| **Context overflow mid-loop** | HTTP error or truncated response | Track cumulative token usage from `response.usage`; trim oldest tool result `content` (or summarize) when approaching model's context limit |
| **LFM2 returns Pythonic calls, not JSON** | `tool_calls` may be empty; call appears in `content` as Python list | Add "Output function calls as JSON" to system prompt (per Liquid docs) [CITED: docs.liquid.ai/lfm/key-concepts/tool-use] |

## Architectural Notes for Relay v0.2

1. **Endpoint choice:** Stick with `/v1/chat/completions` — battle-tested, all OpenAI SDKs work. `/v1/responses` (added v0.3.29) and `/v1/messages` (Anthropic-compat, v0.4.1) are newer and offer remote-MCP / Claude-code compatibility respectively. Worth a follow-up phase, not v0.2 critical path. [CITED: lmstudio.ai/docs/developer/api-changelog]
2. **Capability gating:** Before dispatching, `GET /api/v0/models` and filter to entries with `capabilities` including `"tool_use"`. Hard-fail fast on misconfigured model choice rather than letting the model produce malformed output.
3. **One client, swap models:** Because every loaded Qwen/GLM/Gemma/LFM2 model speaks the same OpenAI shape, a single HTTP client serves all. Route by task type (code → qwen3-coder-next; vision → qwen3-vl-thinking; speed → lfm2 / glm-4.7-flash).
4. **No SDK lock-in:** Use plain `fetch` / `node:http` rather than `openai` SDK to keep Relay's dependency surface minimal — the wire format is small and stable.

## Open Questions

1. **Named-tool `tool_choice` on MLX models** — works on llama.cpp builds, unverified on MLX-quantized Qwen/Gemma. Test before depending on it.
2. **Parallel tool calls reliability across these specific models** — LM Studio supports the wire format, but each model's training varies. Empirically measure on qwen3-coder-next and glm-4.7-flash before designing UI around parallel calls.
3. **`tool_choice: "required"` behavior on non-llama.cpp runtimes** — changelog explicitly scopes it to llama.cpp; MLX behavior undocumented.

## Sources

Primary (HIGH confidence):
- [LM Studio — Tool Use (OpenAI compat)](https://lmstudio.ai/docs/developer/openai-compat/tools)
- [LM Studio — API Changelog](https://lmstudio.ai/docs/developer/api-changelog)
- [LM Studio — OpenAI Compatibility Endpoints](https://lmstudio.ai/docs/developer/openai-compat)
- [LM Studio — OpenAI Compatibility API](https://lmstudio.ai/docs/api/openai-api)

Model-specific (HIGH/MEDIUM):
- [Qwen3-Coder-Next on Hugging Face](https://huggingface.co/Qwen/Qwen3-Coder-Next)
- [Qwen Function Calling Docs](https://qwen.readthedocs.io/en/latest/framework/function_call.html)
- [GLM-4.7 on Hugging Face](https://huggingface.co/zai-org/GLM-4.7)
- [Gemma 4 Function Calling — Google AI](https://ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4)
- [Liquid LFM2 Tool Use Docs](https://docs.liquid.ai/lfm/key-concepts/tool-use)
- [No Cloud, No Waiting — LFM2-24B-A2B agents (Liquid AI blog)](https://www.liquid.ai/blog/no-cloud-tool-calling-agents-consumer-hardware-lfm2-24b-a2b)

Known-issue references (MEDIUM):
- [Qwen3-Coder 30B function calling reliability — Issue #475](https://github.com/QwenLM/Qwen3-Coder/issues/475)
- [Gemma 4 MLX empty tool_calls — mlx-lm Issue #1096](https://github.com/ml-explore/mlx-lm/issues/1096)

## Assumptions Log

| # | Claim | Section | Risk if wrong |
|---|---|---|---|
| A1 | Named-tool `tool_choice` (`{type:"function", function:{name:...}}`) works on LM Studio | tool_choice table | Forced-tool routing fails; fallback to `"auto"` + system-prompt steering |
| A2 | Loop detector (3x identical call hash) is the right repeat-prevention pattern | Max iterations | False positives on legitimate retries; tunable threshold |
| A3 | Qwen3-VL-32B supports tool calls via standard format | Loaded models table | If false, route Figma+tool tasks through qwen3-coder-next instead and use VL only for vision-only turns |
| A4 | 20-iteration ceiling is appropriate for Relay's target tasks | Max iterations | Too low → premature termination on complex refactors; too high → budget burn. Make it configurable, default 20 |
