---
phase: 09-mcp-server
plan: 02
subsystem: mcp
tags: [mcp, modelcontextprotocol, sdk, stdio, redaction, supply-chain, relay-error]

# Dependency graph
requires:
  - phase: "pre-9 core (security + errors)"
    provides: "redactSecrets/REDACTION_PATTERNS (src/security/redaction.ts), makeError/toRelayException (src/errors.ts)"
provides:
  - "@modelcontextprotocol/sdk exact-pinned at 1.29.0, supply-chain verified (name/maintainers/version/repo)"
  - "resolveMcpSdk() build-time surface probe — McpServer + StdioServerTransport verified against the installed package"
  - "src/mcp/result.ts — toMcpResult / relayErrorToMcpResult / withMcpResult: MCP envelope + boundary redaction + RelayError mapping, SDK-free"
affects: [09-03, 09-04, 09-05]

# Tech tracking
tech-stack:
  added: ["@modelcontextprotocol/sdk@1.29.0 (exact pin, no ^)"]
  patterns:
    - "Build-time SDK surface probe (resolveMcpSdk) — imports verified against the installed exports map, never copied from docs"
    - "Boundary redaction on SERIALIZED text (JSON.stringify then redactSecrets) so nested values are covered"
    - "Secret-shaped test fixtures built at runtime from string parts (no literal credentials in source)"

key-files:
  created:
    - src/mcp/sdk-probe.ts
    - src/mcp/sdk-probe.test.ts
    - src/mcp/result.ts
    - src/mcp/result.test.ts
  modified:
    - package.json
    - package-lock.json

key-decisions:
  - "Pinned @modelcontextprotocol/sdk@1.29.0 (latest stable); the org's v2 split (@modelcontextprotocol/server) exists only as 2.0.0-alpha.2 — not adopted"
  - "Probe failures use existing CONFIG_ERROR code with MCP_SDK_UNRESOLVED: message prefix — no edit to shared src/errors.ts (outside both concurrent executors' write sets)"
  - "Old src/tools/mcp-result.ts left as-is for its 3 non-MCP callers; new src/mcp/result.ts is the MCP-specific redacting superseder"

patterns-established:
  - "All later McpServer/StdioServerTransport imports go through resolveMcpSdk (T-09-07 gate)"
  - "Every value crossing the MCP boundary goes through result.ts (T-09-05/T-09-06 gate)"

requirements-completed: [MCP-04, MCP-05]

# Metrics
duration: ~25min
completed: 2026-06-09
---

# Phase 9 Plan 02: SDK Pin + MCP Result Boundary Summary

**@modelcontextprotocol/sdk@1.29.0 exact-pinned with supply-chain gate + resolveMcpSdk surface probe, and SDK-free result.ts owning the MCP envelope, boundary redaction, and RelayError mapping**

## Performance

- **Duration:** ~25 min (including lock waits behind the concurrent 09-01 executor)
- **Started:** 2026-06-09T19:01:18Z
- **Completed:** 2026-06-09T19:26:00Z
- **Tasks:** 2/2
- **Files modified:** 6 (4 created, 2 modified)

## Accomplishments

- MCP SDK pinned exact (`"@modelcontextprotocol/sdk": "1.29.0"`), supply-chain verified before install, single-version resolution in `npm ls`
- `resolveMcpSdk()` proves the import surface against the package on disk; missing/renamed package or missing constructor fails as a coded RelayError, never an unhandled rejection; probe is stdout-silent
- `result.ts` centralizes the `{content:[{type:'text',text}], isError?}` envelope with `redactSecrets` on every serialized value (success AND error paths); a handler throw can never escape the boundary
- 15 new tests (5 probe + 10 result), all green; typecheck clean; existing CLI untouched

## Supply-Chain Verification Record (T-09-04)

Verified 2026-06-09 before install (maintainer pre-approved the install this session):

