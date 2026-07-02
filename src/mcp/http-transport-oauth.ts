// src/mcp/http-transport-oauth.ts — `relay mcp --http --oauth`: the OAuth 2.1 +
// PKCE door onto the SAME memory tools the stdio path serves, so ChatGPT's
// connector can authenticate and reach Relay's memory.
//
// This sits ALONGSIDE the static-token http path (http-transport.ts), which is
// unchanged. Here, instead of a single shared bearer token, we run a real
// (single-owner) OAuth authorization server via the SDK's auth router and gate
// the /mcp endpoint with the SDK's bearer middleware. The memory tools, and ALL
// their write guards (source 'worker-mcp', trust 'unverified', redaction,
// workdir scoping, no pinned/source_run_id), are inherited untouched because we
// mount the exact same buildMemoryMcpTools() surface the stdio server registers.
//
// Endpoints (mounted at app root, per the SDK contract):
//   GET  /.well-known/oauth-authorization-server   (RFC 8414 AS metadata, S256)
//   GET  /.well-known/oauth-protected-resource[/mcp] (RFC 9728 PRM, audience)
//   GET|POST /authorize   (owner-secret consent gate -> SDK authorize -> code)
//   POST /token           (SDK token handler: PKCE-verified code -> access token)
//   POST /register        (RFC 7591 DCR — ChatGPT registers its client)
//   POST /revoke          (RFC 7009)
//   ALL  /mcp             (bearer-gated StreamableHTTP — 401 without a valid token)
//
// Session lifecycle (ported from relay-mcp): Map<sessionId,{transport,createdAt}>,
// insert-on-init / delete-on-close, a hard concurrent-session cap enforced at
// new-session creation (503 over the cap), and a TTL sweep that closes and
// evicts stale sessions.
import { createServer, type Server } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { RelayOAuthProvider } from './oauth-provider.js';
import { buildMemoryMcpTools } from './tools-memory.js';
import { MCP_SERVER_NAME } from './server.js';
import type { HttpMcpHandle } from './http-transport.js';

export interface OAuthHttpMcpOptions {
  readonly version: string;
  readonly port: number;
  readonly host?: string; // default 127.0.0.1
  /**
   * Optional owner secret. When set, /authorize requires it (entered once via a
   * tiny local consent form), and the server starts on any bind. When unset, the
   * server REFUSES to start unless `allowNoAuth` is also set — a loopback bind is
   * NOT accepted as a substitute, because a tunnel forwards remote traffic into it.
   */
  readonly ownerSecret?: string;
  /** Public base URL the AS issues metadata for. Default http://127.0.0.1:<port>. */
  readonly publicUrl?: string;
  /**
   * Deliberate opt-in to run the OAuth door with NO authentication on /authorize
   * (auto-approve), i.e. an unauthenticated memory bank. Wired from
   * RELAY_MCP_DANGEROUSLY_ALLOW_NO_AUTH. Default false → the server REFUSES to
   * start without an owner secret. See unsafeAutoApproveReason for why a loopback
   * bind is NOT accepted as a substitute for this flag (a tunnel forwards remote
   * traffic into the loopback bind, so "bound to loopback" ≠ "not reachable").
   */
  readonly allowNoAuth?: boolean;
  /** Access-token TTL seconds (default 3600). Surfaced for tests. */
  readonly accessTokenTtlSeconds?: number;
  /** Authorization-code TTL seconds (default 60). Surfaced for tests. */
  readonly codeTtlSeconds?: number;
  /** Max concurrent MCP sessions (default 1000). */
  readonly maxSessions?: number;
  /**
   * File where the OAuth provider persists client registrations + token hashes
   * across restarts (see RelayOAuthProviderOptions.persistPath). Unset = in-memory.
   */
  readonly oauthStatePath?: string;
}

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_SESSIONS = 1000;
const SCOPES = ['mcp'] as const;
/**
 * Minimum owner-secret length when one IS configured. Mirrors the static-token
 * path's >=16 floor (http-transport.ts): a network-reachable memory bank must
 * not be gated by a trivially guessable secret. Absence of a secret is governed
 * separately — it requires the explicit RELAY_MCP_DANGEROUSLY_ALLOW_NO_AUTH
 * opt-in (see unsafeAutoApproveReason below).
 */
