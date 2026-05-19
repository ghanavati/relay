---
phase: 07-figma-rest-tools
plan: 01
type: tdd
wave: 1
depends_on: ["03-agentic-lmstudio-runner"]
files_modified:
  - src/tools/figma/index.ts
  - src/tools/figma/pat-loader.ts
  - src/tools/figma/scrub.ts
  - src/tools/figma/rest-client.ts
  - src/tools/figma/list-layers.ts
  - src/tools/figma/update-token.ts
  - src/tools/figma/__tests__/pat-loader.test.ts
  - src/tools/figma/__tests__/scrub.test.ts
  - src/tools/figma/__tests__/rest-client.test.ts
  - src/tools/figma/__tests__/list-layers.test.ts
  - src/tools/figma/__tests__/update-token.test.ts
  - src/tools/figma/__tests__/registry.test.ts
  - src/workers/lmstudio-agentic.ts
  - src/cli/cmd-doctor.ts
  - src/cli/cmd-doctor.test.ts
autonomous: true
requirements: [FIGMA-01, FIGMA-02, FIGMA-03, FIGMA-04, FIGMA-05]
user_setup:
  - service: figma
    why: "REST API access for layer reads + variable writes via X-Figma-Token header"
    env_vars:
      - name: FIGMA_API_TOKEN
        source: "Figma Settings → Account → Personal access tokens (scope: file_read + file_variables:write for Enterprise)"
    dashboard_config:
      - task: "Write PAT to ~/.relay/secrets/figma.json with chmod 600 (NOT .env, NOT shell rc)"
        location: "Local filesystem"
      - task: "Bind workdir to file_key via <workdir>/.relay/figma.json (per-project, gitignored)"
        location: "Local workdir"

must_haves:
  truths:
    - "User with FIGMA_API_TOKEN sees figma_list_layers + figma_update_token in agentic runner's tools[]"
    - "User without FIGMA_API_TOKEN sees ZERO Figma tools registered (no startup error, no model exposure)"
    - "User invoking figma_list_layers receives flat layer tree via GET /v1/files/{key}/nodes with X-Figma-Token header"
    - "User on non-Enterprise plan calling figma_update_token receives PLAN_REQUIRED structured result (not crash, not silent success)"
    - "User on Enterprise plan calling figma_update_token writes via POST /v1/files/{key}/variables and gets node ID"
    - "User hitting Figma 429 sees tool sleep on Retry-After, retry once, then hard-error (model never sees raw 429)"
    - "User grepping any Relay debug log for 'figd_' finds only 'figd_***SCRUBBED***' — never raw PAT"
    - "User runs 'relay doctor --figma' and sees: token presence, plan tier (200/403), sample REST call"
    - "User runs 'relay doctor --figma' and sees figma_get_selection + figma_create_component listed as deferred-to-v0.3"
  artifacts:
    - path: "src/tools/figma/pat-loader.ts"
      provides: "loadPat(env, homeDir) + loadWorkdirFileKey(workdir); chmod-600 enforcement; returns null when absent"
      min_lines: 40
    - path: "src/tools/figma/scrub.ts"
      provides: "scrubPat / scrubHeaders / scrubError — pure regex masking figd_* → figd_***SCRUBBED***"
      min_lines: 25
    - path: "src/tools/figma/rest-client.ts"
      provides: "figmaGet/figmaPost native-fetch wrapper; X-Figma-Token header; 429 Retry-After backoff one-retry; typed errors; PAT scrub on every error path"
      min_lines: 80
    - path: "src/tools/figma/list-layers.ts"
      provides: "LIST_LAYERS_DEF + handleListLayers; GET /v1/files/{key}/nodes (or root); flatten to {id,name,type,parent_id,depth}[]"
      min_lines: 60
    - path: "src/tools/figma/update-token.ts"
      provides: "UPDATE_TOKEN_DEF + handleUpdateToken; GET local → POST variables; type→resolvedType map; graceful PLAN_REQUIRED return"
      min_lines: 80
    - path: "src/tools/figma/index.ts"
      provides: "registerFigmaTools(env)→FigmaToolHandler[]|null; DEFERRED_FIGMA_TOOLS readonly list for doctor/help"
      min_lines: 40
    - path: "src/workers/lmstudio-agentic.ts"
      provides: "DELTA only — additive registerFigmaTools(process.env) merge into tools[] at construction"
      contains: "registerFigmaTools"
    - path: "src/cli/cmd-doctor.ts"
      provides: "DELTA — --figma flag: PAT check + plan-tier (GET /v1/me) + sample REST + DEFERRED_FIGMA_TOOLS render"
      contains: "--figma"
  key_links:
    - from: "src/workers/lmstudio-agentic.ts"
      to: "src/tools/figma/index.ts:registerFigmaTools"
      via: "import + invocation at worker construction (env-gated)"
      pattern: "registerFigmaTools\\(process\\.env\\)"
    - from: "src/tools/figma/list-layers.ts"
      to: "src/tools/figma/rest-client.ts:figmaGet"
      via: "all REST routes through wrapper (retry + scrub)"
      pattern: "figmaGet\\("
    - from: "src/tools/figma/update-token.ts"
      to: "src/tools/figma/rest-client.ts:figmaPost"
      via: "POST routes through wrapper; 403 mapped to PLAN_REQUIRED"
      pattern: "figmaPost\\("
    - from: "src/tools/figma/rest-client.ts"
      to: "src/tools/figma/scrub.ts:scrubPat"
      via: "every error message + log line passes scrub before emission"
      pattern: "scrubPat\\("
    - from: "src/cli/cmd-doctor.ts"
      to: "src/tools/figma/rest-client.ts + src/tools/figma/index.ts"
      via: "doctor probe reuses client; deferred names read from DEFERRED_FIGMA_TOOLS"
      pattern: "--figma"
