// src/mcp/oauth-provider.ts — single-owner OAuth 2.1 + PKCE authorization-server
// provider for `relay mcp --http --oauth`, so a ChatGPT connector can authenticate
// and reach the SAME memory tools the stdio path serves.
//
// Scope discipline: this adds an AUTHORIZATION layer in front of the existing
// StreamableHTTP `/mcp` endpoint. It touches NOTHING in memory/dispatch — the
// tools, their write guards (source 'worker-mcp', trust 'unverified', redaction,
// workdir scoping, no pinned/source_run_id) are unchanged and inherited because
// the OAuth server mounts the exact same buildMemoryMcpTools() surface.
//
// Single-owner model (MINIMAL): there is one owner, no user database, no
// GitHub/Google login. /authorize is auto-approved; an optional owner secret
// (RELAY_MCP_OWNER_SECRET) gates it via a tiny local consent form (enforced in
// the server module's middleware, not here). This provider owns the OAuth
// mechanics the SDK's auth router delegates to:
//   - PKCE-bound (S256) auth codes (the SDK verifies code_verifier against the
//     challenge we return from challengeForAuthorizationCode);
//   - one-time code -> access-token exchange;
//   - audience binding (RFC 8707 resource) onto the issued token, re-checked on
//     verifyAccessToken so a token for another resource is rejected;
//   - rotating refresh tokens for the public client (OAuth 2.1 requirement);
//   - opaque bearer tokens stored hash-only, never in cleartext.
//
// We implement OAuthServerProvider structurally rather than importing it as a
// nominal type, because the SDK's provider.d.ts imports express types that are
// not installed (we ship no @types/express); the structural shape is asserted by
// passing this instance straight into mcpAuthRouter / requireBearerAuth.
import {
  randomUUID,
  randomBytes,
  createHash,
  timingSafeEqual,
} from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  InvalidGrantError,
  InvalidTokenError,
  InvalidClientError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';

/** A registered OAuth client (single-owner: created on first DCR call). */
type StoredClient = OAuthClientInformationFull;

/** A PKCE-bound authorization code, one-time, short-lived. */
interface StoredCode {
  readonly clientId: string;
  readonly codeChallenge: string; // S256 challenge; SDK verifies the verifier against it
  readonly redirectUri: string;
  readonly resource: string | undefined; // RFC 8707 audience the token will carry
  readonly scopes: readonly string[];
  readonly expiresAt: number; // ms epoch
}

/** An issued access or refresh token, persisted hash-only. */
interface StoredToken {
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly resource: string | undefined;
  readonly expiresAt: number; // ms epoch
}

/** JSON shape written to persistPath — Map entries as [key, value] pairs. */
interface PersistedState {
  readonly version: 1;
  readonly clients: ReadonlyArray<readonly [string, StoredClient]>;
  readonly accessTokens: ReadonlyArray<readonly [string, StoredToken]>;
  readonly refreshTokens: ReadonlyArray<readonly [string, StoredToken]>;
}

export interface RelayOAuthProviderOptions {
  /**
   * Canonical resource identifier this MCP server is the audience for
   * (e.g. http://127.0.0.1:8765/mcp). When a request carries an RFC 8707
   * `resource`, it is bound onto the issued token and re-validated on every
   * verifyAccessToken — a token minted for a different resource is rejected.
   */
  readonly canonicalResource: string;
  /** Access-token lifetime in seconds (default 3600). */
  readonly accessTokenTtlSeconds?: number;
  /** Authorization-code lifetime in seconds (default 60). */
  readonly codeTtlSeconds?: number;
  /** Scopes this server advertises/grants. Default ['mcp']. */
  readonly scopes?: readonly string[];
  /**
   * When set, registered clients and issued token HASHES are persisted to this
   * JSON file (owner-only 0600, atomic tmp+rename) and reloaded on construction,
   * so a server restart no longer invalidates the ChatGPT connector ("Invalid
   * client_id" after every tunnel-supervisor restart). One-time auth codes stay
   * memory-only. Unset = fully in-memory (stdio path, tests).
   */
  readonly persistPath?: string;
}