const MIN_OWNER_SECRET_LEN = 16;

/**
 * The deliberate, scary opt-in env var an operator must set to run /authorize in
 * auto-approve (no-owner-secret) mode. Named in the SDK's own house style
 * (cf. MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL) so it cannot be enabled by
 * accident and reads as dangerous at the call site.
 */
export const ALLOW_NO_AUTH_ENV = 'RELAY_MCP_DANGEROUSLY_ALLOW_NO_AUTH';

/**
 * SECURITY GATE — the fix for the prior round's high-severity hole, reworked.
 *
 * Prior rounds inferred "safe to auto-approve" from the BIND HOST being loopback.
 * That is a false equivalence: the shipped deployment model is a userspace tunnel
 * (cloudflared / ngrok / `ssh -R`) that terminates locally and forwards REMOTE
 * traffic into the 127.0.0.1 bind. The kernel sees that traffic as loopback, and
 * the tunnel client's own socket is loopback too — so NOTHING observable at the
 * server (bind host, the request's remote socket address, the absence of a
 * RELAY_MCP_PUBLIC_URL) distinguishes "genuinely local-only" from "tunnelled to
 * the public internet". An operator who tunnels but forgets RELAY_MCP_PUBLIC_URL
 * previously sailed straight through the gate, leaving /register + /authorize +
 * /token wide open to any caller who learned the tunnel hostname.
 *
 * The rework removes the inference entirely. Auto-approve (no owner secret) is
 * NEVER granted implicitly. It is granted ONLY when the operator sets the
 * explicit RELAY_MCP_DANGEROUSLY_ALLOW_NO_AUTH opt-in, which is a deliberate "I
 * accept an unauthenticated memory door" acknowledgement no tunnel can forge.
 * Otherwise the server REFUSES to start unless a strong owner secret closes the
 * door. Loopback bind grants nothing.
 *
 * Returns an error message when the configuration is unsafe, or undefined when
 * it is safe to start.
 */
function unsafeAutoApproveReason(args: {
  ownerSecret?: string;
  allowNoAuth: boolean;
}): string | undefined {
  const hasSecret = args.ownerSecret !== undefined && args.ownerSecret.length > 0;

  // A provided-but-weak secret is rejected outright: if you set a gate, set a
  // real one. (This fires regardless of the no-auth opt-in — a half-length
  // secret is worse than an honest "no secret + explicit dangerous flag".)
  if (hasSecret && (args.ownerSecret as string).length < MIN_OWNER_SECRET_LEN) {
    return (
      `relay mcp --http --oauth refuses to start: RELAY_MCP_OWNER_SECRET is too short ` +
      `(${(args.ownerSecret as string).length} chars, need >=${MIN_OWNER_SECRET_LEN}). A network-reachable ` +
      `memory bank must not be gated by a trivially guessable secret.`
    );
  }

  // Owner secret present and strong enough → fully gated, any bind/tunnel is fine.
  if (hasSecret) return undefined;

  // No owner secret. Auto-approve would be in effect. This is tolerable ONLY
  // when the operator has explicitly opted in — a loopback bind proves nothing
  // because a tunnel forwards remote traffic into it.
  if (args.allowNoAuth) return undefined;

  return (
    `relay mcp --http --oauth refuses to start: no RELAY_MCP_OWNER_SECRET is set, so ` +
    `/authorize would auto-approve and any caller able to reach this endpoint — including ` +
    `over a tunnel that forwards remote traffic into the loopback bind — could run ` +
    `register -> authorize -> token and mint a valid memory token with no human in the loop. ` +
    `A loopback bind is NOT proof of non-reachability and is not accepted as a substitute. ` +
    `Set RELAY_MCP_OWNER_SECRET (>=${MIN_OWNER_SECRET_LEN} chars), or, for a genuinely ` +
    `local-only machine with no tunnel, set ${ALLOW_NO_AUTH_ENV}=1 to accept an ` +
    `unauthenticated memory door deliberately.`
  );
}

