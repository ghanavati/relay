# LM Studio Tool-Calling Errata — May 2026

**Researched:** 2026-05-20
**Domain:** LM Studio OpenAI-compat tool calling, deltas since LMSTUDIO-TOOL-API.md (2026-05-18)
**Confidence:** HIGH on changelog/versions, MEDIUM on per-model regressions
**Scope:** Phase 3 v0.2 — `src/workers/lmstudio-agentic.ts`. Read alongside `../v0.2-improvised-scrap/LMSTUDIO-TOOL-API.md`.

## Summary

Three things have moved since the April 2025 baseline used in LMSTUDIO-TOOL-API.md:

1. **LM Studio versions** — stable is **0.4.13** (2026-05-13); **0.4.14+2 beta** ships TODAY (2026-05-20). The canonical `api-changelog.md` on GitHub stops at 0.4.1 — it's stale; only per-release pages document 0.4.2..0.4.14 features. [VERIFIED: github.com/lmstudio-ai/docs api-changelog.md, lmstudio.ai/changelog]
2. **Two PLAN.md-affecting wire-shape facts changed:**
   - The capabilities probe shape is **not** what PLAN.md T4-case-7 implies; see §4 below — REWORK NEEDED.
   - `tool_choice: "required"` is still **llama.cpp-only** as of 0.4.13 — no MLX support has been added. PLAN.md doesn't depend on this; flagged for completeness.
3. **Reasoning + tool_calls interaction** is now the dominant failure mode for Qwen 3.5/3.6 family models in tool-loop usage. qwen3-coder-next ships without `<think>` by default, so the loop is safer there — but loop must still echo `reasoning_content` back verbatim if it ever appears.

**Primary recommendation:** Keep the plan's `stream:false` + `qwen3-coder-next` default. Fix the capabilities-probe wire shape (§4). Adopt the Gemini CLI loop-detector pattern verbatim for §5 (threshold lowered from PLAN.md's 3 → keep 3, but the algorithm shape is now sourced).

---

## 1. Latest LM Studio Version + Tool-Calling Changes Since April 2025

| Version | Date | Tool-call-relevant change |
|---|---|---|
| **0.4.14 beta+2** | 2026-05-20 (TODAY) | OAuth token-exchange fix for some MCP servers; MTP Speculative Decoding beta; UI whitespace fix. No tool-call wire changes. [CITED: lmstudio.ai/beta-releases] |
| **0.4.13** | 2026-05-13 | mlx-engine v1.8.1 (parallel predictions for Qwen 3.5/3.6, Gemma 4 vision); **fixed XML/XML-like tool-call parsers stripping surrounding spaces in parameters**. [CITED: lmstudio.ai/changelog/lmstudio-v0.4.13] |
| 0.4.12 | 2026-04-17 | Qwen 3.6 support; improved Qwen 3.5 perf across `/v1/chat/completions`, `/v1/responses`, `/v1/messages`; Windows MCP+OAuth fix. [CITED: lmstudio.ai/changelog/lmstudio-v0.4.12] |
| 0.4.11 | 2026-04-10 | Gemma 4 chat template updated. [CITED: lmstudio.ai/changelog/lmstudio-v0.4.11] |
| 0.4.10 | 2026-04-09 | **Gemma 4 tool-call reliability**; **OAuth for MCP servers**. [CITED: lmstudio.ai/changelog/lmstudio-v0.4.10] |
| 0.4.9 | 2026-04-02 | **Gemma 4 tool-call reliability** (continued); `output_config.effort` on `/v1/messages`. [CITED: lmstudio.ai/changelog/lmstudio-v0.4.9] |
| 0.4.8 | 2026-03-26 | `reasoning_effort`/`reasoning_tokens` on `/v1/chat/completions`; **`reasoning` field added to `/api/v1/models` response**; **XML tool-call param space-stripping fix** (first half — completed in 0.4.13). [CITED: lmstudio.ai/changelog/lmstudio-v0.4.8] |
| **0.4.7** | 2026-03-18 | **Fixed: tool calls parsed inside reasoning blocks (false positives); fixed: parallel tool calls failing on GLM; fixed: Qwen 3.5/GLM string params parsed as object/number/boolean**; added gpt-oss tool-call grammar (requires llama.cpp engine ≥ v2.7.1). XML-style tool-call bool parsing for Nemotron 3. `/v1/messages` now surfaces invalid-tool-call errors. [CITED: lmstudio.ai/changelog/lmstudio-v0.4.7] |
| 0.4.6 | 2026-02-27 | LM Link (remote LM Studio over Tailscale). No tool-call changes. [CITED: lmstudio.ai/changelog/lmstudio-v0.4.6] |
| 0.4.5 | 2026-02-25 | Qwen 3.5 tool-calling improvements. [CITED: lmstudio.ai/changelog/lmstudio-v0.4.5] |
| 0.4.4 | 2026-02-20 | Fixed thinking tags not emitted correctly through `/v1/chat/completions`. [CITED: lmstudio.ai/changelog/lmstudio-v0.4.4] |
| 0.4.3 | 2026-02-19 | Fixed streaming REST endpoints sending headers after errors in `/v1/responses` and `/v1/chat`. [CITED: lmstudio.ai/changelog/lmstudio-v0.4.3] |
| 0.4.2 | 2026-02-06 | Continuous batching extended to MLX engine. [CITED: lmstudio.ai/changelog/lmstudio-v0.4.2] |
| 0.4.1 | 2026-01-(prior) | `POST /v1/messages` Anthropic-compat endpoint. [CITED: github lmstudio-ai/docs api-changelog.md] |
| 0.4.0 | 2026-01-(prior) | Native v1 REST API at `/api/v1/*`; MCP via API; stateful chats; auth tokens. [CITED: github lmstudio-ai/docs api-changelog.md] |

