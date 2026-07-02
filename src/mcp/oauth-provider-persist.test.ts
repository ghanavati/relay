/**
 * OAuth state persistence — the fix for "every `relay mcp --http --oauth`
 * restart wipes client registrations, so ChatGPT throws Invalid client_id and
 * the connector must be removed + re-added by hand".
 *
 * Contract pinned here:
 *   - registered clients and issued token HASHES survive a provider restart
 *     when `persistPath` is set (the supervisor restarts the pair on every
 *     tunnel hiccup — restarts are the NORMAL case, not the exception);
 *   - refresh-token rotation is durable (a rotated-away token stays dead
 *     across restarts — replaying an old refresh token after a crash fails);
 *   - one-time auth codes are NOT persisted (60s TTL, mid-handshake state);
 *   - a corrupt state file degrades to empty + self-heals on next save,
 *     never crashing the server;
 *   - the state file is owner-only (0600), like the owner-secret file;
 *   - the HTTP server wires it through: register -> restart -> /authorize
 *     still recognizes the client.
 */

process.env['RELAY_DB_PATH'] = ':memory:';
delete process.env['RELAY_MEMORY_ALLOWED_WORKDIRS'];
delete process.env['RELAY_EMBEDDING_MODEL'];

import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayOAuthProvider } from './oauth-provider.js';
import { startOAuthHttpMcpServer } from './http-transport-oauth.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

const REDIRECT = 'https://chatgpt.com/connector/oauth/test-callback';
const RESOURCE = 'http://127.0.0.1:8765/mcp';

const CLIENT = {
  client_id: 'chatgpt-connector-test',
  client_id_issued_at: Math.floor(Date.now() / 1000),
  client_name: 'persist-test',
  redirect_uris: [REDIRECT],
  token_endpoint_auth_method: 'none',
} as unknown as OAuthClientInformationFull;

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function freshStatePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'relay-oauth-state-')), 'mcp-oauth-state.json');
}

function makeProvider(persistPath: string): RelayOAuthProvider {
  return new RelayOAuthProvider({ canonicalResource: RESOURCE, persistPath });
}

/** Run the authorize step and return the one-time code from the redirect. */
async function mintCode(p: RelayOAuthProvider): Promise<string> {
  let redirected = '';
  await p.authorize(
    CLIENT,
    { codeChallenge: s256('v'.repeat(43)), redirectUri: REDIRECT },
    { redirect: (_status: number, url: string): void => { redirected = url; } },
  );
  const code = new URL(redirected).searchParams.get('code');
  assert.ok(code, 'authorize must redirect back with ?code');
  return code;
}

/** Full register -> authorize -> exchange on one provider instance. */
async function registerAndMint(p: RelayOAuthProvider): Promise<{ access: string; refresh: string }> {
  p.clientsStore.registerClient(CLIENT as unknown as Parameters<RelayOAuthProvider['clientsStore']['registerClient']>[0]);
  const code = await mintCode(p);
  const tokens = await p.exchangeAuthorizationCode(CLIENT, code, undefined, REDIRECT);
  assert.ok(tokens.access_token);
  assert.ok(tokens.refresh_token);
  return { access: tokens.access_token, refresh: tokens.refresh_token! };
}

