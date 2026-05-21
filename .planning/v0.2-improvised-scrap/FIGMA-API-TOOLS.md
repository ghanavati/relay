# Figma API Tools — Relay v0.2 ROADMAP #6

**Researched:** 2026-05-18
**Domain:** Figma REST API + Plugin API bridge architecture
**Confidence:** HIGH (all claims cited to developers.figma.com)

## Summary

Relay v0.2 ROADMAP #6 calls for 4 agentic Figma tools. Honest finding after researching the official docs: **only 2 of the 4 are achievable via REST alone**. The other 2 require the **Plugin API**, which only runs inside the Figma editor. The standard pattern (used by figma-console-mcp and similar bridges) is a **WebSocket Desktop Bridge plugin** that the local Relay runner connects to.

| Tool | REST-only? | Mechanism |
|------|-----------|-----------|
| `figma_list_layers` | YES | GET /v1/files/{key}/nodes |
| `figma_update_token` | YES (Enterprise plan) | POST /v1/files/{key}/variables |
| `figma_create_component` | NO | Plugin API via WS bridge |
| `figma_get_selection` | NO | Plugin API via WS bridge |

**Primary recommendation:** Ship the 2 REST tools first (no bridge dependency), then layer the Desktop Bridge plugin for the other 2. Do **not** pretend the Plugin-API tools work over REST — they will silently fail or return 404.

## Auth

All REST endpoints use header:

```
X-Figma-Token: <personal-access-token>
```

