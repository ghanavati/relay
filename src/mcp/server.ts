// src/mcp/server.ts — assemble the stdio MCP server (Phase 9 / Plan 04).
//
// On start: resolve the verified SDK surface (resolveMcpSdk — never a direct
// SDK import, MCP-05/T-09-12), build an McpServer with a truthful identity,
// register EXACTLY the two memory tools from Plan 03 (D-07: the killed scope
// stays structurally absent — this module imports nothing beyond the probe,
// the tool builders, and the error helpers), then connect the transport.
//
// Wire discipline (T-09-11): the MCP protocol owns the process's standard
// streams once the transport connects. This module writes to NEITHER stream —
// no logging of any kind lives here; the human-facing notice is the CLI
// command layer's job and goes to its error stream.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveMcpSdk } from './sdk-probe.js';
import type { ResolvedMcpSdk } from './sdk-probe.js';
import { buildMemoryMcpTools } from './tools-memory.js';
import { makeError, toRelayException } from '../errors.js';

/** Server identity an MCP client sees on initialize. */
export const MCP_SERVER_NAME = 'relay';

/**
 * The slice of the SDK's McpServer this module relies on. The constructors
 * from resolveMcpSdk are deliberately loose (the probe is SDK-shape-agnostic);
 * this interface pins the verified 1.29.0 call surface structurally.
 *
 * Note on the handler boundary: Plan 03's handlers return a readonly-content
 * McpToolResult while the SDK's CallToolResult content is mutable — the
 * runtime shapes are identical, so the adaptation happens HERE at the
 * registration call site (params typed unknown), never by loosening the
 * result.ts / tools-memory.ts contracts (09-03 caveat).
 */
interface McpServerLike {
  registerTool(name: string, config: unknown, handler: unknown): unknown;
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
  readonly server?: { onclose?: (() => void) | undefined };
}

export interface StartMcpServerDeps {
  /**
   * Server version reported to clients. The CLI dispatcher passes its VERSION
   * constant (the `relay --version` truth); when absent, the version is read
   * from this package's own package.json — the same file npm versions, so the
   * identity stays truthful for direct callers too.
   */
  readonly version?: string;
  /** Injected SDK surface for tests; defaults to resolveMcpSdk(). */
  readonly sdk?: ResolvedMcpSdk;
  /** Injected transport for tests; defaults to a new stdio transport. */
  readonly transport?: unknown;
}

export interface McpServerHandle {
  /** The constructed McpServer (loose-typed: the SDK owns its surface). */
  readonly server: unknown;
  /** Exactly the tool names registered, in registration order. */
  readonly toolNames: readonly string[];
  /** Resolves when the connection closes — client disconnect or shutdown(). */
  readonly closed: Promise<void>;
  /** Proactively close the server. Idempotent; resolves once closed. */
  readonly shutdown: () => Promise<void>;
}

/**
 * Read the version of the relay package this module ships in: walk up from
 * the compiled file to the first package.json carrying a string version
 * (skips any extensionless stubs; node_modules sit below us, never above).
 */
function readOwnVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        version?: unknown;
      };
      if (typeof parsed.version === 'string' && parsed.version.length > 0) {
        return parsed.version;
      }
    } catch {
      // No package.json at this level — keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw toRelayException(
    makeError(
      'CONFIG_ERROR',
      'MCP_SERVER_VERSION_UNRESOLVED: could not locate a package.json with a version above ' +
        'the compiled server module — pass an explicit version to startMcpServer().',
      false,
      'mcp'
    )
  );
}

/**
 * Build, register, connect. Resolves once the transport is connected and
 * returns a handle the caller blocks on (`closed`) and shuts down with.
 */
export async function startMcpServer(deps: StartMcpServerDeps = {}): Promise<McpServerHandle> {
  const sdk = deps.sdk ?? (await resolveMcpSdk());
  const version = deps.version ?? readOwnVersion();
  const server = new sdk.McpServer({ name: MCP_SERVER_NAME, version }) as McpServerLike;

  const toolNames: string[] = [];
  for (const tool of buildMemoryMcpTools()) {
    server.registerTool(tool.name, tool.config, tool.handler);
    toolNames.push(tool.name);
  }

  // The SDK chains transport close → underlying protocol server onclose; hook
  // it before connect so a client disconnect resolves `closed` and the process
  // can exit instead of dangling on a dead connection.
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const underlying = server.server;
  if (underlying) {
    const prior = underlying.onclose;
    underlying.onclose = () => {
      prior?.();
      resolveClosed();
    };
  }

  const transport = deps.transport ?? new sdk.StdioServerTransport();
  await server.connect(transport);

  let shutdownStarted = false;
  const shutdown = async (): Promise<void> => {
    if (!shutdownStarted) {
      shutdownStarted = true;
      try {
        await server.close();
      } catch {
        // Already closed (e.g. the client disconnected first) — fine.
      }
      // Belt and suspenders: never leave `closed` dangling even if an SDK
      // variant skipped the onclose chain.
      resolveClosed();
    }
    return closed;
  };

  return { server, toolNames, closed, shutdown };
}
