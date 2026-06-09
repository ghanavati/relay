---
phase: 09-mcp-server
plan: 03
subsystem: mcp
tags: [mcp, memory, recall, remember, redaction, workdir-scoping, zod]

# Dependency graph
requires:
  - phase: 09-02
    provides: "src/mcp/result.ts (relayErrorToMcpResult), SDK 1.29.0 pin + verified surface"
  - phase: "pre-9 memory subsystem"
    provides: "handleRecall/handleRemember, contracts/memory.ts Zod schemas, MemoryStore assertWorkdirAllowed gate"
provides:
  - "buildMemoryMcpTools() — the exact two-tool v0.4 MCP surface: relay_memory_recall + relay_memory_save registrations { name, config:{description,inputSchema}, handler }"
  - "MCP_MEMORY_SOURCE = 'worker-mcp' — provenance tag for MCP-client saves (unverified-by-default trust)"
affects: [09-04, 09-05]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Thin wrapper over existing handlers: redactEnvelope (redactSecrets per content[].text, shape preserved) instead of toMcpResult re-wrap for already-enveloped results"
    - "Workdir scoping by inheritance: wrap MemoryStore-calling handlers, never bypass"
    - "MCP tool registrations are SDK-free plain objects; Plan 04 is the only SDK call site"

key-files:
  created:
    - src/mcp/tools-memory.ts
    - src/mcp/tools-memory.test.ts
  modified: []

key-decisions:
  - "MCP saves carry MemorySource 'worker-mcp' — the union has no MCP-specific value; closest existing tag, keeps non-human saves unverified-by-default"
  - "inputSchema = the constructed ZodObject (RecallArgsSchema / RememberArgsSchema) passed by identity — SDK 1.29.0 registerTool accepts AnySchema (verified in installed zod-compat.d.ts, not docs)"
  - "redactEnvelope maps redactSecrets over each content[].text — handlers already emit the envelope, so withMcpResult/toMcpResult would double-wrap; error path still routes through relayErrorToMcpResult"

requirements-completed: [MCP-02, MCP-03, MCP-04]

# Metrics
duration: ~12min
completed: 2026-06-09
---

# Phase 9 Plan 03: MCP Memory Tools Summary

**relay_memory_recall + relay_memory_save as thin wrappers over handleRecall/handleRemember — same SQLite store, same workdir gate as the CLI, contracts Zod schemas by identity, boundary redaction on every outbound text field**

## Performance

- **Duration:** ~12 min (including lock waits behind the concurrent 09-01 executor)
- **Started:** 2026-06-09T19:28:40Z
- **Completed:** 2026-06-09T19:36:25Z (code; summary commit follows)
- **Tasks:** 2/2
- **Files modified:** 2 (both created; nothing else touched)

## Accomplishments

- `buildMemoryMcpTools()` exposes EXACTLY `[relay_memory_recall, relay_memory_save]` — the killed scope stays killed (D-07): no control tools, no dispatch tool, no shell surface (pinned by test)
- Both tools are thin wrappers: `handleRecall(args)` / `handleRemember(args, MCP_MEMORY_SOURCE)` — zero reimplemented memory logic
- inputSchema is the contracts Zod object by `===` identity (MCP-03, asserted in tests) — single source of truth, no re-declared schema
- Workdir scoping inherited from `MemoryStore.assertWorkdirAllowed` (MCP-02): forbidden workdir → `isError` with code `MEMORY_WORKDIR_FORBIDDEN`; recall leaks nothing, save inserts nothing (row count asserted)
- Boundary redaction (MCP-04): `redactSecrets` applied to every `content[].text` on success; error path through `relayErrorToMcpResult` (code preserved, message redacted, stack never crosses)
- 9 new tests, all green; full suite has zero new failures vs baseline

## Registration Shape (Plan 04: wire against THIS)

`src/mcp/tools-memory.ts` (SDK-free — grep `modelcontextprotocol` = 0):

