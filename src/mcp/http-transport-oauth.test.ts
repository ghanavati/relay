/**
 * Phase 9 / v0.4 — `relay mcp --http --oauth`: the OAuth 2.1 + PKCE door onto the
 * SAME memory tools the stdio path serves, so a ChatGPT connector can authenticate.
 *
 * These tests drive a REAL server (startOAuthHttpMcpServer) over a real loopback
 * socket on an ephemeral port, exercising the actual SDK auth router + bearer
 * middleware + the single-owner RelayOAuthProvider — not mocks. They pin the
 * contract the SCOPE requires:
 *   - /mcp rejects any request without a valid token (401)
 *   - PKCE is enforced: a wrong / missing code_verifier is rejected
 *   - discovery metadata has the shape ChatGPT fetches (AS metadata + PRM)
 *   - an expired access token is rejected
 * plus the end-to-end happy path (DCR -> authorize -> token -> /mcp initialize),
 * so "green unit tests, dead live surface" cannot recur for the OAuth path.
 */

process.env['RELAY_DB_PATH'] = ':memory:';
delete process.env['RELAY_MEMORY_ALLOWED_WORKDIRS'];
delete process.env['RELAY_EMBEDDING_MODEL'];

import { describe, test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { startOAuthHttpMcpServer } from './http-transport-oauth.js';
import type { HttpMcpHandle } from './http-transport.js';

const REDIRECT = 'https://chatgpt.com/connector/oauth/test-callback';

/**
 * Start a local-only OAuth server for the functional suites below. These run
 * with NO owner secret, which the security gate refuses by default (a loopback
 * bind is not proof of non-reachability — a tunnel forwards into it). The
 * RELAY_MCP_DANGEROUSLY_ALLOW_NO_AUTH opt-in, modelled here as allowNoAuth:true,
 * is the deliberate "this machine has no tunnel" acknowledgement; the test
 * harness binds an ephemeral loopback port with no tunnel, so it is the
 * legitimate auto-approve case. The dedicated security describe block at the
 * bottom pins that the opt-in is REQUIRED and not inferred.
 */
function startLocalOAuthServer(
  extra: Record<string, unknown> = {},
): Promise<HttpMcpHandle> {
  return startOAuthHttpMcpServer({ version: 'test', port: 0, allowNoAuth: true, ...extra });
}

/** S256 PKCE challenge: base64url(sha256(verifier)) — matches pkce-challenge. */
function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

interface Discovery {
  readonly base: string; // http://127.0.0.1:<port>
  readonly resource: string; // <base>/mcp
  readonly asMeta: Record<string, unknown>;
}

/** Fetch the AS metadata document and derive base/resource URLs. */
async function discover(handle: HttpMcpHandle): Promise<Discovery> {
  const base = handle.url.replace(/\/mcp$/, '');
  const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
  assert.strictEqual(res.status, 200, 'AS metadata must be served');
  const asMeta = (await res.json()) as Record<string, unknown>;
  return { base, resource: handle.url, asMeta };
}

/** Register a public client via DCR. */
async function registerClient(asMeta: Record<string, unknown>): Promise<string> {
  const res = await fetch(asMeta['registration_endpoint'] as string, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'chatgpt-test',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  assert.strictEqual(res.status, 201, 'DCR must create the client');
  const client = (await res.json()) as { client_id: string; client_secret?: string };
  assert.ok(client.client_id, 'a client_id is issued');
  assert.strictEqual(client.client_secret, undefined, 'public client gets no secret');
  return client.client_id;
}

/** Run /authorize (auto-approve path) and return the issued code. */
async function authorizeForCode(
  d: Discovery,
  clientId: string,
  challenge: string,
): Promise<string> {
  const url = new URL(d.asMeta['authorization_endpoint'] as string);
  for (const [k, v] of Object.entries({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'mcp',
    state: 'state-123',
    resource: d.resource,
  })) {
    url.searchParams.set(k, v);
  }
  const res = await fetch(url, { redirect: 'manual' });
  assert.strictEqual(res.status, 302, 'authorize auto-approves with a redirect');
  const loc = res.headers.get('location');
  assert.ok(loc, 'redirect carries a Location');
  const target = new URL(loc as string);
  assert.strictEqual(target.searchParams.get('state'), 'state-123', 'state is round-tripped');
  const code = target.searchParams.get('code');
  assert.ok(code, 'an authorization code is issued');
  return code as string;
}

/** Exchange a code for tokens at /token. Returns the raw fetch Response. */
function exchangeCode(
  d: Discovery,
  clientId: string,
  code: string,
  codeVerifier: string | undefined,
): Promise<Response> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    resource: d.resource,
  });
  if (codeVerifier !== undefined) body.set('code_verifier', codeVerifier);
  return fetch(d.asMeta['token_endpoint'] as string, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
}

