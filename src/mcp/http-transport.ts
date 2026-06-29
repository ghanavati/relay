// src/mcp/http-transport.ts — `relay mcp --http`: serve the SAME memory tools over
// a remote StreamableHTTP transport, so any HTTPS MCP client (a ChatGPT connector, a
// remote Cursor, a hosted bank you point multiple models at) reaches the SAME memory
// bank the stdio path serves. This is the door that makes Relay model-neutral instead
// of stdio-only (which only Claude/Codex/Cursor-local could reach).
//
// Security posture — non-negotiable for a network-reachable memory bank:
//   - a bearer token is REQUIRED (RELAY_MCP_TOKEN, >=16 chars); no token, no server.
//   - binds to 127.0.0.1 by default — exposing it to the internet is the operator's
//     deployment choice (a tunnel / hosted endpoint) and must sit behind TLS.
//   - ChatGPT's connector UI expects OAuth; the SDK ships an `auth` module for that.
//     This is the token-gated foundation it layers onto — NOT a substitute for TLS
//     + OAuth before public exposure. Stated plainly so it isn't mistaken for "done".
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildMemoryMcpTools } from './tools-memory.js';
import { MCP_SERVER_NAME } from './server.js';

export interface HttpMcpOptions {
  readonly version: string;
  readonly port: number;
  readonly host?: string; // default 127.0.0.1
  readonly token: string; // required bearer token (>=16 chars)
}

export interface HttpMcpHandle {
  readonly url: string;
  readonly toolNames: readonly string[];
  readonly closed: Promise<void>;
  readonly shutdown: () => Promise<void>;
}

/** Build a fresh McpServer with the same memory tools the stdio server registers. */
function buildServer(version: string): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version });
  for (const tool of buildMemoryMcpTools()) {
    // Same registration the stdio path uses; the tool builders own the shapes.
    server.registerTool(tool.name, tool.config as never, tool.handler as never);
  }
  return server;
}

/**
 * Start a token-gated StreamableHTTP MCP server. Per the SDK's stateful pattern,
 * each client session gets its own transport + McpServer; requests route by the
 * `mcp-session-id` header. Resolves once listening; block on `closed`.
 */
export async function startHttpMcpServer(opts: HttpMcpOptions): Promise<HttpMcpHandle> {
  if (!opts.token || opts.token.length < 16) {
    throw new Error(
      'relay mcp --http requires RELAY_MCP_TOKEN (>=16 chars): a network-reachable ' +
        'memory bank must be authenticated. Refusing to start without it.',
    );
  }
  const host = opts.host ?? '127.0.0.1';
  const expected = `Bearer ${opts.token}`;
  const toolNames = buildMemoryMcpTools().map((t) => t.name);
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const auth = req.headers['authorization'] ?? '';
    // Length-check first so a wrong-length header can't be probed char-by-char.
    if (auth.length !== expected.length || auth !== expected) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const raw = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(raw) ? raw[0] : raw;
    let transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string): void => {
          transports.set(id, transport as StreamableHTTPServerTransport);
        },
        onsessionclosed: (id: string): void => {
          transports.delete(id);
        },
      });
      await buildServer(opts.version).connect(transport);
    }
    await transport.handleRequest(req, res);
  };

  const httpServer: Server = createServer((req, res) => {
    void route(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal', message: String(err).slice(0, 200) }));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onErr = (e: Error): void => reject(e);
    httpServer.once('error', onErr);
    httpServer.listen(opts.port, host, () => {
      httpServer.off('error', onErr);
      resolve();
    });
  });

  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => {
    resolveClosed = r;
  });
  httpServer.on('close', () => resolveClosed());

  const shutdown = async (): Promise<void> => {
    for (const t of transports.values()) {
      try {
        await t.close();
      } catch {
        /* best-effort */
      }
    }
    transports.clear();
    await new Promise<void>((r) => httpServer.close(() => r()));
    return closed;
  };

  return { url: `http://${host}:${opts.port}/mcp`, toolNames, closed, shutdown };
}