### `tool_choice: "required"` engine scope — UNCHANGED
- Still **llama.cpp engines only** since v0.3.15 (2025-04-24). No MLX support landed in 0.4.x. [VERIFIED: searched all 0.4.x release notes; no mention of MLX `tool_choice:required` support] [CITED: lmstudio.ai/docs/developer/api-changelog v0.3.15 entry]
- Relay v0.2 doesn't use `tool_choice: "required"`. No code change. Document for future use.

---

## 2. Per-Model Tool-Call Reliability (May 2026 snapshot)

| Model | Tool calling status | Confidence | Notes |
|---|---|---|---|
| **qwen/qwen3-coder-next** (80B-A3B) | **Recommended default — but verify** | MEDIUM | Native tool training, ships without reasoning tags. **External-tool regression**: Roo-Code archived issue #10541 reports "tool calling totally broken" against Roo ≥ 3.37.0 — but that's a Roo-side fragmentation bug, not LM Studio. With our injected `fetchImpl` and `stream:false`, we sidestep it. [VERIFIED: github.com/RooCodeInc/Roo-Code/issues/10541] |
| **qwen/qwen3.6-35b-a3b** | Functional but reasoning-content trap | MEDIUM | 0.4.12 added Qwen 3.6 support. **CRITICAL pitfall**: with reasoning enabled, `<think>` blocks leak `</think>` into `content` field on multi-turn, *and* the reasoning content must be echoed back as `reasoning_content` on the assistant message to avoid downstream output corruption. PLAN.md does not handle this. See §3 below. [CITED: github.com/QwenLM/Qwen3.6/issues/26, lmstudio-bug-tracker/issues/1589, lmstudio.ai/changelog/lmstudio-v0.4.12] |
| **zai-org/glm-4.7-flash** | Functional; parallel-call reliability improved 0.4.7 | MEDIUM | 0.4.7 fixed parallel tool calls failing on GLM and string params being miscoerced to object/number/boolean. llama.cpp Jan 2026 fixed wrong `scoring_func` ("softmax" → "sigmoid") that caused looping. Use updated GGUFs. [CITED: lmstudio.ai/changelog/lmstudio-v0.4.7, search results re: llama.cpp Jan 2026 fix] |
| **liquid/lfm2-24b-a2b** | Pythonic by default | HIGH | Unchanged since baseline doc. System-prompt nudge `"Output function calls as JSON"` still required. PLAN.md T6 covers this. [CITED: docs.liquid.ai/lfm/key-concepts/tool-use, huggingface.co/LiquidAI/LFM2-24B-A2B] |
| **google/gemma-4-31b** | Substantially improved 0.4.9 + 0.4.10 + 0.4.11 | MEDIUM | Three consecutive releases targeted Gemma 4 tool-call reliability. Old mlx-lm#1096 empty-tool_calls bug is the original symptom; verify against your LM Studio build before relying on it. Not on Relay v0.2 critical path (qwen3-coder-next is default). [CITED: lmstudio.ai/changelog/lmstudio-v0.4.9, /lmstudio-v0.4.10, /lmstudio-v0.4.11, github.com/ml-explore/mlx-lm/issues/1096] |