describe('oauth-provider persistence', () => {
  test('clients and tokens survive a provider restart', async () => {
    const statePath = freshStatePath();
    const { access, refresh } = await registerAndMint(makeProvider(statePath));

    const p2 = makeProvider(statePath); // simulated restart
    assert.ok(p2.clientsStore.getClient(CLIENT.client_id), 'client registration must survive');
    const auth = await p2.verifyAccessToken(access);
    assert.strictEqual(auth.clientId, CLIENT.client_id);
    const rotated = await p2.exchangeRefreshToken(CLIENT, refresh);
    assert.ok(rotated.access_token, 'refresh grant must work after restart');
  });

  test('refresh-token rotation is durable across restarts', async () => {
    const statePath = freshStatePath();
    const { refresh } = await registerAndMint(makeProvider(statePath));

    const p2 = makeProvider(statePath);
    const rotated = await p2.exchangeRefreshToken(CLIENT, refresh);

    const p3 = makeProvider(statePath);
    await assert.rejects(
      p3.exchangeRefreshToken(CLIENT, refresh),
      /Invalid refresh token/,
      'rotated-away refresh token must stay dead after restart',
    );
    const again = await p3.exchangeRefreshToken(CLIENT, rotated.refresh_token!);
    assert.ok(again.access_token, 'current refresh token must still work');
  });

  test('one-time auth codes are not persisted', async () => {
    const statePath = freshStatePath();
    const p1 = makeProvider(statePath);
    p1.clientsStore.registerClient(CLIENT as unknown as Parameters<RelayOAuthProvider['clientsStore']['registerClient']>[0]);
    const code = await mintCode(p1);

    const p2 = makeProvider(statePath);
    await assert.rejects(
      p2.challengeForAuthorizationCode(CLIENT, code),
      /Invalid authorization code/,
      'mid-handshake codes must not survive a restart',
    );
  });

  test('corrupt state file starts empty and self-heals on next save', async () => {
    const statePath = freshStatePath();
    writeFileSync(statePath, 'not json {', 'utf8');

    const p = makeProvider(statePath); // must not throw
    assert.strictEqual(p.clientsStore.getClient(CLIENT.client_id), undefined);

    await registerAndMint(p);
    const reparsed = JSON.parse(readFileSync(statePath, 'utf8')) as { clients: unknown[] };
    assert.strictEqual(reparsed.clients.length, 1, 'next save must rewrite a valid file');
  });

  test('state file is owner-only (0600)', async () => {
    const statePath = freshStatePath();
    await registerAndMint(makeProvider(statePath));
    const mode = statSync(statePath).mode & 0o777;
    assert.strictEqual(mode, 0o600);
  });

  test('raw tokens never appear in the state file, only hashes', async () => {
    const statePath = freshStatePath();
    const { access, refresh } = await registerAndMint(makeProvider(statePath));
    const raw = readFileSync(statePath, 'utf8');
    assert.ok(!raw.includes(access), 'access token must be stored hash-only');
    assert.ok(!raw.includes(refresh), 'refresh token must be stored hash-only');
  });
});

describe('http server wiring', () => {
  test('a registered client survives a server restart', async () => {
    const statePath = freshStatePath();
    const start = (): ReturnType<typeof startOAuthHttpMcpServer> =>
      startOAuthHttpMcpServer({
        version: 'test',
        port: 0,
        allowNoAuth: true, // loopback test server, no tunnel — the deliberate opt-in
        oauthStatePath: statePath,
      });

    const s1 = await start();
    const base = s1.url.replace(/\/mcp$/, '');
    const reg = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'persist-test',
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
      }),
    });
    assert.strictEqual(reg.status, 201, 'dynamic client registration must succeed');
    const { client_id: clientId } = (await reg.json()) as { client_id: string };
    await s1.shutdown();

    const s2 = await start();
    const base2 = s2.url.replace(/\/mcp$/, '');
    try {
      const authorize = new URL(`${base2}/authorize`);
      authorize.searchParams.set('response_type', 'code');
      authorize.searchParams.set('client_id', clientId);
      authorize.searchParams.set('redirect_uri', REDIRECT);
      authorize.searchParams.set('code_challenge', s256('w'.repeat(43)));
      authorize.searchParams.set('code_challenge_method', 'S256');
      const res = await fetch(authorize, { redirect: 'manual' });
      assert.strictEqual(res.status, 302, 'client registered before restart must still be recognized');
      const location = res.headers.get('location') ?? '';
      assert.ok(location.includes('code='), 'authorize must mint a code for the surviving client');
    } finally {
      await s2.shutdown();
    }
  });
});
