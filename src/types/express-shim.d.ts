// Minimal ambient declaration for the `express` runtime the MCP SDK's auth
// stack pulls in (express is a transitive dependency of @modelcontextprotocol/sdk;
// its handlers ARE express middleware). We deliberately do NOT add `@types/express`
// as a dependency — only the narrow surface the OAuth HTTP server touches is typed
// here, so the build stays strict-clean with zero new packages.
//
// Scope: enough to construct an app, mount routers/middleware (the SDK's
// mcpAuthRouter / requireBearerAuth, which themselves type as `any` under
// skipLibCheck), parse bodies, and write a tiny consent response. Anything not
// declared here is intentionally out of bounds for this module.
declare module 'express' {
  import type { IncomingMessage, ServerResponse, Server } from 'node:http';

  /** Request as seen by our own middleware. Bodies/queries are untyped JSON. */
  export interface Request extends IncomingMessage {
    readonly method: string;
    readonly query: Record<string, string | string[] | undefined>;
    body: unknown;
    readonly path: string;
  }

  /** Response surface our consent gate + error paths use. */
  export interface Response extends ServerResponse {
    status(code: number): Response;
    json(body: unknown): Response;
    send(body: string): Response;
    set(field: string, value: string): Response;
    setHeader(field: string, value: string): Response;
    redirect(status: number, url: string): void;
    redirect(url: string): void;
    type(contentType: string): Response;
  }

  export type NextFunction = (err?: unknown) => void;
  export type RequestHandler = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

  export interface Application {
    use(...handlers: unknown[]): Application;
    use(path: string, ...handlers: unknown[]): Application;
    get(path: string, ...handlers: RequestHandler[]): Application;
    post(path: string, ...handlers: RequestHandler[]): Application;
    all(path: string, ...handlers: RequestHandler[]): Application;
    set(setting: string, value: unknown): Application;
    listen(port: number, host: string, callback: () => void): Server;
  }

  export interface Express {
    (): Application;
    json(options?: unknown): RequestHandler;
    urlencoded(options?: unknown): RequestHandler;
    Router(options?: unknown): unknown;
  }

  const express: Express;
  export default express;
}