/** POST an MCP `initialize` to /mcp with the given bearer token (or none). */
function mcpInitialize(resource: string, token: string | undefined): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (token !== undefined) headers['authorization'] = `Bearer ${token}`;
  return fetch(resource, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    }),
  });
}

describe('relay mcp --http --oauth — token required on /mcp', () => {
  let handle: HttpMcpHandle;
  before(async () => {
    handle = await startLocalOAuthServer();
  });
  after(async () => {
    await handle.shutdown();
  });

  test('POST /mcp with no Authorization header → 401 with WWW-Authenticate', async () => {
    const res = await mcpInitialize(handle.url, undefined);
    assert.strictEqual(res.status, 401, 'unauthenticated /mcp must be rejected');
    const www = res.headers.get('www-authenticate');
    assert.ok(www, 'a WWW-Authenticate header is present');
    assert.match(www as string, /Bearer/, 'Bearer scheme advertised');
    assert.match(
      www as string,
      /resource_metadata="[^"]*\/\.well-known\/oauth-protected-resource\/mcp"/,
      'PRM URL advertised so the client can discover the AS',
    );
    await res.body?.cancel();
  });

  test('POST /mcp with a bogus token → 401', async () => {
    const res = await mcpInitialize(handle.url, 'relay_at_not-a-real-token');
    assert.strictEqual(res.status, 401, 'an invalid token must be rejected');
    await res.body?.cancel();
  });
});

describe('relay mcp --http --oauth — PKCE verification', () => {
  let handle: HttpMcpHandle;
  let d: Discovery;
  let clientId: string;
  before(async () => {
    handle = await startLocalOAuthServer();
    d = await discover(handle);
    clientId = await registerClient(d.asMeta);
  });
  after(async () => {
    await handle.shutdown();
  });

  test('wrong code_verifier → 400 invalid_grant', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const code = await authorizeForCode(d, clientId, s256(verifier));
    const res = await exchangeCode(d, clientId, code, 'a-completely-different-verifier');
    assert.strictEqual(res.status, 400, 'a mismatched verifier is rejected');
    const body = (await res.json()) as { error?: string };
    assert.strictEqual(body.error, 'invalid_grant', 'OAuth invalid_grant error code');
  });

  test('missing code_verifier → rejected (not a 200 token)', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const code = await authorizeForCode(d, clientId, s256(verifier));
    const res = await exchangeCode(d, clientId, code, undefined);
    assert.notStrictEqual(res.status, 200, 'no token without a verifier');
    assert.ok(res.status >= 400, 'an error status is returned');
    await res.body?.cancel().catch(() => {});
  });

  test('correct code_verifier → 200 with an audience-bound access token', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const code = await authorizeForCode(d, clientId, s256(verifier));
    const res = await exchangeCode(d, clientId, code, verifier);
    assert.strictEqual(res.status, 200, 'matching verifier yields a token');
    const tokens = (await res.json()) as {
      access_token?: string;
      token_type?: string;
      expires_in?: number;
      refresh_token?: string;
    };
    assert.ok(tokens.access_token, 'access_token issued');
    assert.strictEqual(tokens.token_type, 'Bearer', 'Bearer token type');
    assert.ok((tokens.expires_in ?? 0) > 0, 'a positive expires_in');
    assert.ok(tokens.refresh_token, 'a rotating refresh token is issued (OAuth 2.1 public client)');

    // And that token actually opens /mcp.
    const init = await mcpInitialize(handle.url, tokens.access_token);
    assert.strictEqual(init.status, 200, 'the issued token opens /mcp');
    assert.ok(init.headers.get('mcp-session-id'), 'a session id is assigned');
    await init.body?.cancel();
  });

  test('a one-time code cannot be replayed', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const code = await authorizeForCode(d, clientId, s256(verifier));
    const first = await exchangeCode(d, clientId, code, verifier);
    assert.strictEqual(first.status, 200, 'first exchange succeeds');
    await first.body?.cancel().catch(() => {});
    const second = await exchangeCode(d, clientId, code, verifier);
    assert.strictEqual(second.status, 400, 'a replayed code is rejected');
    const body = (await second.json()) as { error?: string };
    assert.strictEqual(body.error, 'invalid_grant', 'replay → invalid_grant');
  });
});