### Pre-existing pitfall worth re-stating
- **qwen3-coder 30B** (NOT the 80B "next") drops `<tool_call>` tag after text → empty `tool_calls`. Issue #825 / #1071. **80B coder-next is a separate model** — different chat template, different parser path. No evidence the 30B bug affects the 80B "next" variant. PLAN.md is correct to default to coder-next. [VERIFIED: lmstudio-bug-tracker/issues/825, lmstudio-bug-tracker/issues/1071]

---

## 3. Known LM Studio Bugs Affecting Tool Calling (May 2026 status)

### B1 — Reasoning-content leak into `content` (Qwen 3.5/3.6) — UNFIXED in upstream
**Symptom:** Multi-turn tool loop emits `</think>` mid-`content` because the client didn't round-trip `reasoning_content` on the assistant message.
**Affects:** Qwen 3.5+, K2.5, DeepSeek V4. **qwen3-coder-next** ships without reasoning tags by default — lower risk.
**Mitigation for Relay v0.2:** When appending the assistant message from `body.choices[0].message`, copy `reasoning_content` verbatim if present. Don't strip it. [CITED: github.com/QwenLM/Qwen3.6/issues/26, github.com/open-webui/open-webui/issues/23175, github.com/anomalyco/opencode/issues/24190]

```ts
// CORRECT — preserve reasoning_content on the assistant message in messages[]
messages.push({
  role: 'assistant',
  content: msg.content ?? null,
  tool_calls: msg.tool_calls,
  ...(msg.reasoning_content && { reasoning_content: msg.reasoning_content }),
});
```

### B2 — XML/XML-like tool-call parsers stripped surrounding spaces — FIXED 0.4.13
**Symptom:** `{ "command": " ls " }` arrived at server as `{ "command": "ls" }`. Affected models using XML-style tool-call format internally (some Qwen variants, Gemma when forced to XML).
**Status:** **FIXED in 0.4.13** (2026-05-13). Pin LM Studio ≥ 0.4.13 in user docs. [CITED: lmstudio.ai/changelog/lmstudio-v0.4.13]

### B3 — qwen3-coder-30B streaming produces XML tool calls instead of OpenAI JSON — UNFIXED (closed as duplicate)
**Symptom:** With `stream:true`, qwen3-coder-30B returns XML-tagged tool calls; with `stream:false`, returns proper OpenAI JSON. **Workaround per author of bug**: modify Jinja template.
**Status:** Issue #1071 closed as duplicate of #825 (which was "closed as fixed" but reproducible). Affects 30B only — not coder-next 80B per available evidence.
**Relevance to Relay v0.2:** PLAN.md hard-codes `stream:false` for exactly this class of failure. Keep. [CITED: lmstudio-bug-tracker/issues/1071, /825]

