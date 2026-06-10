# 09-04 Summary — server assembly + relay mcp CLI

**Status:** COMPLETE (code committed by executor in 86e41b6 + c2f7332; executor was stopped before writing this summary — acceptance verification re-run and this doc written by the orchestrator 2026-06-10).

## What shipped

- `src/mcp/server.ts` — `startMcpServer(deps?)`:
  - SDK surface ONLY via `resolveMcpSdk()` (injectable for tests); never a direct SDK import.
  - Identity: `MCP_SERVER_NAME = 'relay'`; version = caller-passed CLI VERSION, else a package.json walk from the compiled module (`readOwnVersion()`, throws coded `CONFIG_ERROR` / `MCP_SERVER_VERSION_UNRESOLVED` if unresolvable).
  - Registers EXACTLY `['relay_memory_recall', 'relay_memory_save']` from `buildMemoryMcpTools()` via `server.registerTool(t.name, t.config, t.handler)`. Registration order preserved in `handle.toolNames`.
  - 09-03's readonly-content vs SDK mutable-content variance handled AT the registration call site (`McpServerLike.registerTool(name, config: unknown, handler: unknown)`) — result.ts / tools-memory.ts contracts untouched, exactly per the 09-03 caveat.
  - Shutdown: hooks the SDK's underlying `server.onclose` (chained, prior handler preserved) → resolves `handle.closed`; `handle.shutdown()` idempotent, closes server, always resolves `closed` (belt-and-suspenders even if an SDK variant skips onclose).
  - Writes to NEITHER standard stream (module has zero logging).

- `src/cli/cmd-mcp.ts` — `executeMcpCommand({version, start?, signals?}, io)`:
  - Lazy-imports startMcpServer (injectable); blocks on `handle.closed`.
  - Exit codes: 0 = clean close (disconnect or signal-driven graceful shutdown); 1 = failed start (e.g. SDK unresolved), message on stderr.
  - SIGINT/SIGTERM → `handle.shutdown()` (idempotent; listeners removed on exit). Signal source injectable.
  - ALL human-facing output on `io.stderr` (startup notice lists tool names); stdout never touched by this layer — the SDK transport owns the wire.

- `src/cli.ts` — additive only: `MCP SERVER` help section + `if (cmd === 'mcp')` lazy-dispatch branch passing `VERSION`.

## Acceptance verification (re-run 2026-06-10 by orchestrator)

- `grep -c "console.log|process.stdout" src/mcp/server.ts src/cli/cmd-mcp.ts` → 0/0.
- `grep -c "broker|control" src/mcp/server.ts` → 0 (killed scope structurally absent).
- `relay --help` contains the MCP SERVER section; all prior sections intact.
- `git diff main..phase-9-v04 -- src/cli.ts`: +21/−5 total — ALL 5 removals are 09-01's planned closed-union kill in the run dispatcher; 09-04's contribution is purely additive (help + branch).
- Full suite after c2f7332: **1894 tests / 1892 pass** — the 2 failures are the pre-existing Phase 8 control-e2e time bombs (absolute-date grant fixtures), tracked in BACKLOG.md.

## For Plan 05 (integration test wiring)

- Connect a real client via the SDK's `InMemoryTransport.createLinkedPair()` (availability verified in 09-02-SUMMARY): pass one end as `deps.transport` to `startMcpServer({version, transport})`, hand the other to an SDK `Client`. `tools/list` must return exactly the two names above.
- `handle.closed` resolves on client disconnect — use it to assert clean teardown.
- The startup notice goes to stderr only — assert stdout silence at the cmd-mcp layer via injected io + fake start.
- Server version for assertions: pass an explicit `version` in deps (tests shouldn't depend on package.json walking).