describe('relay mcp --http --oauth — discovery metadata shape', () => {
  let handle: HttpMcpHandle;
  before(async () => {
    handle = await startLocalOAuthServer();
  });
  after(async () => {
    await handle.shutdown();
  });

  test('AS metadata advertises authorize/token/register + S256 + grant types', async () => {
    const d = await discover(handle);
    const m = d.asMeta;
    assert.strictEqual(m['issuer'], `${d.base}/`, 'issuer is the server origin');
    assert.strictEqual(m['authorization_endpoint'], `${d.base}/authorize`);
    assert.strictEqual(m['token_endpoint'], `${d.base}/token`);
    assert.strictEqual(m['registration_endpoint'], `${d.base}/register`, 'DCR endpoint present');
    assert.deepStrictEqual(
      m['code_challenge_methods_supported'],
      ['S256'],
      'PKCE S256 advertised (absence would make ChatGPT refuse)',
    );
    assert.deepStrictEqual(m['response_types_supported'], ['code']);
    assert.deepStrictEqual(
      m['grant_types_supported'],
      ['authorization_code', 'refresh_token'],
      'authorization_code + refresh_token grants',
    );
    assert.ok(
      Array.isArray(m['token_endpoint_auth_methods_supported']) &&
        (m['token_endpoint_auth_methods_supported'] as string[]).includes('none'),
      'public-client auth method (none) advertised for ChatGPT',
    );
  });

  test('protected-resource metadata names the AS and the canonical resource', async () => {
    const d = await discover(handle);
    const res = await fetch(`${d.base}/.well-known/oauth-protected-resource/mcp`);
    assert.strictEqual(res.status, 200, 'PRM is served at the RFC 9728 path');
    const prm = (await res.json()) as {
      resource?: string;
      authorization_servers?: string[];
      scopes_supported?: string[];
    };
    assert.strictEqual(prm.resource, d.resource, 'PRM resource is the canonical /mcp URI');
    assert.ok(
      Array.isArray(prm.authorization_servers) && prm.authorization_servers.includes(`${d.base}/`),
      'PRM lists this AS in authorization_servers',
    );
    assert.ok(
      Array.isArray(prm.scopes_supported) && prm.scopes_supported.includes('mcp'),
      'PRM advertises the mcp scope',
    );
  });
});

describe('relay mcp --http --oauth — token expiry rejected', () => {
  let handle: HttpMcpHandle;
  let d: Discovery;
  let clientId: string;
  before(async () => {
    // 1-second access-token TTL so the test can observe expiry without waiting long.
    handle = await startLocalOAuthServer({ accessTokenTtlSeconds: 1 });
    d = await discover(handle);
    clientId = await registerClient(d.asMeta);
  });
  after(async () => {
    await handle.shutdown();
  });

  test('a token valid before its TTL is rejected after it expires', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const code = await authorizeForCode(d, clientId, s256(verifier));
    const tokenRes = await exchangeCode(d, clientId, code, verifier);
    assert.strictEqual(tokenRes.status, 200);
    const { access_token } = (await tokenRes.json()) as { access_token: string };

    const before = await mcpInitialize(handle.url, access_token);
    assert.strictEqual(before.status, 200, 'token works before expiry');
    await before.body?.cancel();

    await new Promise((r) => setTimeout(r, 1100));

    const after = await mcpInitialize(handle.url, access_token);
    assert.strictEqual(after.status, 401, 'token rejected after expiry');
    assert.match(
      after.headers.get('www-authenticate') ?? '',
      /expired/i,
      'WWW-Authenticate explains the token expired',
    );
    await after.body?.cancel();
  });
});