### B4 — Empty `tool_call_id` from model output — UNFIXED, last seen 0.3.21 beta
**Symptom:** Model produces `{"id": "", "type": "function", ...}` on rare paths. Downstream echo fails with "Invalid 'messages' in payload".
**Mitigation for Relay v0.2:** When iterating `msg.tool_calls`, validate `tc.id` is a non-empty string before dispatching the tool. On empty id, append a `{role:'tool', tool_call_id:'__missing__', content:'ERROR: tool_call_id was empty'}` synthetic and let the loop detector + iteration cap absorb the misbehavior. Don't crash. [CITED: lmstudio-bug-tracker/issues/830]

### B5 — Tool calls parsed inside `<think>` blocks (false positives) — FIXED 0.4.7
Status: FIXED. No action needed. [CITED: lmstudio.ai/changelog/lmstudio-v0.4.7]

### B6 — mlx-lm#1096 Gemma 4 empty tool_calls — IMPROVED 0.4.9/0.4.10/0.4.11
Status: Three consecutive LM Studio releases targeted this. Still verify on the live build before relying on Gemma 4 for tool use. [CITED: github.com/ml-explore/mlx-lm/issues/1096, lmstudio.ai/changelog/lmstudio-v0.4.9-11]

### B7 — Codex CLI 0.64.0 mangles streaming tool calls from local providers — UNRESOLVED
**Not LM Studio's bug**, but documents an industry pattern: **streaming + tool_calls + local OpenAI-compat provider is fragile across consumer clients**. Each char fragment was being treated as a separate tool call due to client-side accumulator bug.
**Relevance to Relay v0.2:** Reinforces `stream:false` decision. PLAN.md is correct. [CITED: github.com/openai/codex/issues/7517]

---

## 4. Capabilities Probe — **PLAN.md WIRE-SHAPE BUG**

PLAN.md T4 case 7 and the smoke validation say:

```bash
curl -sS http://localhost:1234/api/v0/models | jq '.data[] | select(.id=="qwen/qwen3-coder-next") | .capabilities'
```

assuming `capabilities: ["tool_use"]` array. Two corrections:

### 4.1 `/api/v0/models` does NOT include `capabilities`
The v0 REST endpoint documented at lmstudio.ai/docs/developer/rest/endpoints returns only: `id`, `object`, `type`, `publisher`, `arch`, `compatibility_type`, `quantization`, `state`, `max_context_length`. **No `capabilities` field.** [VERIFIED: lmstudio.ai/docs/developer/rest/endpoints]

### 4.2 Capabilities live on TWO different endpoints, in TWO different shapes
| Endpoint | Shape | Citation |
|---|---|---|
| OpenAI-compat `GET /v1/models` (since 0.3.16) | `capabilities: ["tool_use", "vision", ...]` — **array of strings** | [CITED: lmstudio.ai/docs/developer/api-changelog v0.3.16 entry "GET /models response now includes capabilities array"] |
| Native v1 REST `GET /api/v1/models` (since 0.4.0) | `capabilities: { vision: bool, trained_for_tool_use: bool, reasoning: {...} }` — **object** | [CITED: lmstudio.ai/docs/developer/rest/list (and 0.4.8 added `reasoning` sub-key)] |

### 4.3 Required PLAN.md fix

Change T4 case 7 + the §"Runtime Validation" smoke command to use the **OpenAI-compat** endpoint (more stable, simpler shape, no native-API auth concerns):

**Old (broken) shape used in PLAN.md:**
```bash
curl -sS http://localhost:1234/api/v0/models | jq '.data[] | select(.id=="qwen/qwen3-coder-next") | .capabilities'
```

**New verified shape:**
```bash
# Returns the array; jq exits non-zero if model not found OR capability absent
curl -sS http://localhost:1234/v1/models | \
  jq -e '.data[] | select(.id=="qwen/qwen3-coder-next") | .capabilities | index("tool_use")'
```

**Wire shape (illustrative; live response):**
```json
{
  "object": "list",
  "data": [
    {
      "id": "qwen/qwen3-coder-next",
      "object": "model",
      "owned_by": "organization-owner",
      "capabilities": ["tool_use", "reasoning"]
    },
    {
      "id": "liquid/lfm2-24b-a2b",
      "object": "model",
      "capabilities": ["tool_use"]
    }
  ]
}
```