```ts
export const MCP_MEMORY_SOURCE: MemorySource = 'worker-mcp';

export interface MemoryMcpTool<TSchema, TArgs> {
  readonly name: string; // 'relay_memory_recall' | 'relay_memory_save'
  readonly config: {
    readonly description: string;
    readonly inputSchema: TSchema; // the contracts ZodObject ITSELF (same object)
  };
  readonly handler: (args: TArgs) => Promise<McpToolResult>; // McpToolResult from src/mcp/result.ts
}

export type RecallMcpTool = MemoryMcpTool<typeof RecallArgsSchema, RecallArgs>;
export type SaveMcpTool = MemoryMcpTool<typeof RememberArgsSchema, RememberArgs>;

export function buildMemoryMcpTools(): readonly [RecallMcpTool, SaveMcpTool];
```

**Plan 04 wiring notes:**

1. Register with `server.registerTool(t.name, t.config, t.handler)`. SDK 1.29.0's `registerTool` generic is `InputArgs extends undefined | ZodRawShapeCompat | AnySchema` — a constructed Zod v3 object IS an `AnySchema`, and the SDK's `normalizeObjectSchema` explicitly handles "already-constructed object schemas" (read from the installed `server/zod-compat.d.ts`). The SDK validates client args against the schema and passes the `z.infer` output (defaults applied) to the handler.
2. **Variance caveat:** `McpToolResult.content` is `readonly McpTextContent[]`; the SDK's `CallToolResult['content']` is a mutable array. If tsc rejects the direct handler assignment at the registerTool call site, adapt there (spread `content` into a fresh array or a targeted cast) — the runtime shape is exactly CallToolResult-compatible. Do NOT change result.ts/tools-memory.ts readonly contracts.
3. Handlers take only `(args)` — the SDK's second `extra` param is ignored by design (fewer-params assignability).
4. **MemorySource for MCP saves: `'worker-mcp'`** (exported as `MCP_MEMORY_SOURCE`). The `MemorySource` union has no MCP-specific value; this is the closest worker-MCP-path tag, and `computeTrustLevel` keeps non-human sources unverified-by-default — pinned by test (saved rows assert `memory_source='worker-mcp'`, `trust_level='unverified'`).

## Task Commits

1. **Task 1: relay_memory_recall over handleRecall (MCP-02, MCP-03)** — `55415e1` (feat)
2. **Task 2: relay_memory_save over handleRemember; two-tool surface (MCP-02, MCP-04)** — `237843a` (feat)

_TDD followed within each task (compiling stub → tests observed failing → implement → green), with one atomic commit per task per orchestrator git discipline. No stub state was ever committed._

## Files Created

- `src/mcp/tools-memory.ts` — buildMemoryMcpTools(), MCP_MEMORY_SOURCE, MemoryMcpTool types, redactEnvelope (module-private), client-facing tool descriptions
- `src/mcp/tools-memory.test.ts` — 9 tests: store-backed recall, schema identity ×2, workdir-forbidden ×2 (recall leak + save write-reject with row-count proof), boundary redaction ×2 (legacy un-redacted row on recall; secret-shaped tag echo on save), exact two-tool surface

## Decisions Made

