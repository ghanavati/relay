/**
 * Phase 7 / Task 2 — Figma REST client.
 *
 * Native fetch wrapper (NO axios/undici/node-fetch — SUMMARY §1 stack discipline).
 * All routes through here so 429 backoff, typed errors, and PAT scrubbing are
 * baked into a single boundary (FIGMA-04, R-07-01, R-07-02).
 *
 * Retry policy (single-attempt; PITFALLS 5.4):
 *   - 429 → read Retry-After (delta-seconds), clamp 1-60s, sleep, retry ONCE.
 *   - Second 429 → throw FigmaRateLimitError. NEVER infinite-loop.
 *   - Any other non-2xx → typed error, NO retry.
 *
 * Auth:
 *   - X-Figma-Token header (NOT Authorization: Bearer — Figma spec)
 *   - PAT is passed in per-call via opts (loaded by registerFigmaTools at boot)
 *
 * Scrubbing (layered defense per VERIFICATION §PAT-Leak Defense):
 *   - Every typed error message is routed through scrubPat before throw.
 *   - The redaction.ts always-on layer is the catch-all; this is the precise gate.
 *
 * Test seam: `fetchImpl` and `sleepImpl` injectable via opts — see tests.
 */

import { scrubPat, scrubError } from './scrub.js';

const FIGMA_BASE_URL = 'https://api.figma.com';
const MIN_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 60_000;
const DEFAULT_RETRY_AFTER_MS = 1_000;

// ─── Error class hierarchy ────────────────────────────────────────────────

/** Base for all Figma REST errors — superclass for handlers to catch broadly when needed. */
export class FigmaApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(scrubPat(message));
    this.name = 'FigmaApiError';
    this.status = status;
  }
}

export class FigmaBadRequestError extends FigmaApiError {
  constructor(message: string) {
    super(400, message);
    this.name = 'FigmaBadRequestError';
  }
}

/**
 * 403 kinds — disambiguated by parsing response body. Per PITFALLS 5.2:
 * Enterprise-only writes are the dominant 403 case; surfacing this distinctly
 * lets `figma_update_token` return a structured `plan_required` result rather
 * than throwing, while keeping TOKEN_EXPIRED / SCOPE_MISSING as throws.
 */
export type ForbiddenKind =
  | 'PLAN_REQUIRED'
  | 'TOKEN_EXPIRED'
  | 'SCOPE_MISSING'
  | 'FILE_NO_EDIT_ACCESS'
  | 'UNKNOWN';

export class FigmaForbiddenError extends FigmaApiError {
  readonly kind: ForbiddenKind;
  constructor(kind: ForbiddenKind, message: string) {
    super(403, message);
    this.name = 'FigmaForbiddenError';
    this.kind = kind;
  }
}

export class FigmaNotFoundError extends FigmaApiError {
  constructor(message: string) {
    super(404, message);
    this.name = 'FigmaNotFoundError';
  }
}

export class FigmaBodyTooLargeError extends FigmaApiError {
  constructor(message: string) {
    super(413, message);
    this.name = 'FigmaBodyTooLargeError';
  }
}

export class FigmaRateLimitError extends FigmaApiError {
  readonly retryAfterSec: number;
  constructor(retryAfterSec: number, message: string) {
    super(429, message);
    this.name = 'FigmaRateLimitError';
    this.retryAfterSec = retryAfterSec;
  }
}

export class FigmaServerError extends FigmaApiError {
  constructor(status: number, message: string) {
    super(status, message);
    this.name = 'FigmaServerError';
  }
}

// ─── Public types ────────────────────────────────────────────────────────

export type FetchFn = typeof fetch;
export type SleepFn = (ms: number) => Promise<void>;

export interface FigmaRequestOpts {
  /** Personal access token. Set as `X-Figma-Token` header. */
  pat: string;
  /** Test seam — defaults to global fetch. */
  fetchImpl?: FetchFn;
  /** Test seam — defaults to real setTimeout. */
  sleepImpl?: SleepFn;
  /** Optional query string params for GET. */
  query?: Record<string, string | number | undefined>;
}

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── 403 disambiguation ──────────────────────────────────────────────────

/**
 * Parse a 403 response body to a ForbiddenKind. Body shape varies — Figma may
 * return `{ reason: "..." }`, `{ status: 403, err: "..." }`, or a bare string.
 * Keyword match is intentionally loose; ordering puts more-specific kinds
 * (PLAN_REQUIRED) before SCOPE_MISSING because Enterprise messaging often
 * mentions both ("Enterprise plan with file_variables:write scope").
 */
export function parseForbidden(body: unknown): ForbiddenKind {
  const text = typeof body === 'string'
    ? body
    : JSON.stringify(body ?? '');
  const lower = text.toLowerCase();
  if (lower.includes('enterprise') || lower.includes('plan required')) return 'PLAN_REQUIRED';
  if (lower.includes('expired') || lower.includes('invalid token')) return 'TOKEN_EXPIRED';
  if (lower.includes('scope')) return 'SCOPE_MISSING';
  if (lower.includes('edit access') || lower.includes('no access')) return 'FILE_NO_EDIT_ACCESS';
  return 'UNKNOWN';
}

// ─── Retry-After parsing ────────────────────────────────────────────────

/**
 * Parse Retry-After header to milliseconds, clamped 1000-60000.
 *
 * v0.2 supports DELTA-SECONDS only (RFC 7231 §7.1.3 first form). HTTP-date
 * format is intentionally deferred — falls back to DEFAULT_RETRY_AFTER_MS
 * (1s) so the retry still happens, just not at the server's preferred time.
 * Reason: live testing across Node 20/22 showed Date.parse drift on some
 * locales — R-07-07 (Risk Register).
 */