**Code path:** The runner's capability probe should hit `${endpoint}/models` (the OpenAI-compat base is already `${endpoint}/v1/` per Relay config), check `data[].capabilities` is an array, and look for the literal string `"tool_use"`. Fail-closed on:
- missing `capabilities` key entirely (older LM Studio < 0.3.16 — refuse with a clear `INVALID_ARGS: LM Studio < 0.3.16 — upgrade required`)
- `capabilities` present but doesn't include `"tool_use"`

**Belt-and-suspenders:** If the LM Studio version refuses to return capabilities, fall back to checking the native `/api/v1/models` response for `capabilities.trained_for_tool_use === true`. Optional, low priority.

---

## 5. Hash-Based Loop Detector — Adopt Gemini CLI Pattern (Best Prior Art)

Gemini CLI's `LoopDetectionService.ts` is the cleanest production-grade reference. The full source is at `google-gemini/gemini-cli/packages/core/src/services/loopDetectionService.ts`.

### Key facts from the Gemini CLI implementation
- **Threshold:** `TOOL_CALL_LOOP_THRESHOLD = 5` consecutive identical calls. (PLAN.md picks 3 — more aggressive; defensible for local LLM where re-runs are cheap to retry. Keep 3.)
- **Hash:** `sha256(name + ':' + JSON.stringify(args))` — single concatenated string, not separated components.
- **Data structure:** Simple state machine — two fields, `lastToolCallKey: string | null` and `toolCallRepetitionCount: number`. Different call resets count to 1. No queue, no sliding window.
- **Action on hit:** Halt immediately, emit a `LoopDetectedEvent` of type `CONSECUTIVE_IDENTICAL_TOOL_CALLS`, surface `detail` string `"Repeated tool call: <name> with arguments <args>"`. No retry. No system-prompt nudge. Just stop.
- **Caveat injected by Gemini:** When the user's original prompt implies a batch operation ("update all files", "refactor every module"), an LLM-based secondary check tries to suppress false positives.

[VERIFIED: github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/loopDetectionService.ts]

### Other prior art surveyed
- **Anthropic Claude Code** issue #4277: feature request for the same pattern, citing Gemini CLI's `loopDetectionService.ts` as the reference. Not yet implemented in Claude Code as of date. [CITED: github.com/anthropics/claude-code/issues/4277]
- **OpenClaw** issue #16583: discussion of 3-5 consecutive identical calls as the threshold range; recommends inject-system-message → force-context-compaction as a tiered response. [CITED: github.com/openclaw/openclaw/issues/16583]
- **Hermes Agent** issue #481: SHA-256 pattern detection pattern, inspired by OpenFang. [CITED: github.com/NousResearch/hermes-agent/issues/481]
- **Aider**: no formal loop-detector in the OSS code; relies on user `/undo` + retry tooling.
- **Continue.dev**: no documented loop detector found.

### Recommended adaptation for Relay v0.2

**Keep PLAN.md's threshold of 3.** Rationale: local LLM inference is slower; 3 burns less wall-clock than 5; the cost of a false positive is just a user re-run.

**Spec deviation from Gemini CLI worth keeping** — PLAN.md T5 case 4 combines per-call hashes into a per-turn fingerprint (sorted `|`-joined hashes of every parallel call in one assistant turn). Gemini CLI doesn't do this because Gemini's stream emits one `ToolCallRequest` event per call regardless of parallelism. Relay's loop sees one assistant message per iteration. **Per-turn fingerprint is the right abstraction for Relay.**

