// src/cli/cmd-mcp.ts — `relay mcp`: start the stdio MCP server (Phase 9 / Plan 04).
//
// Wire discipline (T-09-11): once the server connects, the MCP protocol owns
// this process's standard streams — the SDK transport reads requests from one
// and writes framed responses to the other. This command therefore NEVER
// touches io's first stream; every human-facing diagnostic goes to io.stderr.
// A single stray write to the wire would corrupt the framing and desync the
// client (guarded by test).
//
// The command blocks until the connection closes: client disconnect resolves
// the handle's closed promise, and SIGINT/SIGTERM route through the handle's
// graceful shutdown (then this function returns and the dispatcher exits).
import type { CliIO } from './commands.js';
import type { McpServerHandle, StartMcpServerDeps } from '../mcp/server.js';

/** startMcpServer's shape — injectable so tests never open real stdio. */
export type McpStartFn = (deps?: StartMcpServerDeps) => Promise<McpServerHandle>;

type McpSignalName = 'SIGINT' | 'SIGTERM';

/** The slice of process used for signal wiring — injectable for tests. */
export interface McpSignalSource {
  on(event: McpSignalName, listener: () => void): unknown;
  removeListener(event: McpSignalName, listener: () => void): unknown;
}

export interface McpCommandArgs {
  /** The CLI VERSION — the server reports it as its identity to clients. */
  readonly version: string;
  /** Test injection; defaults to the lazy-imported startMcpServer. */
  readonly start?: McpStartFn;
  /** Test injection; defaults to process. */
  readonly signals?: McpSignalSource;
}

/**
 * Start the stdio MCP server and block until it closes. Exit codes:
 * 0 = clean close (client disconnect or signal-driven graceful shutdown),
 * 1 = the server failed to start (e.g. SDK surface unresolved) OR a
 *     signal-driven shutdown failed for a real reason (review fix 6 — an
 *     already-closed connection is swallowed by the handle, not here).
 */
export async function executeMcpCommand(args: McpCommandArgs, io: CliIO): Promise<number> {
  const start = args.start ?? (await import('../mcp/server.js')).startMcpServer;
  const signals: McpSignalSource = args.signals ?? process;

  let handle: McpServerHandle;
  try {
    handle = await start({ version: args.version });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.stderr(`relay mcp: failed to start — ${message}\n`);
    return 1;
  }

  io.stderr(
    `relay mcp: stdio MCP server started (v${args.version}) — tools: ` +
      `${handle.toolNames.join(', ')}. Diagnostics on stderr; the protocol owns the wire.\n`
  );

  let shutdownResult: Promise<void> | undefined;
  const onSignal = (): void => {
    // Idempotent: a second signal while shutdown is in flight is a no-op.
    if (!shutdownResult) {
      shutdownResult = handle.shutdown();
      // Sink the rejection HERE so it can never become an unhandled-rejection
      // crash between the signal and `closed` resolving; the original promise
      // is re-awaited below, where the failure maps to stderr + exit 1.
      shutdownResult.catch(() => {});
    }
  };
  signals.on('SIGINT', onSignal);
  signals.on('SIGTERM', onSignal);
  try {
    await handle.closed;
  } finally {
    signals.removeListener('SIGINT', onSignal);
    signals.removeListener('SIGTERM', onSignal);
  }
  if (shutdownResult) {
    try {
      await shutdownResult;
    } catch (err) {
      // Review fix 6: a real close failure (the handle already swallowed the
      // benign already-closed case) surfaces on stderr with a nonzero exit.
      const message = err instanceof Error ? err.message : String(err);
      io.stderr(`relay mcp: shutdown failed — ${message}\n`);
      return 1;
    }
  }
  return 0;
}