const DEFAULT_ACCESS_TTL_S = 60 * 60; // 1 hour
const DEFAULT_CODE_TTL_S = 60; // 1 minute
const DEFAULT_SCOPES = ['mcp'] as const;

/** sha256 hex of a secret — what we persist instead of the raw token. */
function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Constant-time hex-string compare (both inputs are sha256 hex, fixed length). */
function timingSafeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * The single-owner OAuth provider. One instance is shared between the SDK's
 * authorization-server router (mcpAuthRouter) and the resource-server bearer
 * middleware (requireBearerAuth) — the same verifyAccessToken serves both.
 */
export class RelayOAuthProvider {
  private readonly clients = new Map<string, StoredClient>();
  private readonly codes = new Map<string, StoredCode>(); // key: raw code (one-time, in-memory only)
  private readonly accessTokens = new Map<string, StoredToken>(); // key: sha256(access_token)
  private readonly refreshTokens = new Map<string, StoredToken>(); // key: sha256(refresh_token)

  private readonly canonicalResource: string;
  private readonly accessTtlS: number;
  private readonly codeTtlS: number;
  private readonly scopes: readonly string[];
  private readonly persistPath: string | undefined;

  constructor(opts: RelayOAuthProviderOptions) {
    this.canonicalResource = opts.canonicalResource;
    this.accessTtlS = opts.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TTL_S;
    this.codeTtlS = opts.codeTtlSeconds ?? DEFAULT_CODE_TTL_S;
    this.scopes = opts.scopes ?? DEFAULT_SCOPES;
    this.persistPath = opts.persistPath;
    if (this.persistPath !== undefined) this.loadState(this.persistPath);
  }

  /**
   * clientsStore — getClient + registerClient. registerClient's PRESENCE is what
   * makes the SDK expose /register (DCR) and advertise registration_endpoint,
   * which is how ChatGPT's connector registers itself (we don't implement CIMD).
   */
  get clientsStore(): {
    getClient: (clientId: string) => StoredClient | undefined;
    registerClient: (
      client: Omit<StoredClient, 'client_id' | 'client_id_issued_at'>,
    ) => StoredClient;
  } {
    return {
      getClient: (clientId: string): StoredClient | undefined => this.clients.get(clientId),
      registerClient: (
        client: Omit<StoredClient, 'client_id' | 'client_id_issued_at'>,
      ): StoredClient => {
        // The SDK has already generated client_id (and client_secret unless the
        // client asked for token_endpoint_auth_method='none'); persist as-is.
        const full = client as StoredClient;
        this.clients.set(full.client_id, full);
        this.saveState();
        return full;
      },
    };
  }