| Check | Result |
|---|---|
| Package | `@modelcontextprotocol/sdk` |
| Version | `1.29.0` (= dist-tag `latest`; last publish 2026-06-04) |
| Maintainers | jspahrsummers, pcarleton, fweinberger@anthropic.com, thedsp, ashwin-ant@anthropic.com, ochafik |
| Repository | github.com/modelcontextprotocol/typescript-sdk (homepage modelcontextprotocol.io) |
| Deprecated | No |
| Newer official package name? | `@modelcontextprotocol/server` exists — same maintainers/repo (the v2 package split) but **alpha only** (`2.0.0-alpha.2` is its `latest`). Not adopted; `sdk` remains the official stable package. |
| Install | `npm install --save-exact @modelcontextprotocol/sdk@1.29.0`; lockfile diff contains ONLY the @modelcontextprotocol tree (0 other lines) |

## Verified SDK Surface (wire against THESE — Plans 03/04/05)

Read from the installed package's exports map + live dynamic-import probe, not docs:

- **McpServer**: `@modelcontextprotocol/sdk/server/mcp.js` (also exports `ResourceTemplate`)
- **StdioServerTransport**: `@modelcontextprotocol/sdk/server/stdio.js`
- **CAUTION:** the bare `@modelcontextprotocol/sdk/server` index exports only the low-level `Server` — NOT `McpServer`/`StdioServerTransport`. The `.js` subpaths above are required.
- **For Plan 05 (integration test):** the SDK ships `Client` at `@modelcontextprotocol/sdk/client/index.js` AND `InMemoryTransport` at `@modelcontextprotocol/sdk/inMemory.js` with a static `createLinkedPair()` (verified callable function). The in-memory linked-pair test path is viable — no child-process stdio fallback needed.

## Exported API (exact signatures)

`src/mcp/sdk-probe.ts`:

```ts
export const MCP_SDK_PACKAGE = '@modelcontextprotocol/sdk';
export const MCP_SERVER_MCP_SUBPATH;    // '@modelcontextprotocol/sdk/server/mcp.js'
export const MCP_SERVER_STDIO_SUBPATH;  // '@modelcontextprotocol/sdk/server/stdio.js'
export type McpImporter = (specifier: string) => Promise<Record<string, unknown>>;
export type McpConstructor = new (...args: any[]) => any;
export interface ResolvedMcpSdk {
  readonly packageName: string;   // '@modelcontextprotocol/sdk'
  readonly version: string;       // read from the package.json installed on disk
  readonly McpServer: McpConstructor;
  readonly StdioServerTransport: McpConstructor;
}
export async function resolveMcpSdk(importer?: McpImporter): Promise<ResolvedMcpSdk>;
// failure mode: throws RelayException { code: 'CONFIG_ERROR', retryable: false, feature: 'mcp' }
// with message prefixed 'MCP_SDK_UNRESOLVED:' naming the expected package/subpath.
```

`src/mcp/result.ts` (SDK-free — grep gate `modelcontextprotocol` = 0):

```ts
export interface McpTextContent { readonly type: 'text'; readonly text: string }
export interface McpToolResult {
  readonly content: readonly McpTextContent[];
  readonly isError?: boolean;
}
export function toMcpResult(value: unknown): McpToolResult;
export function relayErrorToMcpResult(err: unknown): McpToolResult; // isError:true; never throws; stack never crosses
export async function withMcpResult(fn: () => unknown): Promise<McpToolResult>;
```

**Plan 03 wiring note:** `withMcpResult` EXECUTES the thunk and resolves to the result — it is not a function-returning wrapper. Usage: `async (args) => withMcpResult(() => handleRecall(args))`. Error text shape: `{"ok":false,"code":<RelayError code or 'UNKNOWN'>,"message":<redacted>}`.

## Task Commits

1. **Task 1: Pin + verify MCP SDK; surface probe (MCP-05)** — `814c7f2` (feat)
2. **Task 2: result.ts boundary helpers (MCP-04)** — `67ab003` (feat)

_The 09-01 executor's commit `2f5d326` interleaved between them (shared tree, lock-serialized — expected.)_

## Files Created/Modified

- `src/mcp/sdk-probe.ts` — resolveMcpSdk + verified subpath constants; CONFIG_ERROR/MCP_SDK_UNRESOLVED failure mapping; version read walks up from `require.resolve` past the SDK's dist stub package.jsons
- `src/mcp/sdk-probe.test.ts` — real-package resolution, injected-failure coding, missing-export coding, stdout-silence, subpath constants
- `src/mcp/result.ts` — toMcpResult / relayErrorToMcpResult / withMcpResult with redactSecrets on all serialized text
- `src/mcp/result.test.ts` — all six planned behaviors + no-mutation, null-throw, RelayException routing, success-path redaction; secret fixtures built at runtime from parts
- `package.json` / `package-lock.json` — exact pin