describe('relay mcp --http --oauth — owner-secret consent gate', () => {
  let handle: HttpMcpHandle;
  let d: Discovery;
  let clientId: string;
  const SECRET = 'owner-secret-for-tests-1234';
  before(async () => {
    handle = await startOAuthHttpMcpServer({ version: 'test', port: 0, ownerSecret: SECRET });
    d = await discover(handle);
    clientId = await registerClient(d.asMeta);
  });
  after(async () => {
    await handle.shutdown();
  });

  function authorizeUrl(challenge: string): URL {
    const url = new URL(d.asMeta['authorization_endpoint'] as string);
    for (const [k, v] of Object.entries({
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'mcp',
      state: 'st',
      resource: d.resource,
    })) {
      url.searchParams.set(k, v);
    }
    return url;
  }

  test('GET /authorize without the secret returns the consent form (no code)', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const res = await fetch(authorizeUrl(s256(verifier)), { redirect: 'manual' });
    assert.strictEqual(res.status, 200, 'consent form, not a redirect');
    assert.match(res.headers.get('content-type') ?? '', /text\/html/, 'an HTML form');
    assert.match(await res.text(), /owner_secret/, 'the form asks for the owner secret');
  });

  test('POST /authorize with the correct secret issues a code', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const body = new URLSearchParams({
      owner_secret: SECRET,
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: s256(verifier),
      code_challenge_method: 'S256',
      scope: 'mcp',
      state: 'st',
      resource: d.resource,
    });
    const res = await fetch(d.asMeta['authorization_endpoint'] as string, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'manual',
    });
    assert.strictEqual(res.status, 302, 'correct secret approves and redirects');
    const loc = new URL(res.headers.get('location') as string);
    assert.ok(loc.searchParams.get('code'), 'a code is issued after consent');
  });

  test('POST /authorize with a wrong secret does not issue a code', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const body = new URLSearchParams({
      owner_secret: 'definitely-the-wrong-secret',
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: s256(verifier),
      code_challenge_method: 'S256',
      scope: 'mcp',
      resource: d.resource,
    });
    const res = await fetch(d.asMeta['authorization_endpoint'] as string, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'manual',
    });
    assert.strictEqual(res.status, 401, 'wrong secret is rejected');
    assert.strictEqual(res.headers.get('location'), null, 'no redirect, so no code leaks');
  });
});