  /**
   * Begin authorization. The owner-secret consent gate (if configured) has
   * already run as middleware ahead of the SDK handler, so reaching here means
   * "approved". We mint a PKCE-bound one-time code and redirect back to the
   * client's callback with ?code&state. The SDK pre-validated client_id,
   * redirect_uri (against the client's redirect_uris), response_type=code, and
   * code_challenge_method=S256 before calling us.
   */
  async authorize(
    client: StoredClient,
    params: {
      readonly state?: string;
      readonly scopes?: string[];
      readonly codeChallenge: string;
      readonly redirectUri: string;
      readonly resource?: URL;
    },
    res: {
      redirect: (status: number, url: string) => void;
    },
  ): Promise<void> {
    const code = `relay_ac_${randomBytes(32).toString('base64url')}`;
    this.codes.set(code, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      resource: params.resource?.href,
      scopes: params.scopes && params.scopes.length > 0 ? params.scopes : this.scopes,
      expiresAt: Date.now() + this.codeTtlS * 1000,
    });
    const target = new URL(params.redirectUri);
    target.searchParams.set('code', code);
    if (params.state !== undefined) target.searchParams.set('state', params.state);
    res.redirect(302, target.href);
  }

  /**
   * Return the S256 challenge stored for this code. The SDK's token handler
   * calls this, then verifies the client's code_verifier against it (pkce-
   * challenge verifyChallenge) BEFORE invoking exchangeAuthorizationCode — so a
   * wrong or missing code_verifier is rejected by the SDK using this value.
   */
  async challengeForAuthorizationCode(client: StoredClient, authorizationCode: string): Promise<string> {
    const entry = this.codes.get(authorizationCode);
    if (!entry || entry.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid authorization code');
    }
    if (entry.expiresAt < Date.now()) {
      this.codes.delete(authorizationCode);
      throw new InvalidGrantError('Authorization code has expired');
    }
    return entry.codeChallenge;
  }

  /**
   * Exchange a one-time code for tokens. PKCE has already been verified by the
   * SDK against challengeForAuthorizationCode. We enforce: code exists, not
   * expired, belongs to this client, redirect_uri matches the one bound at
   * authorize time, and the requested resource (if any) matches what was bound.
   * The code is deleted immediately (single use). Issues an access token bound
   * to the resource (audience) and a rotating refresh token.
   */
  async exchangeAuthorizationCode(
    client: StoredClient,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const entry = this.codes.get(authorizationCode);
    if (!entry || entry.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid authorization code');
    }
    // One-time: consume before any further check so a replay can't reuse it.
    this.codes.delete(authorizationCode);
    if (entry.expiresAt < Date.now()) {
      throw new InvalidGrantError('Authorization code has expired');
    }
    if (redirectUri !== undefined && redirectUri !== entry.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }
    // RFC 8707: if a resource was bound at authorize time, the token request's
    // resource must match it (audience consistency).
    if (entry.resource !== undefined && resource !== undefined && resource.href !== entry.resource) {
      throw new InvalidGrantError('resource does not match the authorization request');
    }
    const boundResource = entry.resource ?? resource?.href ?? this.canonicalResource;
    return this.issueTokens(client.client_id, entry.scopes, boundResource);
  }

  /**
   * Rotate a refresh token (OAuth 2.1 requires refresh-token rotation for public
   * clients). The presented refresh token is consumed and a fresh pair issued.
   */
  async exchangeRefreshToken(
    client: StoredClient,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const key = hashToken(refreshToken);
    const entry = this.refreshTokens.get(key);
    if (!entry || entry.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid refresh token');
    }
    this.refreshTokens.delete(key); // rotation: old refresh token is now dead
    if (entry.expiresAt < Date.now()) {
      throw new InvalidGrantError('Refresh token has expired');
    }
    // A narrowing scope request is honored; we never widen beyond the original.
    const grantedScopes =
      scopes && scopes.length > 0
        ? scopes.filter((s) => entry.scopes.includes(s))
        : entry.scopes;
    const boundResource = resource?.href ?? entry.resource ?? this.canonicalResource;
    return this.issueTokens(client.client_id, grantedScopes, boundResource);
  }

  /**
   * Verify a bearer token for the resource server. Rejects unknown or expired
   * tokens, and enforces audience binding: a token minted for a different
   * resource than this server is refused (RFC 8707). Returns AuthInfo with
   * expiresAt in SECONDS (requireBearerAuth rejects a missing/NaN expiresAt).
   */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const entry = this.accessTokens.get(hashToken(token));
    if (!entry) {
      throw new InvalidTokenError('Invalid access token');
    }
    if (entry.expiresAt < Date.now()) {
      this.accessTokens.delete(hashToken(token));
      throw new InvalidTokenError('Access token has expired');
    }
    if (entry.resource !== undefined && entry.resource !== this.canonicalResource) {
      // Token was issued for a different audience — must not be accepted here.
      throw new InvalidTokenError('Access token audience does not match this resource server');
    }
    return {
      token,
      clientId: entry.clientId,
      scopes: [...entry.scopes],
      expiresAt: Math.floor(entry.expiresAt / 1000),
      ...(entry.resource !== undefined ? { resource: new URL(entry.resource) } : {}),
    };
  }

  /**
   * Revoke an access or refresh token (RFC 7009). Presence of this method makes
   * the SDK expose /revoke. Invalid/already-revoked tokens are a no-op.
   */
  async revokeToken(client: StoredClient, request: OAuthTokenRevocationRequest): Promise<void> {
    const key = hashToken(request.token);
    let changed = false;
    const access = this.accessTokens.get(key);
    if (access && access.clientId === client.client_id) {
      this.accessTokens.delete(key);
      changed = true;
    }
    const refresh = this.refreshTokens.get(key);
    if (refresh && refresh.clientId === client.client_id) {
      this.refreshTokens.delete(key);
      changed = true;
    }
    if (changed) this.saveState();
  }

  /** Sweep expired codes and tokens. Called periodically by the server module. */
  cleanupExpired(now: number = Date.now()): void {
    for (const [code, entry] of this.codes) {
      if (entry.expiresAt < now) this.codes.delete(code);
    }
    let changed = false;
    for (const [key, entry] of this.accessTokens) {
      if (entry.expiresAt < now) {
        this.accessTokens.delete(key);
        changed = true;
      }
    }
    for (const [key, entry] of this.refreshTokens) {
      if (entry.expiresAt < now) {
        this.refreshTokens.delete(key);
        changed = true;
      }
    }
    if (changed) this.saveState();
  }

  /** Mint an access + rotating refresh token pair, storing only their hashes. */
  private issueTokens(
    clientId: string,
    scopes: readonly string[],
    resource: string | undefined,
  ): OAuthTokens {
    const accessToken = `relay_at_${randomBytes(32).toString('base64url')}`;
    const refreshToken = `relay_rt_${randomBytes(32).toString('base64url')}`;
    const now = Date.now();
    this.accessTokens.set(hashToken(accessToken), {
      clientId,
      scopes,
      resource,
      expiresAt: now + this.accessTtlS * 1000,
    });
    // Refresh tokens outlive access tokens (the client uses them to mint new
    // access tokens); a generous but bounded window keeps idle grants from
    // living forever.
    this.refreshTokens.set(hashToken(refreshToken), {
      clientId,
      scopes,
      resource,
      expiresAt: now + this.accessTtlS * 1000 * 24, // 24x the access TTL
    });
    this.saveState();
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.accessTtlS,
      scope: scopes.join(' '),
      refresh_token: refreshToken,
    };
  }

  /**
   * Load persisted clients/token-hashes. Expired tokens are dropped at load;
   * an unreadable or malformed file degrades to an empty store with a stderr
   * warning — a bad state file must never keep the server from starting.
   */
  private loadState(path: string): void {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as PersistedState;
      const now = Date.now();
      for (const [id, client] of parsed.clients) this.clients.set(id, client);
      for (const [key, token] of parsed.accessTokens) {
        if (token.expiresAt > now) this.accessTokens.set(key, token);
      }
      for (const [key, token] of parsed.refreshTokens) {
        if (token.expiresAt > now) this.refreshTokens.set(key, token);
      }
    } catch (err) {
      this.clients.clear();
      this.accessTokens.clear();
      this.refreshTokens.clear();
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        process.stderr.write(
          `relay mcp: ignoring unreadable OAuth state at ${path} — starting empty (${err instanceof Error ? err.message : String(err)})\n`,
        );
      }
    }
  }

  /**
   * Persist synchronously (writes are tiny and rare: client registration,
   * token issuance/revocation, expiry sweep) via tmp+rename so a crash
   * mid-write can't corrupt the file. A write failure warns instead of
   * throwing — an fs hiccup must not turn a token exchange into a 500 while
   * the in-memory state is still good.
   */
  private saveState(): void {
    if (this.persistPath === undefined) return;
    const state: PersistedState = {
      version: 1,
      clients: [...this.clients],
      accessTokens: [...this.accessTokens],
      refreshTokens: [...this.refreshTokens],
    };
    const tmp = `${this.persistPath}.tmp`;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      renameSync(tmp, this.persistPath);
    } catch (err) {
      process.stderr.write(
        `relay mcp: failed to persist OAuth state to ${this.persistPath} — ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

/** Re-export to keep callers from importing the SDK error class path directly. */
export { InvalidClientError };

/**
 * Generate a one-time DCR-style client id helper is NOT needed (the SDK's
 * register handler generates client_id/secret); this stays a marker that
 * client identity is SDK-owned. Exported only for test ergonomics.
 */
export function randomClientId(): string {
  return randomUUID();
}