1. **`redactEnvelope` instead of `withMcpResult`:** the handlers already return the `{ content }` envelope; `withMcpResult`→`toMcpResult` would serialize the envelope INTO a new envelope (double-wrap). Per the plan's action text, the wrapper applies `redactSecrets` to each `text` field, preserving payload shape; thrown RelayErrors still route through `relayErrorToMcpResult` (the plan's key-link pattern `withMcpResult|relayErrorToMcpResult` is satisfied by the latter).
2. **Constructed ZodObject as inputSchema** (not the raw shape `recallSchema`/`rememberSchema`): the plan allowed either per the SDK's expected form; the installed SDK accepts both, and the must_haves truths name `RecallArgsSchema`/`RememberArgsSchema` — the ZodObjects win, identity-asserted.
3. **Recall redaction fixture via direct DB UPDATE:** the store redacts on save, so a secret saved through `remember()` reaches disk already redacted and would prove nothing about the boundary. The test seeds a row then UPDATEs its content under the sanitizer — simulating a legacy row written before a redaction pattern existed (exactly T-09-09's "second layer, not a substitute" rationale).
4. **Save redaction fixture via a secret-shaped tag:** `handleRemember`'s response does not echo `content`, so a secret in content never reaches the success envelope; `args.tags` IS echoed — a runtime-built secret-shaped tag proves the success path redacts.

## Deviations from Plan

None — both tasks executed as specified. The decisions above are implementation choices within explicit plan latitude (the plan's action text prescribed the redact-the-text-field approach and left the schema form to the SDK's expected form).

## Threat Model Outcomes

- **T-09-08 (cross-workdir read):** mitigated + tested — forbidden workdir recall returns coded isError, canary content asserted absent.
- **T-09-09 (recalled secrets):** mitigated + tested — boundary redaction proven against a row the store-side save redaction never touched.
- **T-09-10 (unscoped/runaway MCP writes):** mitigated + tested — forbidden save rejected with no row inserted; rate limit/dedup/unverified-trust inherited by calling the same store path (dedup + trust pinned by test; rate limit is per-source_run_id and unchanged).

No new threat surface beyond the plan's register.

## Test Count vs Baseline

- Baseline (per orchestrator, post-09-02): **1819 tests / 1817 pass / 2 fail** (pre-existing Phase 8 control-e2e grant-expiry time bombs, documented in deferred-items.md)
- Full suite at completion: **1867 tests / 1865 pass / 2 fail** — the SAME two control-e2e failures; **zero new failures**. Delta (+48) = this plan's 9 tests + the concurrent 09-01 executor's in-flight additions (their summary records 1858 at their Task 3 — 1858 + 9 = 1867, consistent).
- Targeted: `dist/mcp/tools-memory.test.js` 9/9 pass; `npm run build` clean.

## Acceptance Criteria Results

| Criterion | Result |
|---|---|
| recall returns store-backed, redacted results (T1 Tests 1, 4) | PASS |
| recall inputSchema === RecallArgsSchema (T1 Test 2) | PASS |
| forbidden workdir → isError MEMORY_WORKDIR_FORBIDDEN (T1 Test 3) | PASS |
| `grep handleRecall src/mcp/tools-memory.ts` | import + call site |
| save persists to shared store + scoping (T2 Tests 1, 3) | PASS |
| buildMemoryMcpTools = exactly two tools (T2 Test 5) | PASS |
| save inputSchema === RememberArgsSchema; results redacted (T2 Tests 2, 4) | PASS |
| `grep handleRemember src/mcp/tools-memory.ts` | import + call site |
| `git diff --stat`: new files only under src/mcp/; recall.ts/remember.ts/memory/ untouched | VERIFIED (2 files, 370 insertions, nothing else) |

## Known Stubs

None — no placeholder values, no TODO/FIXME, no unwired surfaces in the shipped files.

## Next Phase Readiness

- Plan 04: instantiate via `resolveMcpSdk()`, then `for (const t of buildMemoryMcpTools()) server.registerTool(t.name, t.config, t.handler)` — see Registration Shape notes (especially the readonly-content variance caveat).
- Plan 05: drive these tools through `InMemoryTransport.createLinkedPair()` + `Client` per the 09-02 surface table.
- REQUIREMENTS.md / STATE.md / ROADMAP.md not touched per orchestrator concurrency instructions — requirement check-offs (MCP-02/03/04) left to the orchestrator.

## Self-Check: PASSED

- `src/mcp/tools-memory.ts` — FOUND
- `src/mcp/tools-memory.test.ts` — FOUND
- Commit `55415e1` — FOUND
- Commit `237843a` — FOUND
- grep gates: `handleRecall`/`handleRemember` present; `modelcontextprotocol` refs in both new files = 0; `relayErrorToMcpResult` present on both error paths

---
*Phase: 09-mcp-server*
*Completed: 2026-06-09*