// The high-severity hole the prior round shipped, and the rework that closes it.
//
// PRIOR HOLE: the gate inferred "safe to auto-approve" from the BIND HOST being
// loopback. But the shipped deployment model is a tunnel (cloudflared/ngrok/ssh -R)
// that forwards REMOTE traffic into the 127.0.0.1 bind, which the kernel — and the
// gate — saw as loopback. An operator who tunnelled but forgot RELAY_MCP_PUBLIC_URL
// sailed through, leaving /register + /authorize + /token open to any caller who
// learned the tunnel hostname (a full unauthenticated memory token, no human).
//
// REWORK: auto-approve (no owner secret) is NEVER inferred from the bind. It is
// granted ONLY when the operator sets the explicit RELAY_MCP_DANGEROUSLY_ALLOW_NO_AUTH
// opt-in (modelled as allowNoAuth:true). Loopback bind grants nothing. These tests
// pin: refusal by default (incl. the exact loopback-bind tunnel case), the opt-in
// path, and that a strong owner secret opens any bind including a public tunnel URL.
describe('relay mcp --http --oauth — auto-approve requires an explicit opt-in, never a loopback inference', () => {
  const STRONG_SECRET = 'owner-secret-strong-enough-1234'; // >=16 chars

  test('REGRESSION (tunnel hole): loopback bind + no owner secret + no opt-in → refuses to start', async () => {
    // This is the exact prior-hole configuration: a default loopback bind with no
    // owner secret. Previously it started with /authorize wide open; a tunnel into
    // it then exposed the memory bank. It MUST now refuse, and the message must
    // name the tunnel risk and the opt-in env var (so the loopback bind is not
    // mistaken for proof of safety).
    await assert.rejects(
      () => startOAuthHttpMcpServer({ version: 'test', port: 0 }),
      (err: Error) => {
        assert.match(err.message, /refuses to start/i);
        assert.match(err.message, /tunnel/i, 'names the tunnel-into-loopback risk');
        assert.match(err.message, /loopback bind is NOT proof/i, 'rejects the loopback false-equivalence explicitly');
        assert.match(err.message, /RELAY_MCP_DANGEROUSLY_ALLOW_NO_AUTH/, 'points at the explicit opt-in');
        assert.match(err.message, /RELAY_MCP_OWNER_SECRET/, 'points at the owner-secret alternative');
        return true;
      },
      'a default loopback bind with no secret and no opt-in must be refused',
    );
  });

  test('non-loopback publicUrl + no owner secret + no opt-in → refuses to start', async () => {
    await assert.rejects(
      () =>
        startOAuthHttpMcpServer({
          version: 'test',
          port: 0,
          publicUrl: 'https://relay.example.com',
        }),
      /refuses to start[\s\S]*RELAY_MCP_OWNER_SECRET/i,
      'a public origin without an owner secret is an open memory bank and must be refused',
    );
  });

  test('wildcard bind host (0.0.0.0) + no owner secret + no opt-in → refuses to start', async () => {
    await assert.rejects(
      () => startOAuthHttpMcpServer({ version: 'test', port: 0, host: '0.0.0.0' }),
      /refuses to start/i,
      'binding all interfaces without an owner secret must be refused',
    );
  });

  test('no owner secret + explicit allowNoAuth opt-in → starts (deliberate local-only auto-approve)', async () => {
    const handle = await startOAuthHttpMcpServer({ version: 'test', port: 0, allowNoAuth: true });
    try {
      assert.ok(handle.url.startsWith('http://127.0.0.1:'), 'bound to loopback');
    } finally {
      await handle.shutdown();
    }
  });

  test('explicit allowNoAuth does NOT override a too-short owner secret → still refuses', async () => {
    // A half-length secret is worse than an honest "no secret + dangerous flag":
    // it looks gated but is trivially guessable. The weak-secret refusal fires
    // regardless of the opt-in.
    await assert.rejects(
      () => startOAuthHttpMcpServer({ version: 'test', port: 0, ownerSecret: 'short', allowNoAuth: true }),
      /too short/i,
      'a trivially guessable owner secret must be refused even with the no-auth opt-in',
    );
  });

  test('non-loopback publicUrl WITH a strong owner secret → starts (secret closes the door)', async () => {
    // The supported gated-tunnel deployment: the owner secret closes the
    // auto-approve door, so any bind — including a public tunnel origin — is fine.
    // Resolving without a throw IS the assertion. (handle.url is the public
    // origin, not locally reachable, so we only prove startup succeeded.)
    const handle = await startOAuthHttpMcpServer({
      version: 'test',
      port: 0,
      publicUrl: 'https://relay.example.com',
      ownerSecret: STRONG_SECRET,
    });
    try {
      assert.strictEqual(handle.url, 'https://relay.example.com/mcp', 'advertises the gated public origin');
    } finally {
      await handle.shutdown();
    }
  });

  test('a too-short owner secret (no opt-in) → refuses to start (weak gate rejected)', async () => {
    await assert.rejects(
      () => startOAuthHttpMcpServer({ version: 'test', port: 0, ownerSecret: 'short' }),
      /too short/i,
      'a trivially guessable owner secret must be refused',
    );
  });
});