/** Build a fresh McpServer with the same memory tools the stdio server registers. */
function buildServer(version: string): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version });
  for (const tool of buildMemoryMcpTools()) {
    server.registerTool(tool.name, tool.config as never, tool.handler as never);
  }
  return server;
}

/** Constant-time secret compare (avoids leaking the owner secret length-wise). */
function secretMatches(expected: string, provided: string): boolean {
  const e = Buffer.from(expected, 'utf8');
  const p = Buffer.from(provided, 'utf8');
  if (e.length !== p.length) return false;
  return timingSafeEqual(e, p);
}

/** HTML-escape a value before reflecting it into the consent form. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The owner-secret consent gate for /authorize. Mounted BEFORE the SDK's
 * authorization handler. With no secret configured it is a pass-through
 * (auto-approve) — which the startup gate only permits when the operator set the
 * explicit RELAY_MCP_DANGEROUSLY_ALLOW_NO_AUTH opt-in. With a secret configured:
 *   - if the request already carries a matching owner_secret (query or body),
 *     it calls next() and the SDK handler issues the code;
 *   - otherwise it returns a minimal HTML form that re-POSTs to /authorize,
 *     carrying every original OAuth param as a hidden field plus a password
 *     field for the secret. The SDK handler reads params from req.body on POST
 *     and ignores the extra owner_secret field.
 * The secret is compared in constant time and never leaves localhost.
 */
