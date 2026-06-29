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
  /** `--http`: serve over a token-gated remote StreamableHTTP transport instead of stdio. */
  readonly http?: boolean;
  /** `--port` for HTTP mode (default 8765). */
  readonly port?: number;
  /** Bearer token for HTTP mode (RELAY_MCP_TOKEN). Required when http is set (static-token path). */
  readonly token?: string;
  /**
   * `--oauth`: serve the HTTP transport behind an OAuth 2.1 + PKCE authorization
   * server (the path ChatGPT's connector needs) instead of a static bearer token.
   * Requires --http. Mutually exclusive with the static-token path at runtime.
   */
  readonly oauth?: boolean;
  /**
   * Owner secret gating /authorize in OAuth mode (RELAY_MCP_OWNER_SECRET). When
   * absent, the OAuth server REFUSES to start unless allowNoAuth is also set —
   * a loopback bind is not accepted as a substitute (a tunnel forwards remote
   * traffic into it).
   */
  readonly ownerSecret?: string;
  /**
   * Deliberate opt-in (RELAY_MCP_DANGEROUSLY_ALLOW_NO_AUTH) to run /authorize in
   * auto-approve mode with NO owner secret — an unauthenticated memory door,
   * for a genuinely local-only machine with no tunnel.
   */
  readonly allowNoAuth?: boolean;
  /** Public base URL the OAuth AS advertises (RELAY_MCP_PUBLIC_URL); default http://host:port. */
  readonly publicUrl?: string;
  /** Test injection; defaults to the lazy-imported startMcpServer. */
  readonly start?: McpStartFn;
  /** Test injection; defaults to process. */
  readonly signals?: McpSignalSource;
}

/** Minimal shape shared by the stdio and HTTP server handles. */
interface RunningMcp {
  readonly toolNames: readonly string[];
  readonly closed: Promise<void>;
  readonly shutdown: () => Promise<void>;
}

/**
 * Start the stdio MCP server and block until it closes. Exit codes:
 * 0 = clean close (client disconnect or signal-driven graceful shutdown),
 * 1 = the server failed to start (e.g. SDK surface unresolved) OR a
 *     signal-driven shutdown failed for a real reason (review fix 6 — an
 *     already-closed connection is swallowed by the handle, not here).
 */
export async function executeMcpCommand(args: McpCommandArgs, io: CliIO): Promise<number> {
  const signals: McpSignalSource = args.signals ?? process;

  let handle: RunningMcp;
  if (args.http && args.oauth) {
    // OAuth door — the path ChatGPT's connector needs: an OAuth 2.1 + PKCE
    // authorization server fronts the SAME memory bank as stdio. /mcp rejects
    // any request without a valid token; /authorize is gated by the owner
    // secret. Bound to localhost; put TLS in front before public exposure.
    const { startOAuthHttpMcpServer } = await import('../mcp/http-transport-oauth.js');
    try {
      const oauth = await startOAuthHttpMcpServer({
        version: args.version,
        port: args.port ?? 8765,
        ...(args.ownerSecret !== undefined ? { ownerSecret: args.ownerSecret } : {}),
        ...(args.allowNoAuth ? { allowNoAuth: true } : {}),
        ...(args.publicUrl !== undefined ? { publicUrl: args.publicUrl } : {}),
      });
      handle = oauth;
      // The server REFUSES to start in auto-approve mode unless the operator set
      // the explicit RELAY_MCP_DANGEROUSLY_ALLOW_NO_AUTH opt-in (a loopback bind
      // is NOT accepted as a substitute), so reaching here with no secret means
      // the operator deliberately accepted an unauthenticated memory door.
      const gate = args.ownerSecret
        ? 'owner-secret consent (RELAY_MCP_OWNER_SECRET)'
        : 'AUTO-APPROVE, NO AUTH (RELAY_MCP_DANGEROUSLY_ALLOW_NO_AUTH set) — anyone who can reach /authorize gets a memory token; do NOT expose this beyond a trusted local machine';
      io.stderr(
        `relay mcp: OAuth MCP server on ${oauth.url} (v${args.version}) — tools: ` +
          `${oauth.toolNames.join(', ')}. OAuth 2.1 + PKCE; /authorize gate: ${gate}. ` +
          `Put TLS in front before public/ChatGPT exposure.\n`
      );
    } catch (err) {
      io.stderr(`relay mcp --http --oauth: failed to start — ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  } else if (args.http) {
    // Remote door — any HTTPS MCP client (a ChatGPT connector, remote Cursor, a
    // hosted bank) reaches the SAME memory bank as stdio. Token-gated, localhost-bound.
    const { startHttpMcpServer } = await import('../mcp/http-transport.js');
    try {
      const http = await startHttpMcpServer({
        version: args.version,
        port: args.port ?? 8765,
        token: args.token ?? '',
      });
      handle = http;
      io.stderr(
        `relay mcp: HTTP MCP server on ${http.url} (v${args.version}) — tools: ` +
          `${http.toolNames.join(', ')}. Bearer token required (RELAY_MCP_TOKEN); bound to ` +
          `localhost — put TLS + OAuth in front before public/ChatGPT exposure.\n`
      );
    } catch (err) {
      io.stderr(`relay mcp --http: failed to start — ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  } else {
    const start = args.start ?? (await import('../mcp/server.js')).startMcpServer;
    try {
      handle = await start({ version: args.version });
    } catch (err) {
      io.stderr(`relay mcp: failed to start — ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    io.stderr(
      `relay mcp: stdio MCP server started (v${args.version}) — tools: ` +
        `${handle.toolNames.join(', ')}. Diagnostics on stderr; the protocol owns the wire.\n`
    );
  }

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
