# PLAN-6 — Figma Integration via Agentic Local Runner (v0.2)

**Scope:** ROADMAP §3. Wire 4 Figma tools into `LmStudioAgenticRunner`.
Phase 1 ships 2 REST-only tools independently; Phase 2 adds 2 Plugin-API tools
via a local WebSocket Desktop Bridge + Figma plugin. CC subagents only — no codex.
TDD throughout.

**Sources:** `ROADMAP.md:76-96`, `.planning/v0.2/FIGMA-API-TOOLS.md` (full),
`.planning/v0.2/LMSTUDIO-TOOL-API.md:31-176` (HTTP shape + tool def format),
`.planning/v0.2/AGENTIC-WORKER-PATTERN.md:157-281` (runner integration seams),
`.planning/v0.2/WORKERS-MAP.md:326-341` (insertion checklist),
`.planning/v0.2/ROADMAP-DRIFT.md:39-44` (DISABLED_CODEX_MCP_LABELS evidence).

**Hard dependency:** ROADMAP §2 / AGENTIC-WORKER-PATTERN.md must ship first
(provides `LmStudioAgenticRunner`, `WorkerTask.tools`, in-process tool dispatch).
This plan assumes that runner exists and exposes a tool-registry seam.

---

## Goal

Ship 4 Figma tools selectable by `qwen/qwen3-coder-next` (and any other
tool-capable LM Studio model) through the agentic runner's loop. Tools are
**conditionally registered**: present iff `FIGMA_API_TOKEN` env var is set at
runner construction. Absent token → zero tools, zero startup errors, runner
behaves exactly as a non-Figma session.

Phase 1 (blocking ship for §3):
- `figma_list_layers` — GET `/v1/files/{key}` or `/v1/files/{key}/nodes` (REST)
- `figma_update_token` — POST `/v1/files/{key}/variables` (REST, Enterprise)

Phase 2 (additive, ship when bridge ready):
- `figma_get_selection` — Plugin API via WS bridge
- `figma_create_component` — Plugin API via WS bridge

Tool definitions match OpenAI Chat Completions `tools[]` schema verbatim per
`LMSTUDIO-TOOL-API.md:39-67,118-147`. Each tool registers a JSON-schema
`function` block; runner serializes into the `tools` array of every
`POST /v1/chat/completions` call until the loop terminates.

---

## Phased approach

| Phase | Ship gate | Tools added | Dependencies |
|---|---|---|---|
| 1 (REST) | independent of bridge | `figma_list_layers`, `figma_update_token` | `FIGMA_API_TOKEN` env, agentic runner from §2 |
| 2 (Bridge) | adds to Phase 1, optional at runtime | `figma_get_selection`, `figma_create_component` | Phase 1 merged + Figma plugin installed + Relay Bridge WS up |

**Critical:** Phase 1 ships standalone. Phase 2 is purely additive — Phase 1
tools remain available when the bridge is offline. The registry **MUST NOT**
fail-stop the entire Figma toolset if Phase-2 bridge connection fails.
Each Phase-2 tool checks bridge availability lazily on invocation and returns
a structured `BRIDGE_UNAVAILABLE` error to the model (per
`FIGMA-API-TOOLS.md:276-286`).

---

## Files to touch

### Phase 1 (REST tools)

| Path | New? | Purpose |
|---|---|---|
| `src/tools/figma/index.ts` | NEW | Registry export: `getFigmaTools(env): ToolDef[]`, `getFigmaHandlers(env): Record<string, ToolHandler>`. Returns `[]` / `{}` when `FIGMA_API_TOKEN` unset. |
| `src/tools/figma/rest-client.ts` | NEW | `FigmaRestClient` — wraps `fetch`, applies `X-Figma-Token` header from injected token, handles 429 with `Retry-After` + exponential backoff (max 1 retry), maps 4xx/5xx → typed errors. Reuses `getLmStudioEndpoint` style: constructor takes `{ token, fetchImpl }`. |
| `src/tools/figma/list-layers.ts` | NEW | Tool def (JSON schema per `FIGMA-API-TOOLS.md:36-65`) + handler. Calls `GET /v1/files/{key}/nodes?ids={page_id}&depth={depth}` (page_id supplied) or `GET /v1/files/{key}?depth={depth}` (omitted). Flattens response to `{id, name, type, parent_id, depth}[]`. |
| `src/tools/figma/update-token.ts` | NEW | Tool def + handler. Two-step: (1) `GET /v1/files/{key}/variables/local` to resolve `variableId` by name; (2) `POST /v1/files/{key}/variables` with `action:"CREATE"` (tempId) or `"UPDATE"` (resolved id). 403 → surface "Enterprise plan + `file_variables:write` scope required". Type coercion per `FIGMA-API-TOOLS.md:156-163`. |
| `src/tools/figma/types.ts` | NEW | Local `ToolDef`, `ToolHandler`, `FigmaErrorCode` types. Re-exports from `src/workers/types.ts` if `ToolDef` already lives there (per AGENTIC-WORKER-PATTERN). |
| `src/workers/lmstudio-agentic.ts` | MODIFIED (added by §2 plan) | At runner construction, call `getFigmaTools(process.env)` and `getFigmaHandlers(process.env)`; merge into the runner's tool registry. **Exactly one insertion point** — see Phase 1 / T4 below. |