function makeAuthorizeConsentGate(ownerSecret: string | undefined) {
  // OAuth params we must round-trip through the consent form so the SDK handler
  // sees a complete request on the POST.
  const OAUTH_PARAMS = [
    'client_id',
    'redirect_uri',
    'response_type',
    'code_challenge',
    'code_challenge_method',
    'scope',
    'state',
    'resource',
  ] as const;

  return (req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): void => {
    if (!ownerSecret) {
      next();
      return;
    }
    const source: Record<string, unknown> =
      req.method === 'POST'
        ? ((req.body as Record<string, unknown> | undefined) ?? {})
        : (req.query as Record<string, unknown>);
    const suppliedRaw = source['owner_secret'];
    const supplied = typeof suppliedRaw === 'string' ? suppliedRaw : '';
    if (supplied && secretMatches(ownerSecret, supplied)) {
      next();
      return;
    }
    // Render the consent form, preserving the original OAuth params.
    const hidden = OAUTH_PARAMS.map((name) => {
      const v = source[name];
      if (typeof v !== 'string' || v.length === 0) return '';
      return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(v)}">`;
    }).join('\n      ');
    const wrong = supplied ? '<p style="color:#b00">Incorrect owner secret.</p>' : '';
    const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Relay — authorize connector</title></head>
<body style="font-family:system-ui;max-width:30rem;margin:4rem auto">
  <h1>Authorize this connector</h1>
  <p>A client is requesting access to your Relay memory. Enter the owner secret to approve.</p>
  ${wrong}
  <form method="POST" action="/authorize">
      ${hidden}
    <label>Owner secret<br><input type="password" name="owner_secret" autofocus style="width:100%"></label>
    <p><button type="submit">Approve</button></p>
  </form>
</body></html>`;
    res.status(supplied ? 401 : 200).set('Content-Type', 'text/html').send(html);
  };
}

/**
 * Start the OAuth-gated StreamableHTTP MCP server. Resolves once listening;
 * block on the returned handle's `closed`. The returned shape matches the
 * static-token path's HttpMcpHandle so the CLI command treats both uniformly.
 */
export async function startOAuthHttpMcpServer(opts: OAuthHttpMcpOptions): Promise<HttpMcpHandle> {
  const host = opts.host ?? '127.0.0.1';
  const maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const toolNames = buildMemoryMcpTools().map((t) => t.name);

  // SECURITY GATE (must precede binding): refuse to start when /authorize would
  // auto-approve (no owner secret) without the operator's explicit
  // RELAY_MCP_DANGEROUSLY_ALLOW_NO_AUTH opt-in. This closes the prior round's
  // hole: a loopback bind is no longer treated as proof of non-reachability,
  // because a tunnel forwards remote traffic into it. See unsafeAutoApproveReason.
  const unsafe = unsafeAutoApproveReason({
    ...(opts.ownerSecret !== undefined ? { ownerSecret: opts.ownerSecret } : {}),
    allowNoAuth: opts.allowNoAuth === true,
  });
  if (unsafe) {
    throw new Error(unsafe);
  }

  // Bind FIRST so an ephemeral port (port 0, used by tests and by callers that
  // let the OS pick) is known before we build the discovery metadata — the
  // issuer, PRM, and canonical-resource URLs must carry the REAL port a client
  // will connect to, not 0. A request listener is attached after the app exists.
  const httpServer: Server = createServer();
  await new Promise<void>((resolve, reject) => {
    const onErr = (e: Error): void => reject(e);
    httpServer.once('error', onErr);
    httpServer.listen(opts.port, host, () => {
      httpServer.off('error', onErr);
      resolve();
    });
  });
  const boundAddr = httpServer.address();
  const boundPort =
    typeof boundAddr === 'object' && boundAddr !== null ? boundAddr.port : opts.port;
  // IPv6 literals must be bracketed to form a valid URL authority
  // (http://[::1]:port, not http://::1:port). A name or IPv4 is used as-is.
  const hostForUrl = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const publicUrl = (opts.publicUrl ?? `http://${hostForUrl}:${boundPort}`).replace(/\/$/, '');
  const issuerUrl = new URL(publicUrl);
  const canonicalResource = `${publicUrl}/mcp`;

  const provider = new RelayOAuthProvider({
    canonicalResource,
    ...(opts.oauthStatePath !== undefined ? { persistPath: opts.oauthStatePath } : {}),
    ...(opts.accessTokenTtlSeconds !== undefined
      ? { accessTokenTtlSeconds: opts.accessTokenTtlSeconds }
      : {}),
    ...(opts.codeTtlSeconds !== undefined ? { codeTtlSeconds: opts.codeTtlSeconds } : {}),
    scopes: SCOPES,
  });

  const transports = new Map<string, { transport: StreamableHTTPServerTransport; createdAt: number }>();

  const app = express();
  app.set('x-powered-by', false);
  // Behind a tunnel/proxy (cloudflared, ngrok, OpenAI's tunnel) the real client IP
  // arrives in X-Forwarded-For and the immediate peer is loopback. Trust ONLY loopback
  // so express-rate-limit reads the real caller without letting a remote client spoof
  // X-Forwarded-For to dodge the rate limit. Without this, requests through the tunnel
  // (i.e. every ChatGPT request) throw ERR_ERL_UNEXPECTED_X_FORWARDED_FOR and fail.
  app.set('trust proxy', 'loopback');
  // Request log (stderr) — every method/path/status, so a failing client flow
  // (register/authorize/token/mcp) is diagnosable instead of silent. Enable with
  // RELAY_MCP_HTTP_LOG=1. Never logs headers/bodies (tokens/secrets stay out of logs).
  if (process.env['RELAY_MCP_HTTP_LOG'] === '1') {
    app.use((req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): void => {
      res.on('finish', () => {
        process.stderr.write(`[mcp-http] ${req.method} ${req.path} -> ${res.statusCode}\n`);
      });
      next();
    });
  }

  // Owner-secret consent gate runs ahead of the SDK's authorization handler.
  app.use('/authorize', express.urlencoded({ extended: false }), makeAuthorizeConsentGate(opts.ownerSecret));

  // The SDK authorization-server router: metadata + /authorize + /token +
  // /register (DCR, because provider.clientsStore.registerClient exists) +
  // /revoke (because provider.revokeToken exists). issuerUrl is 127.0.0.1, which
  // the SDK exempts from its HTTPS requirement for local use.
  app.use(
    mcpAuthRouter({
      provider: provider as never,
      issuerUrl,
      baseUrl: issuerUrl,
      resourceServerUrl: new URL(canonicalResource),
      scopesSupported: [...SCOPES],
      resourceName: 'Relay memory',
    }) as never,
  );

  // Resource-server bearer gate: /mcp rejects any request without a valid,
  // unexpired, audience-correct token. The PRM URL is advertised in the
  // WWW-Authenticate header on 401 so a client can discover the AS.
  const bearer = requireBearerAuth({
    verifier: provider as never,
    requiredScopes: [...SCOPES],
    resourceMetadataUrl: `${publicUrl}/.well-known/oauth-protected-resource/mcp`,
  }) as never;

  // Parse JSON bodies for /mcp so the transport receives the pre-parsed body
  // (StreamableHTTPServerTransport.handleRequest accepts an optional parsedBody).
  const jsonBody = express.json() as never;

  const handleMcp = async (
    req: import('express').Request & { auth?: unknown },
    res: import('express').Response,
  ): Promise<void> => {
    const rawId = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(rawId) ? rawId[0] : rawId;
    const existing = sessionId ? transports.get(sessionId) : undefined;

    if (existing) {
      await existing.transport.handleRequest(req as never, res as never, (req as { body?: unknown }).body);
      return;
    }

    // No (known) session. Only a new-session POST may allocate one; anything
    // else with an unknown id is a stale/invalid session.
    if (sessionId) {
      res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
      return;
    }
    if (req.method !== 'POST') {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request' }, id: null });
      return;
    }
    // Concurrent-session cap (ported from relay-mcp): refuse to allocate over
    // the ceiling rather than grow unbounded. Existing sessions are unaffected.
    if (transports.size >= maxSessions) {
      res.status(503).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Too many sessions' }, id: null });
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string): void => {
        transports.set(id, { transport, createdAt: Date.now() });
      },
      onsessionclosed: (id: string): void => {
        transports.delete(id);
      },
    });
    transport.onclose = (): void => {
      const id = transport.sessionId;
      if (id) transports.delete(id);
    };
    await buildServer(opts.version).connect(transport);
    await transport.handleRequest(req as never, res as never, (req as { body?: unknown }).body);
  };

  const mcpEntry = (req: import('express').Request, res: import('express').Response): void => {
    void handleMcp(req as never, res).catch(() => {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
      }
    });
  };
  app.use('/mcp', bearer, jsonBody, mcpEntry);

  // The listener is already bound (above); attach the fully-built app now.
  httpServer.on('request', app as never);

  // TTL sweep: close + evict stale sessions, and reap expired OAuth codes/tokens.
  // unref()'d so it never keeps the process alive on its own.
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of transports) {
      if (now - entry.createdAt > SESSION_TTL_MS) {
        // Port caveat: close the transport on eviction so its OS resources are
        // released, not just the Map slot.
        void Promise.resolve(entry.transport.close()).catch(() => {});
        transports.delete(id);
      }
    }
    provider.cleanupExpired(now);
  }, CLEANUP_INTERVAL_MS);
  cleanup.unref();

  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => {
    resolveClosed = r;
  });
  httpServer.on('close', () => resolveClosed());

  const shutdown = async (): Promise<void> => {
    clearInterval(cleanup);
    for (const { transport } of transports.values()) {
      try {
        await transport.close();
      } catch {
        /* best-effort */
      }
    }
    transports.clear();
    await new Promise<void>((r) => httpServer.close(() => r()));
    return closed;
  };

  return { url: canonicalResource, toolNames, closed, shutdown };
}