## Decisions Made

1. **CONFIG_ERROR over a new ErrorCode:** the plan suggested "e.g. MCP_SDK_UNRESOLVED" as a code; `ErrorCode` is a closed union in shared `src/errors.ts`, which sits outside both concurrent executors' write sets. Editing it risked a concurrent-edit clobber with the 09-01 executor. Used existing `CONFIG_ERROR` with the greppable `MCP_SDK_UNRESOLVED:` message prefix instead.
2. **1.29.0 over the v2 alpha:** the official org is mid-split toward `@modelcontextprotocol/server@2.x`, but only alpha exists; exact-pinning a stable release wins.
3. **`src/tools/mcp-result.ts` left untouched:** its 3 callers (compare-runs, get_memory, browse_runs) are non-MCP paths outside this plan's write set; migrating them would change existing behavior, violating the "existing CLI unchanged" truth.
4. **One atomic commit per task** (orchestrator git discipline) instead of separate test→feat TDD commits; RED→GREEN order was still followed in development (stub → failing tests verified → implementation → green), with a compiling stub so the shared tree never broke the other executor's builds.
5. **Full-suite run consolidated to the task 2 window** (single run) instead of per-task, to cap build-lock hold time against the concurrent 09-01 executor; a better-sqlite3 ABI canary ran right after `npm install` instead (passed — no rebuild needed).

## Deviations from Plan

None requiring auto-fix rules — both tasks executed as specified. The decisions above are implementation choices within plan latitude (the plan's error code was an "e.g.", the supersede instruction had an explicit else-branch).

## Issues Encountered

**Pre-existing time-bomb failures in `src/control/control-e2e.test.ts` (NOT caused by this plan):** the final full suite showed 1817/1819 pass with 2 deterministic failures, both grant-dependent Phase 8 control tests. Root cause: the test pins `T0 = 1_781_000_000_000` (2026-06-09T10:13:20Z) and grants with `ttl_ms: 600_000`, while the send path checks expiry against real `Date.now()` (`broker.ts` `checkGrant`). The grants expired permanently at 10:23:20Z today — after Phase 8's green merge yesterday, hours before this execution. Evidence: lockfile diff outside the SDK tree is 0 lines; `src/control/` untouched by both executors; 3 identical isolated reruns. Logged with forensics and a suggested fix in `deferred-items.md` (out of scope per deviation rules — unrelated file, pre-existing).

## Test Count vs Baseline

- Full suite at completion: **1819 tests, 1817 pass, 2 fail** (the pre-existing time bombs above; 0 failures in plan-owned or plan-touched code)
- Baseline ~1804 + 15 new from this plan (5 sdk-probe + 10 result); the in-flight 09-01 executor's compiled tests may also be included in the total
- Targeted: `dist/mcp/sdk-probe.test.js` 5/5, `dist/mcp/result.test.js` 10/10; `npm run typecheck` clean

## User Setup Required

None beyond what was pre-approved: the SDK install (supply-chain gate above) was the plan's single `user_setup` item and was authorized this session.

## Next Phase Readiness

- Plan 03 can register `relay_memory_recall`/`relay_memory_save` wrapping `handleRecall`/`handleRemember` with `withMcpResult`; schemas already exported from `src/contracts/memory.ts`
- Plan 04 instantiates `McpServer`/`StdioServerTransport` strictly via `resolveMcpSdk()`
- Plan 05 should use `InMemoryTransport.createLinkedPair()` + `Client` (verified shipped — see surface table)
- Blocker to track (not blocking MCP work): the 2 expired control-e2e tests will keep the full suite red until fixed (deferred-items.md)

## Self-Check: PASSED

All 6 claimed files exist on disk; commits `814c7f2` and `67ab003` exist in git; exact pin `"@modelcontextprotocol/sdk": "1.29.0"` confirmed in package.json; grep gates confirmed (redactSecrets in both result.ts paths, 0 SDK refs in result.ts).

---
*Phase: 09-mcp-server*
*Completed: 2026-06-09*