### Phase 1 tests

| Path | Purpose |
|---|---|
| `src/tools/figma/rest-client.test.ts` | Mocked `fetch`: auth header presence, 200 happy path, 401/403/404/429 mapping, single retry on 429 honoring `Retry-After`. |
| `src/tools/figma/list-layers.test.ts` | Mocked client: with/without `page_id`, depth cap, flatten correctness, error pass-through. |
| `src/tools/figma/update-token.test.ts` | Mocked client: create-vs-update branching (name lookup), color/spacing/typography value shapes, 403 → "Enterprise required" string in result. |
| `src/tools/figma/index.test.ts` | Env-driven registration: `FIGMA_API_TOKEN` unset → `getFigmaTools(env).length === 0`; set → exactly the Phase-1 tool names returned; tool defs validate against OpenAI tool-schema shape per `LMSTUDIO-TOOL-API.md:39-67`. |
| `src/workers/lmstudio-agentic.test.ts` | NEW assertion in existing file (added by §2 plan): with `FIGMA_API_TOKEN` set, a canned `tool_calls[]` response for `figma_list_layers` is dispatched to the Figma handler (mocked), result is appended as `{role:'tool', tool_call_id, content}`, loop continues. |

### Phase 2 (Bridge + Plugin)

| Path | New? | Purpose |
|---|---|---|
| `src/tools/figma/bridge-server.ts` | NEW (Phase 2) | `FigmaBridgeServer` — WebSocket server on port 9223, scans 9224-9232 on `EADDRINUSE` (per `FIGMA-API-TOOLS.md:225`). Singleton lifecycle: start on first Phase-2 tool invocation, accept exactly one plugin client at a time, request/response correlation via opaque `id`. Auto-close on runner shutdown. No auth (loopback-only bind to `127.0.0.1`). |
| `src/tools/figma/get-selection.ts` | NEW (Phase 2) | Tool def per `FIGMA-API-TOOLS.md:298-314`. Handler dispatches `{op:"getSelection", args:{page_id}}` over bridge, awaits reply, returns selection array. Bridge offline → `BRIDGE_UNAVAILABLE` error to model. |
| `src/tools/figma/create-component.ts` | NEW (Phase 2) | Tool def per `FIGMA-API-TOOLS.md:229-253`. Handler dispatches `{op:"createComponent", args:{...}}` over bridge. Returns `{node_id, key, url}`. Same offline-fallback as get-selection. |
| `figma-plugin/manifest.json` | NEW (Phase 2) | Figma plugin manifest. Editor type: `["figma"]` (Design only, not FigJam per `FIGMA-API-TOOLS.md:282`). No special permissions. |
| `figma-plugin/code.ts` | NEW (Phase 2) | ~150 LoC TS. On run: open WS to `ws://127.0.0.1:9223` (then 9224-9232 fallback). Receive `{op, args, id}`, dispatch to `figma.createComponent`/`PageNode.selection`, reply `{id, result}` or `{id, error}`. |
| `figma-plugin/ui.html` | NEW (Phase 2) | Minimal UI — just a status indicator ("Connected to Relay on port N" / "Disconnected"). No user input. |
| `figma-plugin/build.sh` | NEW (Phase 2) | `tsc figma-plugin/code.ts --outFile figma-plugin/code.js --target ES2020 --lib ES2020,DOM`. Output committed (Figma plugins ship as JS). |
| `figma-plugin/README.md` | NEW (Phase 2) | Install instructions: Figma Desktop → Plugins → Development → Import plugin from manifest. |
| `src/tools/figma/bridge-protocol.ts` | NEW (Phase 2) | Shared `{op, args, id}` ↔ `{id, result, error}` envelope types. Imported by both `bridge-server.ts` (Relay) and copied into `figma-plugin/code.ts` (plugin sandbox can't share node_modules). |

### Phase 2 tests

| Path | Purpose |
|---|---|
| `src/tools/figma/bridge-server.test.ts` | Spin up server on ephemeral port, connect mock WS client, assert request/response correlation, assert port-fallback when 9223 occupied, assert single-client enforcement, assert graceful close. |
| `src/tools/figma/get-selection.test.ts` | Mock bridge: connected → returns canned selection; disconnected → returns `BRIDGE_UNAVAILABLE` error string with install hint. |
| `src/tools/figma/create-component.test.ts` | Mock bridge: returns `{node_id, key, url}`; wrong-editor error → surface verbatim. |
| `src/tools/figma/bridge-integration.test.ts` | Integration: real WS server + mock plugin client (in same process), full runner loop: model emits `tool_call:figma_get_selection` → bridge round-trip → tool result appended → loop terminates. |
| `figma-plugin/code.test.ts` | (Optional — defer if plugin testing infra heavyweight.) |

### Out of scope (Phase 2 or later)

- OAuth2 for Figma (defer to v0.3 per `FIGMA-API-TOOLS.md:28`).
- Variable publishing (separate Figma API call; defer per `FIGMA-API-TOOLS.md:204`).
- Multi-client bridge (one plugin connection at a time is sufficient).
- Plugin auto-install (manual install via Figma Desktop dev mode — `FIGMA-API-TOOLS.md:222`).
- **Do NOT touch** `src/workers/codex.ts:72` `DISABLED_CODEX_MCP_LABELS`. Figma
  remains disabled for the Codex path. This plan only enables Figma for
  `lmstudio-agentic`. Leaving the codex set untouched avoids cross-runner
  regressions (per user constraint in prompt).

---

## Task breakdown (TDD)

All tasks executed by CC subagents serially unless marked parallel. Strict
RED → GREEN → IMPROVE per `~/.claude/rules/common/testing.md`. Each task ends
with all prior tests still passing.

### T1 — `FigmaRestClient` skeleton with auth + retry

- **RED:** `rest-client.test.ts`: (a) GET sets `X-Figma-Token: <token>` header
  exactly; (b) 200 returns parsed JSON; (c) 401/403/404 throw typed
  `FigmaApiError` with status code; (d) 429 with `Retry-After: 1` triggers
  exactly one retry after sleep, success on 2nd attempt; (e) 429 twice → error.
- **GREEN:** Implement `FigmaRestClient` with injected `{token, fetchImpl, sleepFn}`
  (sleep injected for fast tests). Base URL `https://api.figma.com`.
  Exponential backoff: `Math.min(parseInt(retryAfter), 30)` seconds, capped at
  one retry. Throw on missing token.
- **IMPROVE:** Extract URL builder so subsequent tools build paths without
  hand-concat. Add per-call `signal: AbortSignal` for outer timeout integration.
- **Deps:** none.

### T2 — `figma_list_layers` tool def + handler

- **RED:** `list-layers.test.ts`: (a) tool def shape matches OpenAI schema
  (top-level `type:"function"`, nested `function.name`, `function.parameters`);
  (b) `name === "figma_list_layers"`; (c) handler with `{file_key, page_id, depth}`
  → client receives `GET /v1/files/{key}/nodes?ids={page_id}&depth={depth}`;
  (d) handler without `page_id` → `GET /v1/files/{key}?depth={depth}`;
  (e) flatten output: response `{nodes:{...}}` → flat `[{id,name,type,parent_id,depth}, ...]`;
  (f) 404 from client → handler returns `{error:"file_not_found", message:"..."}`
  to model (does NOT throw — agent must see the error).
- **GREEN:** Implement tool def per `FIGMA-API-TOOLS.md:36-65` verbatim.
  Handler `async (args, ctx) => string` (string per `LMSTUDIO-TOOL-API.md:151`
  — `content` must be string), so `JSON.stringify` the flat array.
- **IMPROVE:** Cap response size (e.g. truncate at 500 layers + flag) so a
  giant file doesn't blow LM Studio's context budget.
- **Deps:** T1.

### T3 — `figma_update_token` tool def + handler

- **RED:** `update-token.test.ts`: (a) tool def matches `FIGMA-API-TOOLS.md:118-145`;
  (b) name == "figma_update_token"; (c) handler first calls
  `GET /v1/files/{key}/variables/local`; (d) if token_name matches existing
  variable → POST with `action:"UPDATE"` and resolved `id`; (e) if not found
  → POST with `action:"CREATE"` and `tempId`; (f) color value `{r,g,b,a}` →
  `resolvedType:"COLOR"` mapped correctly; (g) number → `FLOAT`; string → `STRING`;
  (h) 403 → returns `{error:"plan_required", message:"Requires Enterprise plan + file_variables:write scope"}`;
  (i) 413 → returns `{error:"payload_too_large", message:"Split into smaller batches"}`.
- **GREEN:** Implement two-step lookup + POST. POST body per
  `FIGMA-API-TOOLS.md:166-182`. Default `mode_id` to collection's
  `defaultModeId` if omitted (resolved from the same `local` GET).
- **IMPROVE:** Validate `collection_id` exists in `local` response before POST;
  fail fast with a model-readable error rather than relying on Figma 400.
- **Deps:** T1.

### T4 — Conditional tool registration in agentic runner

- **RED:** `index.test.ts` + `lmstudio-agentic.test.ts`:
  (a) `FIGMA_API_TOKEN` unset → `getFigmaTools({})` returns `[]`,
  `getFigmaHandlers({})` returns `{}`;
  (b) `FIGMA_API_TOKEN=figd_xxx` → `getFigmaTools(env).map(t => t.function.name)`
  equals `["figma_list_layers", "figma_update_token"]` exactly;
  (c) runner constructed with `FIGMA_API_TOKEN` unset → runner's tools array
  excludes Figma tools, no startup error, runner works normally;
  (d) runner constructed with token + model emits canned tool_call for
  `figma_list_layers` (mock fetch) → handler invoked exactly once, result
  appended as `{role:'tool', tool_call_id, content:'<json>'}`, loop continues to
  final `finish_reason:'stop'`.
- **GREEN:** Add `getFigmaTools(env): ToolDef[]` returning `[]` when token
  absent; otherwise Phase-1 array. Mirror `getFigmaHandlers(env)`. In
  `LmStudioAgenticRunner` constructor (added by §2 plan), call both, merge into
  runner's tool registry. **Token must never appear in any log line or LLM
  payload** — only in the closure of the client constructor. Verify with a
  log-capture assertion in the test.
- **IMPROVE:** If token present but reaches Figma → 401 on first call (token
  invalid), emit a structured warning once per session into the runner's
  `onStderr` hook (per `WorkerTask.onStderr` `types.ts:13`). Don't disable the
  tools — let the model see the error and decide.
- **Deps:** T2, T3, AND §2's `LmStudioAgenticRunner` shipped.

### T5 — End-to-end integration: agentic loop drives `figma_list_layers`

- **RED:** new test `src/workers/lmstudio-agentic-figma-integration.test.ts`:
  spin up `http.createServer` on ephemeral port as fake LM Studio
  (per AGENTIC-WORKER-PATTERN.md:257-259); script it to return tool_call for
  `figma_list_layers` on turn 1, final response on turn 2. Mock
  `FigmaRestClient.fetchImpl` to return canned `/v1/files/{key}/nodes`
  response. Set `FIGMA_API_TOKEN=test_token`. Run
  `LmStudioAgenticRunner.run({task:"list layers in file XYZ", ...})`. Assert:
  (a) `WorkerResult.status === "success"`;
  (b) `WorkerResult.tool_call_count === 1`;
  (c) `WorkerResult.iterations === 2`;
  (d) `WorkerResult.output` contains the summary text;
  (e) the fake Figma server received exactly one GET with `X-Figma-Token: test_token`.
- **GREEN:** Wire the integration once T1-T4 land. Likely zero new
  implementation — this test asserts the seams composed correctly.
- **IMPROVE:** Add a second scenario where the model calls `figma_list_layers`
  with a bad `file_key` → 404 → tool result contains error → model emits a
  second tool_call with a "corrected" key (canned) → success. Validates that
  errors surface readably to the model.
- **Deps:** T4.

### T6 — Phase 2: `FigmaBridgeServer` WebSocket

- **RED:** `bridge-server.test.ts`: (a) `start({port:0})` binds to a random
  port, returns actual port; (b) accepts one WS connection on `127.0.0.1`;
  (c) rejects second simultaneous connection with close code 1008
  ("policy violation: single client only"); (d) `send({op, args})` returns a
  promise that resolves when client echoes a reply with matching `id`;
  (e) port-scan logic: if `start({port:9223})` hits `EADDRINUSE`, retries
  9224, 9225, ... up to 9232, then throws `BRIDGE_PORTS_EXHAUSTED`;
  (f) `close()` terminates client connections cleanly and stops accepting.
- **GREEN:** Implement with `ws` package (already a transitive dep — verify
  in `package.json`; if not, use the built-in `node:http` upgrade + minimal
  framing or pin `ws@^8`). Loopback-only bind. UUIDv4 for `id` correlation
  (use `node:crypto.randomUUID`). Per-call timeout default 10s.
- **IMPROVE:** Heartbeat ping every 30s; if no pong in 60s, mark client
  disconnected and surface to next tool invocation as
  `BRIDGE_DISCONNECTED`.
- **Deps:** T5 (Phase 1 fully landed first).

### T7 — Phase 2: Figma plugin source

- **RED:** `figma-plugin/code.test.ts` (optional — see "Phase 2 tests" note).
  If included: instantiate plugin code in a mock Figma globals environment
  (`figma = {currentPage:{selection:[]}, createComponent: () => ...}`) and
  assert request handling.
- **GREEN:** Author `figma-plugin/code.ts` (~150 LoC) per
  `FIGMA-API-TOOLS.md:218-227,263-268,322-326`. WS client: connect to
  `ws://127.0.0.1:9223`, on fail try 9224..9232. On message: parse envelope,
  dispatch to `figma.*`, reply. Author `manifest.json` (editor: `figma` only),
  `ui.html` (status), `build.sh`. Manual install instructions in `README.md`.
- **IMPROVE:** Reconnect-on-disconnect with exponential backoff (1s, 2s, 4s,
  capped at 30s). Display connection state in `ui.html`.
- **Deps:** T6 (so plugin has a server to connect to during manual smoke test).

### T8 — Phase 2: `figma_get_selection` + `figma_create_component` tools

- **RED:** `get-selection.test.ts` + `create-component.test.ts`:
  (a) tool defs match `FIGMA-API-TOOLS.md:298-314,229-253`;
  (b) handler with mocked bridge returning `{selection:[...]}` → tool returns
  same JSON-stringified;
  (c) bridge offline (mock throws `BRIDGE_UNAVAILABLE`) → handler returns
  `{error:"bridge_unavailable", message:"Component creation requires Figma Desktop with Relay Bridge running. Install: figma-plugin/README.md"}`;
  (d) wrong-editor error from plugin (`figma.editorType !== "figma"`) →
  surfaces verbatim;
  (e) update `getFigmaTools(env)` to also gate on bridge availability:
  **token-only env** → 2 tools; **token + bridge probe succeeds** → 4 tools.
  Probe is lazy (on first invocation), cached for session.
- **GREEN:** Implement both handlers as thin wrappers around
  `bridgeServer.send({op:..., args:...})`. Add bridge-probe logic to
  `getFigmaTools`: check `bridgeServer.isClientConnected()` (returns false if
  server not started yet — that's expected; tools auto-start server on first
  use). Decision: register all 4 tools when token set; let each Phase-2 tool
  fail with `BRIDGE_UNAVAILABLE` if bridge not connected at call time. **This
  is the recommended path** — registering only when bridge probe succeeds
  creates a race (plugin starts after runner construction). The model sees the
  tool, tries to use it, gets a clear error, asks the user to start the plugin.
  Per `FIGMA-API-TOOLS.md:286`: "Do not silently succeed".
- **IMPROVE:** Tool def descriptions explicitly mention "Requires Figma Desktop
  + Relay Bridge plugin" so the model self-selects only when appropriate.
- **Deps:** T6, T7.

### T9 — Phase 2: bridge integration test

- **RED:** `bridge-integration.test.ts`: start real `FigmaBridgeServer` on
  ephemeral port; spin up mock plugin client (in-process WS using `ws` client)
  that handles `op:"getSelection"` by replying with a canned selection. Run
  `LmStudioAgenticRunner` with token + bridge active; model emits
  `tool_call:figma_get_selection`; assert full round-trip: model → runner →
  bridge → mock plugin → bridge → runner → model → final response.
- **GREEN:** Likely zero new code — composes T6/T7/T8.
- **IMPROVE:** Add a scenario where the mock plugin disconnects mid-loop →
  next call returns `BRIDGE_DISCONNECTED` → model handles gracefully.
- **Deps:** T8.

### Parallelisability

- T1 strictly first.
- T2 || T3 (different handlers, both depend only on T1).
- T4 depends on T2 + T3 + §2 runner.
- T5 strictly serial after T4.
- T6 || T7 (server and plugin client can be authored in parallel; integration in T9).
- T8 after T6 + T7.
- T9 strictly serial after T8.

---

## Acceptance criteria — Phase 1 (blocking ship)

All must hold simultaneously, verified via `npm test`:

1. With `FIGMA_API_TOKEN` **unset**: `LmStudioAgenticRunner` instantiates
   without error; `runner.run({task:"hello", ...})` succeeds end-to-end; no
   Figma tools appear in the `tools` array passed to LM Studio.
2. With `FIGMA_API_TOKEN` **set** + valid: `figma_list_layers` callable;
   `figma_update_token` callable; both return correctly shaped JSON; 4xx/5xx
   errors return structured error objects to the model (never throw out of the
   handler).
3. Integration test (T5) passes: `LmStudioAgenticRunner` + mock LM Studio +
   mock Figma server completes a 2-turn loop driving `figma_list_layers`.
4. Token never appears in logs (assert via test log capture) or in any LLM
   payload (assert via test inspection of POST bodies sent to mock LM Studio).
5. `DISABLED_CODEX_MCP_LABELS` at `src/workers/codex.ts:72` **unchanged** —
   Figma remains disabled for the Codex MCP path.
6. `tsc --noEmit` passes with zero errors.
7. Rate-limit handling: T1 test (d) proves 429 + `Retry-After` triggers
   exactly one retry, then succeeds.
8. Enterprise-plan failure: T3 test (h) proves 403 from `update_token`
   surfaces as `{error:"plan_required", message:"Requires Enterprise plan + file_variables:write scope"}`
   to the model (not as a thrown exception).

## Acceptance criteria — Phase 2 (deferable, ships when ready)

1. `FigmaBridgeServer` binds to `127.0.0.1:9223` (or fallback 9224-9232);
   accepts exactly one client; correlates request/response by UUID.
2. Figma plugin (`figma-plugin/`) compiles via `figma-plugin/build.sh`;
   installable via Figma Desktop dev mode; connects to bridge on launch.
3. With bridge connected: `figma_get_selection` returns current selection;
   `figma_create_component` creates a new component and returns
   `{node_id, key, url}`.
4. With bridge offline: both Phase-2 tools return
   `{error:"bridge_unavailable", message:"...install instructions..."}` — no
   thrown exceptions, no silent fallback.
5. Bridge integration test (T9) passes: full agentic round-trip across
   real WS + mock plugin.
6. Phase-1 tools still work when Phase-2 bridge is offline (regression check).

---

## Runtime validation

### Phase 1

```bash
# Pre-req: §2 (agentic runner) shipped; LM Studio running with qwen3-coder-next loaded
lms ls | grep qwen3-coder-next                       # confirm model present
lms load qwen/qwen3-coder-next
export FIGMA_API_TOKEN="figd_xxxxxxxxxxxxx"          # personal access token

# Smoke: list layers
relay run --provider lmstudio --model qwen/qwen3-coder-next \
  --task "List the layers in Figma file abc123 (file_key only, no page id). Use figma_list_layers."
# expected: tool_call fires, JSON returned, model summarizes layer count + names

# Smoke: update token (skip if no Enterprise file)
relay run --provider lmstudio --model qwen/qwen3-coder-next \
  --task "Set the color/primary token in file abc123 collection VariableCollectionId:1:0 to {r:0.2,g:0.4,b:0.9,a:1}."
# expected: tool_call fires; 403 surfaces cleanly if not Enterprise

# Negative: unset token
unset FIGMA_API_TOKEN
relay run --provider lmstudio --task "List layers in Figma file abc123."
# expected: runner starts, model has NO figma tools, replies that it cannot help
```

Confirm logs (`~/.relay/logs/`) contain no occurrences of the token literal:
```bash
grep -r "figd_" ~/.relay/logs/ && echo "LEAK" || echo "OK"
```

### Phase 2

```bash
# 1. Build plugin
cd figma-plugin && ./build.sh

# 2. Install in Figma Desktop:
#    Plugins → Development → Import plugin from manifest → select manifest.json

# 3. Start Relay (bridge auto-starts on first Phase-2 tool call)
export FIGMA_API_TOKEN="figd_..."
relay run --provider lmstudio --model qwen/qwen3-coder-next \
  --task "Get my current selection in Figma. Use figma_get_selection (file_key abc123)."

# 4. In Figma Desktop: open file abc123, select a frame, run Relay Bridge plugin
# 5. Re-trigger relay run; should now return selection

# Create component smoke:
relay run --provider lmstudio --model qwen/qwen3-coder-next \
  --task "Create a 120x40 component named PrimaryButton in file abc123 using figma_create_component."
# expected: tool fires, component appears in Figma, URL returned

# Negative: kill plugin, retry — model should receive BRIDGE_UNAVAILABLE
```

---

## Risk register

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Variables API requires Enterprise — solo dev on Pro plan can't write tokens | HIGH | LOW | Tool defs explicitly state requirement (`FIGMA-API-TOOLS.md:114-115`). 403 returns a clear `plan_required` error to the model (T3 test h). Document as "tool is registered but will 403 on non-Enterprise files." |
| R2 | Figma rate limits (6000 req/h org-wide; Tier-1 endpoints 10-20/min per user — `FIGMA-API-TOOLS.md:72`) | MEDIUM | MEDIUM | T1 implements single retry honoring `Retry-After`. Document the limit in tool description so the model paces itself. Long term: token bucket (defer). |
| R3 | Bridge port 9223 + fallback range conflict with another local service | LOW | LOW | Scan 9223-9232 (10 ports). Document override env (e.g. `RELAY_FIGMA_BRIDGE_PORT_BASE`) if needed (defer). |
| R4 | Plugin install friction (manual via Figma Desktop dev mode) | HIGH | LOW | Document loudly in `figma-plugin/README.md` and Relay README. Phase 1 ships without plugin so REST tools work day-1. |
| R5 | `FIGMA_API_TOKEN` leaked to logs or LLM payload | LOW | HIGH | T4 test (c) asserts log absence + payload absence. Token lives only in `FigmaRestClient` closure. Never passed to handler `args` (which the model sees). |
| R6 | Qwen3-Coder-Next drops `<tool_call>` tag on some templates (`LMSTUDIO-TOOL-API.md:220`) | MEDIUM | MEDIUM | Out of scope for this plan — §2's agentic runner is responsible for malformed-tool-call detection. Reuse its loop-detector. |
| R7 | Plugin API surface changes break the plugin (Figma versions silently) | LOW | MEDIUM | Pin plugin manifest `api: "1.0.0"`. Plugin uses minimal surface (`createComponent`, `currentPage.selection`, `appendChild`, `resize`) — stable for years. |
| R8 | Loopback WS server bind exposes RCE if a malicious local process connects first | LOW | HIGH | Single-client policy (T6 c) prevents hijack mid-session. Envelope is whitelist-only — `op` must be one of 2 known values, args validated against schema. No `eval`, no arbitrary file paths. Bind to `127.0.0.1` only (not `0.0.0.0`). |
| R9 | Variables API atomicity — partial batch failure leaves inconsistent state | LOW | MEDIUM | Per `FIGMA-API-TOOLS.md:154`: API is atomic per request. T3 happy path is single-variable updates only; multi-variable batching deferred. |
| R10 | FigJam files break `figma_create_component` (Design-only per `FIGMA-API-TOOLS.md:282`) | MEDIUM | LOW | Plugin manifest restricts to `editorType:["figma"]`; if user runs in FigJam, plugin doesn't load → bridge unavailable → clean error. |
| R11 | Two plans (this + §2) modify `lmstudio-agentic.ts` → merge conflict | MEDIUM | LOW | T4 modifies only the constructor's tool-registry insertion point. §2 plan reserves a clearly-named seam (e.g. `this.toolRegistry = mergeRegistries(...)`). Coordinate via shared interface defined in §2 plan. |
| R12 | Phase 1 ships, Phase 2 never ships → 2 of 4 tools missing forever | LOW | LOW | Phase 1 is the working subset. Document in README that Phase 2 is "additive when bridge built." No regression risk to Phase 1 from Phase-2 delay. |

---

*End PLAN-6 — Figma integration. ~440 lines.*