**Use the exact hash recipe from Gemini CLI (with PLAN.md's canonical-JSON twist):**
```ts
function hashToolCall(name: string, args: object): string {
  // Canonical JSON keeps key-order-equivalent calls hashing identically.
  // Gemini CLI uses raw JSON.stringify (key order matters). PLAN.md spec
  // (canonicalJsonStringify) is the stronger choice for catching tight loops
  // where the model alternates key ordering.
  const argsString = canonicalJsonStringify(args);
  return createHash('sha256').update(`${name}:${argsString}`).digest('hex');
}
```

**Per-turn fingerprint:**
```ts
const callHashes = msg.tool_calls.map(tc =>
  hashToolCall(tc.function.name, JSON.parse(tc.function.arguments))
);
const turnHash = createHash('sha256').update(callHashes.sort().join('|')).digest('hex');
```

This is PLAN.md's current spec, validated against the Gemini CLI reference. No design change required, just citation strength.

---

## 6. `tool_call_id` Echo — Byte-Exact Across All Surveyed Families

| Family | Native ID style | Echo requirement | Citation |
|---|---|---|---|
| OpenAI GPT-4o, GPT-5 | `call_<24-alnum>` (e.g., `call_FthC9qRpsL5kBpwwyw6c7j4k`) | Byte-exact match required; mismatch → `400 No tool call found for function call output with call_id` | [CITED: community.openai.com/t/1142327, /1066788, OpenAI function-calling docs] |
| LM Studio (server-emitted) | Arbitrary numeric string, e.g. `"365174485"` | Byte-exact echo expected by LM Studio's message validator | [CITED: lmstudio.ai/docs/developer/openai-compat/tools (per baseline LMSTUDIO-TOOL-API.md)] |
| Anthropic-compat `/v1/messages` | Anthropic uses `toolu_*`; LM Studio passes the model-emitted id through | Byte-exact | [CITED: 0.4.1 changelog entry; OpenAI API community post 10067] |
| LFM2 | Pythonic mode emits no id (call is positional); JSON mode emits the LM Studio-assigned id | Byte-exact when present | [CITED: docs.liquid.ai/lfm/key-concepts/tool-use] |

**No normalization, no trimming, no case-folding.** Treat as opaque token. PLAN.md T3 case 7 + T8 already asserts byte-exact echo on numeric `"365174485"` AND UUID `"call_abc-123-XYZ"`. **No change needed.** The pre-existing empty-`id` bug (§B4) is the only known counterexample — handle defensively, do not "fix" by synthesizing a fake id (it won't satisfy the LM Studio validator).

---

## 7. Streaming + Tools — Still Stay Off for v0.2

No new fixes change the v0.2 calculus:

- **0.3.17** (2025-06-25) streams arg tokens as generated.
- **0.3.18** (2025-07-10) fixed parallel tool calls split across chunks.
- **0.3.19** (2025-07-21) further parallel-tool-call streaming fixes.
- **0.4.3** (2026-02-19) fixed streaming REST endpoints sending headers after errors.
- **No 0.4.x release has eliminated client-side accumulator complexity** — Codex 0.64.0 (Dec 2025) regression (B7) is the most recent reminder that streaming + tools + local provider is fragile across consumer clients.
- qwen3-coder-30B issue (B3) **explicitly recommends `stream:false` as the workaround**.

**Verdict:** `stream:false` is correct for v0.2. Document the path-back-to-streaming as a v0.3+ task: would require per-tool-call SSE accumulator keyed by `delta.tool_calls[].index` (since v0.3.18), parser for partial JSON tolerance, and integration tests against ≥ 3 model families. Not on critical path.

---

## 8. Recommended Per-Iteration Timeout

PLAN.md uses one wall-clock `task.timeout_ms` via AbortController spanning the entire tool-loop. No per-iteration timeout.

### Why this is fine for v0.2
- qwen3-coder-next at 80B-A3B on Apple Silicon: ~5-15s per turn empirically. [CITED: LMSTUDIO-TOOL-API.md §Max Iterations Rationale — internal estimate, MEDIUM confidence]
- 20 iterations × 15s = 300s. The user already supplies `--timeout-ms` as the budget ceiling.
- A per-iteration timeout that's shorter than wall-clock would abort the slowest single inference and let the rest proceed — which means a successful loop could silently lose iterations. Worse than wall-clock-only.

### When per-iteration timeout matters (v0.3+)
Adopt **only if** a future change introduces a tool that can hang (network fetch, MCP server). In that case use:
- **Per-LLM-inference: 60s** (covers slow first-token + worst-case 15B model on consumer CPU)
- **Per-tool-execution: 30s** (matches PLAN.md's `execFile` timeout on shell_exec)
- **Total wall-clock: user-supplied `task.timeout_ms`**, default 300s

[CITED: futureagi.com/glossary/tool-timeout — recommends differentiated deadlines per tool type] [ASSUMED: 60s/30s ratios — not from a single canonical source]

### Industry signal
- Google Gemini CLI's `LoopDetectionService` does NOT use per-iteration timeouts — relies on the surrounding `AbortSignal` + LLM-based heuristic. [VERIFIED: gemini-cli source]
- OpenAI Codex CLI has no documented per-tool timeout — uses session-wide.
- FutureAGI advocates per-tool differentiation but cites only the 5000ms HTTP-tool example.

**Action for Relay v0.2:** None. Keep wall-clock-only. Add per-iteration only when tools beyond `shell_exec` ship.

---

## 9. Action Items for Phase 3 PLAN.md

| Severity | Item | Where in PLAN.md | Fix |
|---|---|---|---|
| **MUST** | Capability probe wire shape wrong — `/api/v0/models` has no `capabilities`; `/v1/models` returns `["tool_use"]` array (OpenAI-compat) | T4 case 7; §Runtime Validation curl; §key_links endpoint pattern `/api/v0/models` | Change probe to `GET {endpoint}/models` (i.e., `/v1/models`); look for `"tool_use"` string in `data[i].capabilities` array. Update key_links pattern from `/api/v0/models` to `/v1/models`. |
| **SHOULD** | Preserve `reasoning_content` on assistant message echo | T4 step 6 ("append msg = body.choices[0].message to messages") | When appending, spread the full message — include `reasoning_content` if present. Single-line edit. Add a T4 case 9 covering Qwen 3.6 with reasoning content + tool call. |
| **SHOULD** | Defensive handling of empty `tool_call_id` from model (B4) | T3 / T4 — currently assumes non-empty | Validate `tc.id` is non-empty string before dispatch; on empty, append a `__missing__` synthetic tool message with ERROR content. Document as a known LM Studio bug in plan. |
| MAY | Recommend pinning LM Studio ≥ 0.4.13 in user docs (B2 fix landed there) | New entry in §Acceptance Criteria | Add user-facing note: "Requires LM Studio ≥ 0.4.13 (2026-05-13) for XML-tool-call space-preservation fix." Not blocking — only matters for models using internal XML format. |
| MAY | Cite Gemini CLI loop-detector as prior art | T5 §Hash-based loop detector | Add a single-line citation: `// Pattern adapted from google-gemini/gemini-cli LoopDetectionService.ts — threshold lowered from 5 to 3 for local LLM cost profile.` |

---

## Assumptions Log

| # | Claim | Section | Risk if wrong |
|---|---|---|---|
| A1 | OpenAI-compat `/v1/models` returns `capabilities` as `["tool_use", ...]` string array on LM Studio ≥ 0.3.16 | §4 | If actually object-shaped, probe always fails-closed. Test before relying. Suggest hitting both endpoints in tests. |
| A2 | qwen3-coder-next 80B is NOT affected by the 30B XML-streaming bug | §2, §B3 | If false, our `stream:false` is even more important; the bug doesn't trigger in `stream:false` either way. |
| A3 | `reasoning_content` leak (B1) primarily affects Qwen 3.5/3.6 with reasoning enabled; coder-next defaults to no-reasoning | §3 B1 | If coder-next emits reasoning, we'd see `</think>` in `content` — visible to user. Adding the echo-through fix in §9 covers both cases safely. |
| A4 | Roo-Code archived issue #10541 is a Roo-side bug, not LM Studio | §2 qwen3-coder-next row | We use injected fetchImpl + own parser. Verify with smoke run; if reproducible against bare LM Studio, escalate. |
| A5 | Threshold 3 (PLAN.md) vs Gemini's 5 is a defensible local-LLM tradeoff | §5 | False positives on legitimate retries. Tunable — expose `maxIterations` and could expose `loopThreshold` later. |

---

## Sources

### Primary (HIGH confidence)
- [LM Studio — API Changelog (canonical, stale at 0.4.1)](https://lmstudio.ai/docs/developer/api-changelog)
- [LM Studio — Tool Use (OpenAI compat)](https://lmstudio.ai/docs/developer/openai-compat/tools)
- [LM Studio — Beta Releases (0.4.14+2, 2026-05-20)](https://lmstudio.ai/beta-releases)
- [LM Studio — Changelog 0.4.13](https://lmstudio.ai/changelog/lmstudio-v0.4.13)
- [LM Studio — Changelog 0.4.12](https://lmstudio.ai/changelog/lmstudio-v0.4.12)
- [LM Studio — Changelog 0.4.10](https://lmstudio.ai/changelog/lmstudio-v0.4.10)
- [LM Studio — Changelog 0.4.9](https://lmstudio.ai/changelog/lmstudio-v0.4.9)
- [LM Studio — Changelog 0.4.8](https://lmstudio.ai/changelog/lmstudio-v0.4.8)
- [LM Studio — Changelog 0.4.7](https://lmstudio.ai/changelog/lmstudio-v0.4.7)
- [LM Studio — REST API v0 endpoints (capabilities not present)](https://lmstudio.ai/docs/developer/rest/endpoints)
- [LM Studio — REST API v1 list (capabilities object shape)](https://lmstudio.ai/docs/developer/rest/list)
- [Google Gemini CLI — LoopDetectionService.ts (canonical loop-detector reference)](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/loopDetectionService.ts)

### Bug references (MEDIUM-HIGH)
- [lmstudio-bug-tracker #830 — empty tool_call_id](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/830)
- [lmstudio-bug-tracker #825 — qwen3-coder 30B custom XML tool-call format](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/825)
- [lmstudio-bug-tracker #1071 — qwen3-coder 30B streaming XML tool calls](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1071)
- [lmstudio-bug-tracker #1589 — Qwen3.5 think tags break tool JSON](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1589)
- [QwenLM/Qwen3.6 #26 — Qwen3.5 tool-call reasoning_content leak](https://github.com/QwenLM/Qwen3.6/issues/26)
- [continuedev/continue #12131 — Qwen 3.5 + Gemma 4 tool calls](https://github.com/continuedev/continue/issues/12131)
- [openai/codex #7517 — streaming tool-call accumulator regression](https://github.com/openai/codex/issues/7517)
- [RooCodeInc/Roo-Code #10541 — qwen-next tool calling broken in Roo 3.37+](https://github.com/RooCodeInc/Roo-Code/issues/10541)
- [ml-explore/mlx-lm #1096 — Gemma 4 MLX empty tool_calls](https://github.com/ml-explore/mlx-lm/issues/1096)
- [anthropics/claude-code #4277 — loop-detection feature request, cites Gemini CLI](https://github.com/anthropics/claude-code/issues/4277)
- [openclaw/openclaw #16583 — loop detection threshold discussion](https://github.com/openclaw/openclaw/issues/16583)
- [NousResearch/hermes-agent #481 — SHA-256 tool-call loop guard](https://github.com/NousResearch/hermes-agent/issues/481)

### Secondary (MEDIUM)
- [OpenAI community — tool_call_id mismatch error](https://community.openai.com/t/tool-call-id-not-found-in-conversation/1066788)
- [OpenAI community — 400 No tool call found for function call output](https://community.openai.com/t/issue-with-new-responses-api-400-no-tool-call-found-for-function-call-output-with-call-id/1142327)
- [FutureAGI — Tool Timeout glossary](https://futureagi.com/glossary/tool-timeout/)
- [Liquid AI — LFM2 Tool Use](https://docs.liquid.ai/lfm/key-concepts/tool-use)