export function parseRetryAfter(header: string | null | undefined): number {
  if (!header) return DEFAULT_RETRY_AFTER_MS;
  const trimmed = header.trim();
  // Pure integer (delta-seconds) — accept and clamp.
  if (/^\d+$/.test(trimmed)) {
    const sec = parseInt(trimmed, 10);
    const ms = sec * 1000;
    if (ms < MIN_RETRY_AFTER_MS) return MIN_RETRY_AFTER_MS;
    if (ms > MAX_RETRY_AFTER_MS) return MAX_RETRY_AFTER_MS;
    return ms;
  }
  // Non-integer (e.g. HTTP-date) — fall back to 1s.
  return DEFAULT_RETRY_AFTER_MS;
}

// ─── Status → typed error mapping ───────────────────────────────────────

/** Build the typed error class for a non-2xx response. Body text already scrubbed by caller. */
function mapStatusToError(status: number, bodyText: string, retryAfterMs?: number): Error {
  const scrubbedBody = scrubPat(bodyText);
  if (status === 400) return new FigmaBadRequestError(`Figma 400 Bad Request: ${scrubbedBody}`);
  if (status === 403) {
    const kind = parseForbidden(bodyText);
    return new FigmaForbiddenError(kind, `Figma 403 Forbidden (${kind}): ${scrubbedBody}`);
  }
  if (status === 404) return new FigmaNotFoundError(`Figma 404 Not Found: ${scrubbedBody}`);
  if (status === 413) return new FigmaBodyTooLargeError(`Figma 413 Body Too Large: ${scrubbedBody}`);
  if (status === 429) {
    const sec = Math.round((retryAfterMs ?? DEFAULT_RETRY_AFTER_MS) / 1000);
    return new FigmaRateLimitError(sec, `Figma 429 Rate Limited (Retry-After ${sec}s): ${scrubbedBody}`);
  }
  // 500, 502, 503, 504 — server-side
  return new FigmaServerError(status, `Figma ${status} Server Error: ${scrubbedBody}`);
}

// ─── Core request loop ──────────────────────────────────────────────────

interface DoRequestOpts {
  method: 'GET' | 'POST';
  path: string;
  pat: string;
  body?: unknown;
  fetchImpl: FetchFn;
  sleepImpl: SleepFn;
  query?: Record<string, string | number | undefined>;
}

function buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
  const base = FIGMA_BASE_URL + path;
  if (!query) return base;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    params.append(k, String(v));
  }
  const qs = params.toString();
  return qs.length > 0 ? `${base}?${qs}` : base;
}

async function doRequest(opts: DoRequestOpts): Promise<unknown> {
  const url = buildUrl(opts.path, opts.query);
  const headers: Record<string, string> = {
    'X-Figma-Token': opts.pat,
  };
  const init: RequestInit = { method: opts.method, headers };
  if (opts.method === 'POST' && opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await opts.fetchImpl(url, init);
  } catch (err) {
    // Network-layer failure — scrub PAT from any leaked message, then re-throw.
    throw scrubError(err);
  }

  if (res.ok) {
    try {
      return await res.json();
    } catch (err) {
      throw scrubError(new Error(`Figma response not valid JSON: ${(err as Error).message}`));
    }
  }

  // Non-OK: read body once (for scrubbing + error mapping).
  const bodyText = await res.text().catch(() => '');
  const retryAfterMs = parseRetryAfter(res.headers.get('Retry-After'));
  throw mapStatusToError(res.status, bodyText, retryAfterMs);
}

/**
 * Single-retry wrapper. Retries ONCE on FigmaRateLimitError; never on others.
 * Sleep duration comes from the first attempt's Retry-After header.
 */
async function doRequestWithRetry(opts: DoRequestOpts): Promise<unknown> {
  try {
    return await doRequest(opts);
  } catch (err) {
    if (err instanceof FigmaRateLimitError) {
      const sleepMs = Math.max(MIN_RETRY_AFTER_MS, Math.min(MAX_RETRY_AFTER_MS, err.retryAfterSec * 1000));
      await opts.sleepImpl(sleepMs);
      // Second attempt: any failure (including another 429) propagates unchanged.
      return await doRequest(opts);
    }
    throw err;
  }
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * GET https://api.figma.com{path}?{query}
 * - Sets X-Figma-Token header.
 * - Single retry on 429 with Retry-After backoff.
 * - All errors come out PAT-scrubbed and typed.
 */
export async function figmaGet(path: string, opts: FigmaRequestOpts): Promise<unknown> {
  return doRequestWithRetry({
    method: 'GET',
    path,
    pat: opts.pat,
    fetchImpl: opts.fetchImpl ?? fetch,
    sleepImpl: opts.sleepImpl ?? defaultSleep,
    query: opts.query,
  });
}

/**
 * POST https://api.figma.com{path}  body=<JSON-stringified>
 * - Sets X-Figma-Token + Content-Type: application/json.
 * - Same retry + scrub semantics as figmaGet.
 */
export async function figmaPost(
  path: string,
  body: unknown,
  opts: FigmaRequestOpts,
): Promise<unknown> {
  return doRequestWithRetry({
    method: 'POST',
    path,
    pat: opts.pat,
    body,
    fetchImpl: opts.fetchImpl ?? fetch,
    sleepImpl: opts.sleepImpl ?? defaultSleep,
    query: opts.query,
  });
}