---

<objective>
Ship two REST-only Figma tools (`figma_list_layers`, `figma_update_token`) wired into the Phase 3 `lmstudio-agentic` worker, plus a `relay doctor --figma` probe. FIGMA-05 plugin-bridge tools (`figma_get_selection`, `figma_create_component`) are explicitly DEFERRED to v0.3 and surfaced as such — declaratively absent, not silently broken.

Purpose: enable local LM Studio models to read Figma layer trees and write design tokens (Enterprise tier) via REST. Closes Phase 7 in v0.2 ROADMAP.

Output: 2 ToolDef-shaped tools registered conditionally on `FIGMA_API_TOKEN`; rate-limit + 403 + PAT-scrub guards baked in; doctor probe; full TDD coverage.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/ROADMAP.md
@.planning/REQUIREMENTS.md
@.planning/research/SUMMARY.md
@.planning/research/PITFALLS.md
@.planning/v0.2-improvised-scrap/FIGMA-API-TOOLS.md

# Phase 3 contracts this plan depends on:
@src/workers/types.ts        # ToolDef, ToolCall — shipped (types.ts:7-30)
@src/workers/runner.ts       # ExecutionModel union — shipped
@src/workers/lmstudio-agentic.ts  # Phase 3 output — BLOCKS this phase; do NOT start until Phase 3 ships
@src/cli/cmd-doctor.ts       # existing doctor surface — extend with --figma

<interfaces>
<!-- Stable from Phase 3 (verified at src/workers/types.ts:7-30 during planning). -->

```typescript
// from src/workers/types.ts
export interface ToolFunctionDef { name: string; description?: string; parameters?: Record<string, unknown>; }
export interface ToolDef { type: "function"; function: ToolFunctionDef; }
export interface ToolCall { id: string; type: "function"; function: { name: string; arguments: string }; }
```