Env var convention for Relay runner: `FIGMA_API_TOKEN` (read at startup, fail fast if missing). PATs are per-user, per-plan, per-token for rate-limit accounting ([Rate Limits](https://developers.figma.com/docs/rest-api/rate-limits/)). OAuth2 is supported but adds a token-refresh dependency — defer to v0.3.

Base URL: `https://api.figma.com`

---

## Tool 1: `figma_list_layers` (REST — works today)

### JSON Schema

```json
{
  "type": "function",
  "function": {
    "name": "figma_list_layers",
    "description": "Return a flat layer tree for a Figma page. Read-only. Uses the GET file nodes endpoint with depth=infinity. Safe for any plan tier.",
    "parameters": {
      "type": "object",
      "properties": {
        "file_key": {
          "type": "string",
          "description": "Figma file key (the segment after /file/ in the Figma URL)"
        },
        "page_id": {
          "type": "string",
          "description": "Node ID of the page (CANVAS node). If omitted, returns layers from the document root."
        },
        "depth": {
          "type": "integer",
          "description": "Tree traversal depth. Omit for full tree.",
          "minimum": 1
        }
      },
      "required": ["file_key"]
    }
  }
}
```

### Endpoint

- `GET /v1/files/{file_key}/nodes?ids={page_id}&depth={depth}` when `page_id` provided
- `GET /v1/files/{file_key}?depth={depth}` when `page_id` omitted
- Auth: `X-Figma-Token: <pat>`
- Tier 1 endpoint (10-20/min for Dev/Full seats per [Rate Limits](https://developers.figma.com/docs/rest-api/rate-limits/))

### Sample Cycle

Request:
```
GET /v1/files/abc123/nodes?ids=0:1&depth=3
X-Figma-Token: figd_xxx
```

Response (excerpt — flattened to layer tree by Relay):
```json
{
  "nodes": {
    "0:1": {
      "document": {
        "id": "0:1", "name": "Page 1", "type": "CANVAS",
        "children": [
          {"id": "1:23", "name": "Header", "type": "FRAME", "children": [...]}
        ]
      }
    }
  }
}
```

Relay post-processes into a flat `{id, name, type, parent_id, depth}` list.

### Failure Modes

| Status | Cause | Relay action |
|--------|-------|--------------|
| 400 | invalid `ids` param | return error to model with hint |
| 403 | token invalid/expired | abort, prompt user to refresh PAT |
| 404 | file_key wrong or no access | return "file not found" |
| 429 | rate-limited | read `Retry-After` header, sleep, retry once |
| 500 | very large file | retry with smaller `depth` |

Reference: [File Endpoints](https://developers.figma.com/docs/rest-api/file-endpoints/), [Errors](https://developers.figma.com/docs/rest-api/errors/)

---

## Tool 2: `figma_update_token` (REST — Enterprise plan only)

### JSON Schema

```json
{
  "type": "function",
  "function": {
    "name": "figma_update_token",
    "description": "Create or update a design token (Figma variable). Requires Enterprise plan and file_variables:write scope. Tokens are scoped to a variable collection. Supports color, number (spacing), and string (typography names) types.",
    "parameters": {
      "type": "object",
      "properties": {
        "file_key": {"type": "string"},
        "token_name": {"type": "string", "description": "Variable name, unique within collection"},
        "value": {
          "description": "Color object {r,g,b,a} (0-1 floats), number (spacing/radius), or string (typography family)",
          "oneOf": [
            {"type": "object", "properties": {"r": {"type": "number"}, "g": {"type": "number"}, "b": {"type": "number"}, "a": {"type": "number"}}},
            {"type": "number"},
            {"type": "string"}
          ]
        },
        "type": {"type": "string", "enum": ["color", "spacing", "typography"]},
        "collection_id": {"type": "string", "description": "variableCollectionId from GET local variables"},
        "mode_id": {"type": "string", "description": "modeId within the collection (default: collection's defaultModeId)"}
      },
      "required": ["file_key", "token_name", "value", "type", "collection_id"]
    }
  }
}
```

### Endpoint

- `POST /v1/files/{file_key}/variables`
- Auth: `X-Figma-Token: <pat>` with `file_variables:write` scope
- Tier 2 endpoint
- **Requires Enterprise plan, full-seat member or admin, edit access on file** per [Variables API](https://developers.figma.com/docs/rest-api/variables/)
- Atomic: all-or-nothing per request; 4 MB max body

### Type → resolvedType Mapping

| Tool `type` | Figma `resolvedType` | Value shape |
|-------------|---------------------|-------------|
| color | `COLOR` | `{r, g, b, a}` floats 0-1 |
| spacing | `FLOAT` | number (px) |
| typography | `STRING` | string (font family name) |

Note: Figma variables don't support a single composite "typography" token — for full typography styles use the separate Styles API (read-only via REST). `figma_update_token` with `type="typography"` should set the font-family STRING variable only; document this limitation in the tool description shown to the model.

### Sample Cycle

Request:
```
POST /v1/files/abc123/variables
X-Figma-Token: figd_xxx
Content-Type: application/json

{
  "variables": [
    {"action": "UPDATE", "id": "VariableID:1:23", "name": "color/primary"}
  ],
  "variableModeValues": [
    {"variableId": "VariableID:1:23", "modeId": "1:0",
     "value": {"r": 0.2, "g": 0.4, "b": 0.9, "a": 1.0}}
  ]
}
```

Response:
```json
{
  "status": 200, "error": false,
  "meta": {"tempIdToRealId": {}}
}
```

For **create** vs **update**: Relay first calls `GET /v1/files/{key}/variables/local`, looks up by name, then sends `action: "CREATE"` with `tempId` or `action: "UPDATE"` with existing `id`.

### Failure Modes

| Status | Cause | Relay action |
|--------|-------|--------------|
| 400 | validation (name dup, value type mismatch, mode missing) | return error with diff |
| 403 | not Enterprise plan, or no `file_variables:write` scope, or no file edit access | abort, surface plan requirement to user |
| 404 | file_key wrong | return error |
| 413 | body > 4 MB | split into multiple calls |
| 429 | rate-limited | Retry-After backoff |

Post-update note: **variables must be published** before they're usable in other files (separate publish call, defer to v0.3) — [Variables Overview](https://developers.figma.com/docs/rest-api/variables/).

---

## Tool 3: `figma_create_component` (Plugin API only — bridge required)

### Honest assessment

**The Figma REST API has zero CREATE endpoints for nodes or components.** All component endpoints (`/v1/files/{key}/components`, `/v1/teams/{id}/components`, `/v1/components/{key}`) are GET-only ([Component Endpoints](https://developers.figma.com/docs/rest-api/component-endpoints/)). Creation is exclusively `figma.createComponent()` in the [Plugin API](https://developers.figma.com/docs/plugins/api/properties/figma-createcomponent/), which returns `ComponentNode` and **only runs in Figma Design (not FigJam) inside the editor process**.

### Architecture (recommended)

Mirror the pattern used by [figma-console-mcp](https://github.com/southleft/figma-console-mcp):

```
Relay agent ── WebSocket (port 9223) ── Figma Desktop Bridge plugin ── Plugin API
```

1. User installs a small "Relay Bridge" Figma plugin (one-time, ~50 lines TS) and runs it in Figma Desktop.
2. Plugin opens WS server on 9223 (with 9224-9232 fallback range).
3. Relay runner connects, sends serialized command, plugin executes against `figma.*`, returns result.
4. Plugin only needs `figma.createComponent`, `appendChild`, basic resize — keep surface tiny.

### JSON Schema (presented to the model identically regardless of transport)

```json
{
  "type": "function",
  "function": {
    "name": "figma_create_component",
    "description": "Create a new empty component in a Figma Design file. Requires Figma Desktop running with Relay Bridge plugin active. Returns the new node's ID and shareable URL.",
    "parameters": {
      "type": "object",
      "properties": {
        "name": {"type": "string"},
        "description": {"type": "string"},
        "file_key": {"type": "string", "description": "Used to verify the bridge is pointed at the right file"},
        "frame_id": {"type": "string", "description": "Optional: parent frame node ID to nest component inside"},
        "coords": {
          "type": "object",
          "properties": {"x": {"type": "number"}, "y": {"type": "number"}}
        },
        "width": {"type": "number", "default": 100},
        "height": {"type": "number", "default": 100}
      },
      "required": ["name", "file_key"]
    }
  }
}
```

### Bridge command (sent over WS)

```json
{"op": "createComponent", "args": {"name": "PrimaryButton", "width": 120, "height": 40, "parent": "1:23"}}
```

Plugin executes:
```typescript
const c = figma.createComponent();
c.name = args.name;
c.resize(args.width, args.height);
if (args.parent) (figma.getNodeById(args.parent) as FrameNode).appendChild(c);
return {node_id: c.id, key: c.key};
```

Returns to Relay:
```json
{"node_id": "1:42", "key": "abc...", "url": "https://figma.com/file/abc123?node-id=1-42"}
```

### Failure Modes

| Condition | Symptom | Relay action |
|-----------|---------|--------------|
| Bridge not running | WS connect refused on 9223-9232 | return `BRIDGE_UNAVAILABLE` error with install instructions |
| Wrong file open in Figma | file_key mismatch with `figma.fileKey` | abort, tell user to open correct file |
| FigJam editor | `figma.editorType !== "figma"` | abort, `createComponent` unsupported |
| Plugin permission denied | thrown from `figma.createComponent` | surface error verbatim |

### Fallback if bridge unavailable

Return a structured `NOT_AVAILABLE` error telling the model: "Component creation requires Figma Desktop with Relay Bridge running. Suggest user open Figma Desktop and run the bridge plugin, or use `figma_list_layers` for read-only inspection." Do not silently succeed — silent fallback corrupts the agent's world model.

---

## Tool 4: `figma_get_selection` (Plugin API only — bridge required)

### Honest assessment

**No REST endpoint exists for current selection.** Selection is per-page editor state (`PageNode.selection`), accessible only via the Plugin API. The Figma forum [confirms this is plugin-only](https://forum.figma.com/t/selection-event-api/21297) — there is no `/v1/files/{key}/selection` endpoint and none planned as of 2026-05.

### JSON Schema

```json
{
  "type": "function",
  "function": {
    "name": "figma_get_selection",
    "description": "Return currently selected nodes in the active Figma file. Requires Figma Desktop with Relay Bridge plugin running.",
    "parameters": {
      "type": "object",
      "properties": {
        "file_key": {"type": "string"},
        "page_id": {"type": "string", "description": "Optional: query selection on a specific page (default: current page)"}
      },
      "required": ["file_key"]
    }
  }
}
```

### Bridge command

```json
{"op": "getSelection", "args": {"page_id": null}}
```

Plugin executes:
```typescript
const page = args.page_id ? figma.getNodeById(args.page_id) as PageNode : figma.currentPage;
return page.selection.map(n => ({id: n.id, name: n.name, type: n.type, x: n.x, y: n.y, width: n.width, height: n.height}));
```

Returns:
```json
{"selection": [{"id": "1:42", "name": "PrimaryButton", "type": "COMPONENT", "x": 100, "y": 200, "width": 120, "height": 40}]}
```

### Failure Modes

Same as `figma_create_component`: bridge unavailable, wrong file, wrong editor type. Empty selection is **not** an error — return `{"selection": []}`.

---

## Full Agentic Loop Trace

User: *"Create a button component named PrimaryButton in the current file."*

1. Model emits tool_call:
   ```json
   {"name": "figma_create_component",
    "arguments": {"name": "PrimaryButton", "file_key": "abc123", "width": 120, "height": 40}}
   ```
2. Relay checks `FIGMA_API_TOKEN` (for REST tools) and WS bridge availability on port 9223.
3. Bridge available → Relay sends `{"op": "createComponent", "args": {...}}` over WS.
4. Figma Desktop Bridge plugin executes `figma.createComponent()`, sets name, resizes, returns:
   ```json
   {"node_id": "1:42", "key": "abc...", "url": "https://figma.com/file/abc123?node-id=1-42"}
   ```
5. Relay forwards tool_result to model.
6. Model summarizes to user: *"Created PrimaryButton component (120×40). Open in Figma: https://figma.com/file/abc123?node-id=1-42"*

If bridge **not** running, step 3 fails with `BRIDGE_UNAVAILABLE`, model receives the error, and per its system prompt should tell the user to start Figma Desktop + Relay Bridge plugin.

---

## Implementation Order (v0.2)

1. **Week 1:** Ship `figma_list_layers` + `figma_update_token` (pure REST). Validate auth, rate-limit handling, error mapping.
2. **Week 2:** Build the Relay Bridge plugin (~150 LoC TypeScript, single file). Manifest declares no special permissions beyond default.
3. **Week 3:** Wire WS client in Relay runner with port-scan fallback (9223 → 9232). Ship `figma_create_component` + `figma_get_selection`.
4. **Document loudly** in Relay README that 2 tools require Figma Desktop. Do not market all 4 as "REST-based."

## Sources

- [Figma REST API Introduction](https://developers.figma.com/docs/rest-api/) — base URL, auth methods
- [File Endpoints](https://developers.figma.com/docs/rest-api/file-endpoints/) — GET file/nodes signatures
- [Variables REST API](https://developers.figma.com/docs/rest-api/variables/) — Enterprise restriction, scopes
- [Variables Endpoints](https://developers.figma.com/docs/rest-api/variables-endpoints/) — POST body schema, tempIdToRealId
- [Component Endpoints](https://developers.figma.com/docs/rest-api/component-endpoints/) — confirmed READ-ONLY
- [Rate Limits](https://developers.figma.com/docs/rest-api/rate-limits/) — tier definitions, Retry-After
- [Errors](https://developers.figma.com/docs/rest-api/errors/) — 400/403/404/429/500
- [Plugin API: createComponent](https://developers.figma.com/docs/plugins/api/properties/figma-createcomponent/) — Figma Design only
- [Plugin API: PageNode.selection](https://developers.figma.com/docs/plugins/api/properties/PageNode-selection/) — plugin-only confirmation
- [figma-console-mcp](https://github.com/southleft/figma-console-mcp) — WS bridge reference architecture
- [Figma Forum: Selection event API](https://forum.figma.com/t/selection-event-api/21297) — no REST equivalent

## Confidence

| Claim | Level | Basis |
|-------|-------|-------|
| Components creation requires Plugin API | HIGH | Explicit in component-endpoints docs + createComponent docs |
| Selection requires Plugin API | HIGH | PageNode.selection docs + forum confirmation |
| Variables POST requires Enterprise | HIGH | Stated in variables/ overview page |
| Rate limit tiers and Retry-After | HIGH | rate-limits/ docs |
| Bridge architecture is the standard pattern | MEDIUM | One reference impl (figma-console-mcp); pattern is sound but not "official" |
| 100×100 default component size | HIGH | createComponent docs |