```typescript
// CONTRACT THIS PLAN PRODUCES (consumed by Phase 3 worker)
// src/tools/figma/index.ts
export interface FigmaToolHandler {
  def: ToolDef;
  handle: (args: unknown, ctx: { workdir: string; pat: string }) => Promise<unknown>;
}
export function registerFigmaTools(env: NodeJS.ProcessEnv): FigmaToolHandler[] | null;
//   null when FIGMA_API_TOKEN missing (FIGMA-03 graceful absence)
//   2-tool array when present
export const DEFERRED_FIGMA_TOOLS: readonly ["figma_get_selection", "figma_create_component"];
//   FIGMA-05 declarative deferral — surfaced by cmd-doctor + --help
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1 (T1+T2): PAT loader + scrubber (foundation)</name>
  <files>src/tools/figma/pat-loader.ts, src/tools/figma/scrub.ts, src/tools/figma/__tests__/pat-loader.test.ts, src/tools/figma/__tests__/scrub.test.ts</files>
  <behavior>
    pat-loader.ts:
      - loadPat(env, homeDir): env.FIGMA_API_TOKEN first; else JSON.parse(readFileSync(`${homeDir}/.relay/secrets/figma.json`)).token
      - Returns null (NOT throws) when neither source has token — FIGMA-03 graceful absence
      - REFUSES to read figma.json when stat.mode allows group/other read; stderr warn "figma.json must be chmod 600"
      - loadWorkdirFileKey(workdir): reads `${workdir}/.relay/figma.json` for {file_key}; null when absent
      - Pure: no network; no logging beyond chmod warn
    scrub.ts:
      - scrubPat(input: string): replaces /figd_[A-Za-z0-9_-]+/g → "figd_***SCRUBBED***"
      - scrubHeaders(headers): returns NEW object with X-Figma-Token masked (never mutates input — per ~/.claude/rules/common/coding-style.md immutability rule)
      - scrubError(err): returns new Error with .message + .stack scrubbed
    Tests: pat-loader 8 cases (env present, env absent + file present, neither, chmod-bad, workdir-file present, workdir-file absent, malformed JSON, empty token). scrub 6 cases (single PAT, multi-occurrence, header object, nested object, multi-line stack, no-PAT no-change).
  </behavior>
  <action>
    RED: write both test files with cases above. Run vitest — all fail.
    GREEN: implement pat-loader.ts with node:fs.readFileSync + statSync (sync IO matches better-sqlite3 convention). Implement scrub.ts as pure regex. NO http client imports.
    Commits (per TDD discipline, ~/.claude/rules/common/testing.md):
      - `test(figma): add failing tests for pat-loader + scrub`
      - `feat(figma): implement pat-loader + PAT scrubbing utility`
  </action>
  <verify>
    <automated>npx vitest run src/tools/figma/__tests__/pat-loader.test.ts src/tools/figma/__tests__/scrub.test.ts</automated>
  </verify>
  <done>Both test files green. `grep -r "figd_" src/tools/figma/__tests__/scrub.test.ts | grep -v "SCRUBBED"` shows test fixtures only, never bare logs. scrub exports 3 pure functions. pat-loader returns null gracefully on dual-absence.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2 (T2 — rest-client): native fetch wrapper with retry + scrubbing</name>
  <files>src/tools/figma/rest-client.ts, src/tools/figma/__tests__/rest-client.test.ts</files>
  <behavior>
    rest-client.ts exports:
      - figmaGet(path, opts:{pat, query?}): Promise<unknown> → GET https://api.figma.com{path}
      - figmaPost(path, body, opts:{pat}): Promise<unknown> → POST same base
      - Both inject `X-Figma-Token: <pat>` (NEVER `Authorization: Bearer`)
      - 429: read Retry-After seconds (clamp 1-60s; ignore HTTP-date format for v0.2 — comment in code), sleep, retry ONCE; second 429 → throw FigmaRateLimitError (PITFALLS 5.4)
      - Status mapping (typed error classes — all exported):
        - 200/201 → parsed JSON body
        - 400 → FigmaBadRequestError(scrubbed message)
        - 403 → FigmaForbiddenError({kind: "PLAN_REQUIRED" | "TOKEN_EXPIRED" | "SCOPE_MISSING" | "FILE_NO_EDIT_ACCESS" | "UNKNOWN"}) — parse body to disambiguate (PITFALLS 5.2)
        - 404 → FigmaNotFoundError
        - 413 → FigmaBodyTooLargeError
        - 429 (post-retry) → FigmaRateLimitError({retryAfterSec})
        - 500 → FigmaServerError
      - EVERY error path: message routed through scrubPat (PITFALLS 5.5; FIGMA-04)
      - NO retry on non-429 statuses (single-attempt — never silent loops)
    Tests (10 cases, vi.spyOn(globalThis,'fetch') + vi.useFakeTimers):
      1) happy GET (header set, 1 call) 2) happy POST (JSON body + content-type)
      3) 429 Retry-After:2 → sleeps ~2s, retries, succeeds on 2nd 4) 429 twice → throws RateLimitError, NO 3rd attempt
      5) 403 body "Enterprise" → kind:PLAN_REQUIRED 6) 403 body "expired" → kind:TOKEN_EXPIRED
      7) 404 → NotFoundError 8) 500 → ServerError, NO retry
      9) error message containing PAT → thrown .message has "figd_***SCRUBBED***" 10) fetch rejects → throws, scrubbed
  </behavior>
  <action>
    RED: write rest-client.test.ts with 10 cases above. Stub via `vi.spyOn(globalThis, 'fetch')`. Run vitest — fail.
    GREEN: implement using native `fetch()` (NO undici/axios/node-fetch — SUMMARY §1 DO-NOT-add). Custom error classes. Sleep via `new Promise(r => setTimeout(r, ms))`.
    REFACTOR (only if): extract `parseForbidden(body): kind` if body matching gets gnarly.
    Commits:
      - `test(figma): add failing tests for REST client (retry, scrub, error mapping)`
      - `feat(figma): implement REST client with Retry-After backoff and PAT scrubbing`
  </action>
  <verify>
    <automated>npx vitest run src/tools/figma/__tests__/rest-client.test.ts</automated>
  </verify>
  <done>10 cases green. `grep -E "import.*(axios|undici|node-fetch)" src/tools/figma/rest-client.ts` empty. No retry on non-429. PAT never appears unscrubbed in any error.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3 (T3 — list-layers): figma_list_layers tool def + handler</name>
  <files>src/tools/figma/list-layers.ts, src/tools/figma/__tests__/list-layers.test.ts, src/tools/figma/__tests__/fixtures/files-nodes-response.json</files>
  <behavior>
    list-layers.ts exports:
      - LIST_LAYERS_DEF: ToolDef matching FIGMA-API-TOOLS.md:38-65 schema (name="figma_list_layers"; params: file_key (req), page_id?, depth?)
      - handleListLayers(args, ctx): Promise<{layers: FlatLayer[]}>
        - Validates args via zod (existing dep — no new validator added; per SUMMARY §1 stack discipline)
        - page_id present → `GET /v1/files/${file_key}/nodes?ids=${page_id}&depth=${depth ?? 'infinity'}`
        - page_id absent → `GET /v1/files/${file_key}?depth=${depth ?? 1}` (default depth=1 at root to avoid huge payloads)
        - Flatten response to `[{id, name, type, parent_id, depth}]` — recursive walk preserving parent_id
        - Errors propagate as-is from rest-client (already typed + scrubbed)
    Tests (8 cases):
      1) valid args + fixture → flattened list with correct parent_id chains 2) missing file_key → zod error
      3) page_id present → URL contains `/nodes?ids=${page_id}` 4) page_id absent → URL `/files/{key}?depth=1`
      5) depth=infinity → URL literal "infinity" when page_id present 6) 404 from REST → FigmaNotFoundError unchanged
      7) empty children → returns just root 8) 5-level nesting → all flattened with correct depth
  </behavior>
  <action>
    RED: write list-layers.test.ts (8 cases). Build fixture `__tests__/fixtures/files-nodes-response.json` from FIGMA-API-TOOLS.md:82-96 shape — VERBATIM copy of documented response (PITFALLS CC.8: fixture-based mocks, never hand-write).
    GREEN: implement list-layers.ts. Recursive flatten as non-exported helper `flatten(node, parentId, depth)`. Handler shape matches FigmaToolHandler contract.
    REFACTOR (only if): iterative flatten if recursion blows stack on deep trees.
    Commits:
      - `test(figma): add failing tests for figma_list_layers tool`
      - `feat(figma): implement figma_list_layers handler with tree flattening`
  </action>
  <verify>
    <automated>npx vitest run src/tools/figma/__tests__/list-layers.test.ts</automated>
  </verify>
  <done>8 cases green. Fixture exists matching FIGMA-API-TOOLS.md:82-96. LIST_LAYERS_DEF.function.name === "figma_list_layers". All REST routes through figmaGet (no direct fetch in handler).</done>
</task>

<task type="auto" tdd="true">
  <name>Task 4 (T4 — update-token): figma_update_token with 403 graceful surface</name>
  <files>src/tools/figma/update-token.ts, src/tools/figma/__tests__/update-token.test.ts</files>
  <behavior>
    update-token.ts exports:
      - UPDATE_TOKEN_DEF: ToolDef matching FIGMA-API-TOOLS.md:118-145 schema (params: file_key, token_name, value, type[enum:color|spacing|typography], collection_id, mode_id? — all required except mode_id)
      - handleUpdateToken(args, ctx): Promise<{status:"ok"|"plan_required"; node_id?:string; message?:string}>
        - Validates via zod (color={r,g,b,a} floats 0-1; spacing=number; typography=string per FIGMA-API-TOOLS.md:156-162)
        - Call 1: figmaGet(`/v1/files/${file_key}/variables/local`) → lookup by token_name → if found: action="UPDATE" + existing id, else action="CREATE" + tempId
        - Call 2: figmaPost(`/v1/files/${file_key}/variables`, {variables:[...], variableModeValues:[...]})
        - 403 kind=PLAN_REQUIRED → RETURN {status:"plan_required", message:"Variable writes require Figma Enterprise plan. See: relay doctor --figma"} (NOT throw — model surfaces gracefully per ROADMAP SC#3)
        - Other 403 kinds → throw FigmaForbiddenError (NOT swallowed)
        - Success → {status:"ok", node_id: response.meta.tempIdToRealId[tempId] ?? existingId}
      - Type-mapping helper: color→COLOR, spacing→FLOAT, typography→STRING
      - zod error messages explain correct shape per type enum (helps model self-correct on next iteration)
    Tests (9 cases):
      1) color new (no match) → POST body action:CREATE, tempId, COLOR resolvedType 2) color existing → action:UPDATE + looked-up id
      3) spacing → FLOAT 4) typography → STRING 5) invalid value shape (string for color) → zod error
      6) 403 PLAN_REQUIRED → returns {status:"plan_required",...} NOT throws (graceful) 7) 403 TOKEN_EXPIRED → throws FigmaForbiddenError
      8) 200 success with tempIdToRealId → node_id returned correctly 9) GET local fails 404 → error surfaces, no POST attempted
  </behavior>
  <action>
    RED: write update-token.test.ts (9 cases). Fixture for `GET /v1/files/{key}/variables/local` shape based on FIGMA-API-TOOLS.md:184-190.
    GREEN: implement update-token.ts. Two-call sequence (GET local → POST update). Type-mapping helper. Shared error handling via rest-client error classes.
    Commits:
      - `test(figma): add failing tests for figma_update_token (CREATE/UPDATE + 403 graceful)`
      - `feat(figma): implement figma_update_token with Enterprise-tier 403 graceful surface`
  </action>
  <verify>
    <automated>npx vitest run src/tools/figma/__tests__/update-token.test.ts</automated>
  </verify>
  <done>9 cases green. 403 PLAN_REQUIRED → structured return (not exception). Other 403 kinds throw. zod validates value per type. Two-call sequence end-to-end against fixtures.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 5 (T5+T6 — registry + worker wire-up): conditional registration into agentic runner</name>
  <files>src/tools/figma/index.ts, src/tools/figma/__tests__/registry.test.ts, src/workers/lmstudio-agentic.ts</files>
  <behavior>
    src/tools/figma/index.ts exports:
      - registerFigmaTools(env: NodeJS.ProcessEnv): FigmaToolHandler[] | null
        - Reads PAT via loadPat(env, os.homedir())
        - Returns null when loadPat returns null — FIGMA-03 (no startup error, no model exposure)
        - Returns [{def: LIST_LAYERS_DEF, handle: handleListLayers}, {def: UPDATE_TOKEN_DEF, handle: handleUpdateToken}]
        - NEVER touches process.env directly (env passed in for testability — coding-style.md rule)
      - DEFERRED_FIGMA_TOOLS: readonly ["figma_get_selection", "figma_create_component"]
        - Exported for cmd-doctor + --help to render deferral notice (FIGMA-05)
      - NO export matching the deferred tool names (declarative absence — not a stub, not a "v1 minimal")

    Worker wire-up in src/workers/lmstudio-agentic.ts (DELTA ONLY — Phase 3 owns the runner):
      - LOCATE existing tools-array assembly point (Phase 3 — at module-init or worker construction)
      - INSERT: `const figma = registerFigmaTools(process.env); if (figma) tools.push(...figma.map(h => h.def));`
      - INSERT dispatcher: when tool_calls[i].function.name matches a Figma handler, invoke handler.handle(JSON.parse(args), ctx) where ctx = {workdir: task.workdir, pat: loadedPat}
      - Additive only — NO refactor of Phase 3 worker shape
      - If Phase 3's registry shape diverges from <interfaces> contract: fail loudly, escalate to gap-closure plan — DO NOT silently reshape Phase 3
    Tests (registry.test.ts, 6 cases):
      1) env empty + no figma.json → returns null 2) env with FIGMA_API_TOKEN → returns 2-elem array
      3) figma.json present at tmp homeDir + chmod 600 → returns 2-elem array 4) figma.json + chmod 644 → returns null + stderr warn
      5) DEFERRED_FIGMA_TOOLS contains exactly 2 v0.3 names 6) registered tools' def.function.name are unique
    Phase 3 worker test regression: existing tests STILL pass after wire-up delta (zero regression).
  </behavior>
  <action>
    RED: write registry.test.ts (6 cases). Mock os.homedir() to tmp dir for fixture-file cases. Run vitest — fail.
    GREEN: implement src/tools/figma/index.ts. Add wire-up delta to src/workers/lmstudio-agentic.ts (additive only).
    Open Phase 3 worker FIRST and confirm:
      (a) exports worker with mutable/extensible tools[], OR
      (b) accepts injected toolset via constructor/factory
    Path (a) → patch array assembly site with conditional push. Path (b) → expose registerFigmaTools result through factory call site in cmd-run.ts / cmd-parallel.ts.
    Verify Phase 3 worker tests STILL green after delta — additive should not break existing assertions.
    Commits:
      - `test(figma): add failing tests for tool registry + env-gated registration`
      - `feat(figma): wire registry into lmstudio-agentic worker (env-gated, additive)`
  </action>
  <verify>
    <automated>npx vitest run src/tools/figma/__tests__/registry.test.ts src/workers/lmstudio-agentic.test.ts</automated>
  </verify>
  <done>Registry tests green. Phase 3 worker tests still green (zero regression). FIGMA_API_TOKEN unset → tools[] has zero Figma entries. FIGMA_API_TOKEN set → tools[] has exactly figma_list_layers + figma_update_token. Dispatcher routes tool_calls correctly (verified in Task 7).</done>
</task>

<task type="auto" tdd="true">
  <name>Task 6 (T7 — doctor probe): relay doctor --figma</name>
  <files>src/cli/cmd-doctor.ts, src/cli/cmd-doctor.test.ts</files>
  <behavior>
    cmd-doctor.ts: add --figma flag (or extend existing flag-parsing in cmd-doctor.ts):
      - --figma → run probeFigma() helper, render results, exit cleanly
      - probeFigma() in order:
        1) loadPat(process.env, os.homedir()) → render "PAT: present" | "PAT: absent (set FIGMA_API_TOKEN or write ~/.relay/secrets/figma.json)"
        2) PAT present → figmaGet('/v1/me', {pat}) → if 200, parse plan tier; render "Plan: enterprise (variable writes ENABLED)" | "Plan: <tier> (variable writes DISABLED — figma_update_token returns PLAN_REQUIRED)"
        3) PAT present → sample figmaGet for a documented stable public file_key; render "REST: ok" | "REST: failed (<scrubbed reason>)" — if no stable file_key candidate, skip and rely only on /v1/me check
        4) ALWAYS render: "Deferred to v0.3 (require Figma Plugin API bridge): <DEFERRED_FIGMA_TOOLS joined>" — read from const, do NOT hardcode names
      - All output routed through scrubPat (defense in depth — rest-client already scrubs; cmd-doctor adds belt+suspenders)
      - Output format matches existing doctor sections (mirror what other doctor probes use)
    Tests (extend cmd-doctor.test.ts, 5 new cases):
      1) --figma no PAT → exit 0, output "PAT: absent" + deferred list 2) --figma valid PAT + Enterprise mock → "Plan: enterprise" + "REST: ok"
      3) --figma valid PAT + non-Enterprise → "Plan: " + "variable writes DISABLED" 4) --figma 403 expired → "REST: failed" + "TOKEN_EXPIRED", NO raw PAT
      5) deferred list contains exactly 2 v0.3 names (read from DEFERRED_FIGMA_TOOLS, not hardcoded)
    Existing cmd-doctor tests STILL pass (additive change).
  </behavior>
  <action>
    RED: extend cmd-doctor.test.ts with 5 new cases. Mock fetch via vi.spyOn. Run full file to baseline existing-tests pass FIRST.
    GREEN: extend cmd-doctor.ts with --figma branch. Reuse rest-client.ts (no duplicate fetch). Reuse DEFERRED_FIGMA_TOOLS const (NEVER hardcode deferred names in cmd-doctor).
    Stable file_key choice: hardcode a documented Figma demo file key (e.g., Figma UI3 Design System) — comment why file_key is safe + stable; if no good candidate, skip sample call and use /v1/me only.
    Commits:
      - `test(doctor): add failing tests for --figma probe flag`
      - `feat(doctor): add --figma probe with PAT + plan-tier + REST check`
  </action>
  <verify>
    <automated>npx vitest run src/cli/cmd-doctor.test.ts</automated>
  </verify>
  <done>All cmd-doctor tests green (existing + 5 new). `relay doctor --figma` no-env → "PAT: absent" + deferred list. Valid Enterprise PAT → plan tier + REST ok. DEFERRED_FIGMA_TOOLS = source of truth (changing const updates doctor output automatically).</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 7 (T8 — integration verification): real Figma file E2E</name>
  <what-built>Two REST-only Figma tools, env-gated registration into Phase 3 agentic runner, doctor probe, PAT scrubbing, 429 retry. All unit tests green per Tasks 1-6.</what-built>
  <how-to-verify>
    SETUP (one-time):
    1. Create Figma PAT (Figma → Settings → Account → Personal access tokens; scope: file_read; optionally file_variables:write if Enterprise)
    2. Write ~/.relay/secrets/figma.json with `{"token":"figd_..."}`, chmod 600
    3. Pick a Figma file you own — copy file_key from URL (segment after /file/)
    4. Optional: create <workdir>/.relay/figma.json with `{"file_key":"YOUR_KEY"}`

    DOCTOR PROBE:
    5. `relay doctor --figma` → EXPECT: "PAT: present", plan tier visible, "REST: ok", deferred-tools list shown

    LIST LAYERS (REST tool 1):
    6. `export FIGMA_API_TOKEN=$(jq -r .token ~/.relay/secrets/figma.json) && relay run --provider lmstudio-agentic --task "list layers in file YOUR_KEY"`
       EXPECT: model invokes figma_list_layers, returns flattened layer list. No PAT in stderr. iterations < 5.

    UPDATE TOKEN (REST tool 2 — Enterprise gate):
    7. `relay run --provider lmstudio-agentic --task "in file YOUR_KEY, set color/primary to #3366CC in default collection"`
       EXPECT (Enterprise): figma_update_token invoked, {status:"ok", node_id:"..."}, variable updated in Figma
       EXPECT (non-Enterprise): figma_update_token invoked, {status:"plan_required", message:"..."}, surfaces to user — NOT crash, NOT silent

    GRACEFUL ABSENCE (FIGMA-03):
    8. `unset FIGMA_API_TOKEN && rm ~/.relay/secrets/figma.json && relay run --provider lmstudio-agentic --task "list layers in any file"`
       EXPECT: model has zero Figma tools available; says "no Figma tool available — set FIGMA_API_TOKEN". NO startup crash.

    SCRUB CHECK:
    9. `grep -rE "figd_[A-Za-z0-9_-]+" ~/.relay/debug/ 2>/dev/null | grep -v SCRUBBED` → EXPECT: zero output

    DEFERRED-TOOLS CHECK (FIGMA-05):
    10. `relay doctor --figma | grep -E "figma_get_selection|figma_create_component"` → EXPECT: both names with "deferred to v0.3" context
  </how-to-verify>
  <resume-signal>"verified" if all steps pass. "verified-no-enterprise" if step 7 partial-passes via graceful 403 (acceptable). "issues: <list>" if any fail → gap-closure plan needed.</resume-signal>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| user PAT → ~/.relay/secrets/figma.json | secret at rest on disk; chmod 600 required |
| Relay process → api.figma.com | outbound HTTPS with X-Figma-Token header — PAT in transit |
| agentic model → tool dispatcher | LLM-controlled args reach REST client; model could be prompt-injected |
| tool handler → ~/.relay/debug/ logs | any logged request/response is leak vector for PAT |
| cmd-doctor output → user terminal | error messages visible on screen-shares |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-07-01 | Information Disclosure | rest-client.ts error paths | mitigate | scrub.ts:scrubPat applied to every thrown error message + stack (Task 1+2; rest-client test case 9; doctor test case 4) |
| T-07-02 | Information Disclosure | ~/.relay/debug/ logs when RELAY_LMSTUDIO_DEBUG_DUMP=1 | mitigate | rest-client scrubs headers before any potential dump; Task 7 step 9 greps for unscrubbed `figd_` |
| T-07-03 | Information Disclosure | ~/.relay/secrets/figma.json on shared/cloud-synced home | mitigate | pat-loader refuses read when chmod permits group/other; stderr warn (Task 1 case 4) |
| T-07-04 | Tampering | workdir/.relay/figma.json injecting wrong file_key | accept | low risk — file_key is not a credential; worst case tool acts on wrong file (user/model will notice) |
| T-07-05 | Denial of Service | model emits unbounded figma_list_layers → 429 cascade | mitigate | rest-client caps retries to 1; throws FigmaRateLimitError after; per-loop cap is Phase 3 AGENTIC-02 hash-loop detector responsibility (PITFALLS 5.4) |
| T-07-06 | Elevation of Privilege | non-Enterprise user gets figma_update_token registered → 403 cascade | mitigate | update-token maps 403 PLAN_REQUIRED to structured `{status:"plan_required"}` (Task 4 case 6); v0.3 future enhancement: pre-flight plan check to filter tool from tools[] (PITFALLS 5.2 §2 — deferred per scope discipline; current plan registers unconditionally when PAT present) |
| T-07-07 | Spoofing | adversarial Figma response masquerading as success when actually 403 | accept | TLS to api.figma.com mitigates network-level spoofing; industry-standard TLS chain trust |
| T-07-08 | Repudiation | agentic loop modifies tokens with no Relay-side audit trail | accept | Figma has own audit log for variable changes; Relay-side audit out of scope for v0.2 (could surface v0.3 via cmd-history extension) |
| T-07-09 | Tampering | model emits SQL-injection-style strings in token_name | mitigate | zod validates token_name as plain string; Figma REST parameterizes — no SQL surface |
| T-07-10 | Information Disclosure | cmd-doctor --figma accidentally prints PAT in error case | mitigate | Task 6 case 4 asserts no raw PAT even on 403; defense-in-depth via scrubPat in cmd-doctor error formatting |
</threat_model>

<verification>
Phase-level checks across all 7 tasks:
1. `npx vitest run src/tools/figma/` → all Figma unit tests green (Tasks 1-5)
2. `npx vitest run src/cli/cmd-doctor.test.ts` → existing + new doctor tests green (Task 6)
3. `npx vitest run src/workers/lmstudio-agentic.test.ts` → Phase 3 tests still green after Task 5 wire-up (regression check)
4. `grep -rE "figd_[A-Za-z0-9_-]+" src/tools/figma/ | grep -v "SCRUBBED" | grep -v "test"` → only fixture/test matches; no production embed
5. `grep -E "import.*(axios|undici|node-fetch|figma-api)" src/tools/figma/` → empty (native fetch only, SUMMARY §1)
6. `grep -E "figma_get_selection|figma_create_component" src/tools/figma/index.ts` → only inside DEFERRED_FIGMA_TOOLS const; NO function exports
7. Manual integration via Task 7 checkpoint (real Figma file)
</verification>

<success_criteria>
Mapped to ROADMAP Phase 7 Success Criteria (all five MUST be TRUE):

1. **SC1 — figma_list_layers REST works**: User with FIGMA_API_TOKEN runs `relay run --provider lmstudio-agentic --task "list layers in file ABC123"` and observes figma_list_layers hitting `GET /v1/files/{key}/nodes` with X-Figma-Token header → returns layer tree. Verified by: Task 3 unit tests + Task 7 step 6.

2. **SC2 — Graceful absence without PAT**: User without FIGMA_API_TOKEN sees zero Figma tools registered, no startup error. Verified by: Task 5 registry case 1 + Task 7 step 8.

3. **SC3 — Non-Enterprise 403 graceful**: User on non-Enterprise plan calling figma_update_token receives clear 403 message through agentic loop (not generic crash). Verified by: Task 2 case 5 (kind mapping) + Task 4 case 6 (graceful return) + Task 7 step 7.

4. **SC4 — Rate limit handling**: User hitting 429 sees backoff respecting Retry-After + single retry then hard error (no infinite loop, no PAT leak). Verified by: Task 2 cases 3+4 + Task 2 case 9 (scrub).

5. **SC5 — Plugin-bridge tools declaratively deferred**: User confirms via `relay doctor --figma` (or --help) that figma_get_selection + figma_create_component are deferred to v0.3 (require Plugin API WebSocket bridge — declaratively absent, not silently broken). Verified by: Task 5 case 5 + Task 6 case 5 + Task 7 step 10.

ADDITIONAL planner-enforced criteria:
6. PAT scrubbing verified across all debug paths (Task 7 step 9 + rest-client case 9).
7. Phase 3 worker tests pass unchanged after Task 5 wire-up (additive integration, zero regression).
8. No new runtime deps added (verify package.json — only native fetch + existing zod; SUMMARY §1 DO-NOT-add list).
</success_criteria>

<output>
After completion create `.planning/phases/07-figma-rest-tools/07-01-SUMMARY.md` capturing:
- Tasks 1-7 outcomes (commit SHAs per RED/GREEN pair)
- Decision: did Phase 3 worker shape match assumed <interfaces> contract? Adapter needed?
- PAT-leak scan results from Task 7 step 9
- Plan-tier observed during Task 7 step 5 (informs v0.3 figma_update_token pre-filter scope)
- Open items for v0.3: figma_get_selection, figma_create_component, plan-tier pre-filter for figma_update_token, OAuth2 token refresh, audit-log surface
- File:line citation to wire-up site in src/workers/lmstudio-agentic.ts
</output>

## Risk Register

| Risk ID | Risk | Likelihood | Impact | Mitigation |
|---------|------|------------|--------|------------|
| R-07-01 | PAT leaks via debug log or error string | LOW (scrub at all paths) | CATASTROPHIC (PITFALLS top #2: rotation + git history scrub) | scrub.ts Task 1; rest-client Task 2; cmd-doctor Task 6; grep verification Task 7 step 9 |
| R-07-02 | Rate-limit thrash burns Figma quota / locks account | MEDIUM (model could repeat calls) | MEDIUM (account temp-locked ~1hr) | Single retry only (Task 2 cases 3+4); per-loop cap deferred to Phase 3 AGENTIC-02 hash-loop detector |
| R-07-03 | Enterprise-only 403 misread as "auth issue" → user re-pastes PAT in loop | MEDIUM (PITFALLS 5.2 documented) | LOW (no leak, just confusion) | rest-client maps 403 body to typed kinds (Task 2 cases 5+6); update-token returns structured graceful for PLAN_REQUIRED (Task 4 case 6); doctor surfaces plan tier (Task 6 case 2) |
| R-07-04 | Plugin-bridge tools accidentally registered when user thinks shipping | LOW (no plugin code in scope) | HIGH (false advertising — model would 404 mid-task) | DEFERRED_FIGMA_TOOLS const is read-only list, NOT handlers; Task 5 case 5 asserts only 2 names; index.ts has NO export matching deferred names |
| R-07-05 | Phase 3 doesn't ship compatible tool-registry shape | MEDIUM (Phase 3 still TBD) | HIGH (this phase blocks indefinitely) | Task 5 action: confirm Phase 3 shape FIRST, choose path (a) or (b); if neither works, fail loud + escalate to gap-closure plan, NEVER silently reshape Phase 3 |
| R-07-06 | workdir/.relay/figma.json committed to git accidentally | MEDIUM (designer-user workflow) | LOW (file_key is not credential) | Document in pat-loader code comments that `<workdir>/.relay/figma.json` belongs in .gitignore; doctor-probe gitignore check is v0.3 scope |
| R-07-07 | Native fetch Retry-After parsing differs across Node 20/22 | LOW (Node 20+ baseline) | LOW (would surface in 429 test) | Test case 3 uses fake timers + explicit Retry-After header value (no Date parsing); HTTP-date format explicitly deferred (commented in code) |

---

**Phase scope discipline:** REST tools ONLY. FIGMA-05 ships as DECLARATIVE DEFERRAL (DEFERRED_FIGMA_TOOLS const + doctor output) — NOT code stubs, NOT "v1 minimal version." WebSocket bridge plugin work is wholly v0.3 and out of scope for any task here.
