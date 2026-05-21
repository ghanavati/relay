/**
 * Phase 7 / Task 2 — Figma REST client tests (RED phase).
 *
 * 10 cases per PLAN §Task 2:
 *   1) happy GET (header set, 1 call)
 *   2) happy POST (JSON body + content-type)
 *   3) 429 Retry-After:1 → sleeps, retries, succeeds on 2nd
 *   4) 429 twice → throws RateLimitError, NO 3rd attempt
 *   5) 403 body "Enterprise" → kind:PLAN_REQUIRED
 *   6) 403 body "expired" → kind:TOKEN_EXPIRED
 *   7) 404 → NotFoundError
 *   8) 500 → ServerError, NO retry
 *   9) error message containing PAT → thrown .message has "figd_***SCRUBBED***"
 *   10) fetch rejects → throws scrubbed
 *
 * Stub fetch via injected `fetchImpl` (matches LM Studio test pattern at
 * src/workers/lmstudio-agentic.test.ts — node:test uses dependency injection,
 * NOT vi.spyOn). Sleep via injected `sleepImpl` to bypass real timers.
 */

import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  figmaGet,
  figmaPost,
  FigmaBadRequestError,
  FigmaForbiddenError,
  FigmaNotFoundError,
  FigmaRateLimitError,
  FigmaServerError,
  FigmaBodyTooLargeError,
} from './rest-client.js';

type Recorded = { url: string; init: RequestInit | undefined };

interface ScriptStep {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** When set, fetch will throw this error instead of returning a Response. */
  rejectWith?: Error;
}

/** Build a scripted fetch + a sleep stub. Each script step is consumed in order. */
function makeScriptedFetch(steps: ScriptStep[]): {
  fetchImpl: typeof fetch;
  sleepImpl: (ms: number) => Promise<void>;
  requests: Recorded[];
  sleeps: number[];
} {
  const requests: Recorded[] = [];
  const sleeps: number[] = [];
  const queue = [...steps];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    requests.push({ url, init });
    const step = queue.shift();
    if (!step) throw new Error('scripted fetch exhausted');
    if (step.rejectWith) throw step.rejectWith;
    const body = typeof step.body === 'string' ? step.body : JSON.stringify(step.body ?? {});
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(step.headers ?? {}),
    };
    return new Response(body, { status: step.status, headers });
  };
  const sleepImpl = async (ms: number): Promise<void> => {
    sleeps.push(ms);
  };
  return { fetchImpl, sleepImpl, requests, sleeps };
}

const PAT = 'figd_testpat_AAAAAAA0123';

describe('figmaGet — happy path', () => {
  test('1) GET sets X-Figma-Token header and returns parsed JSON', async () => {
    const { fetchImpl, requests } = makeScriptedFetch([
      { status: 200, body: { document: { id: '0:1' } } },
    ]);
    const out = await figmaGet('/v1/files/abc', { pat: PAT, fetchImpl });
    assert.deepEqual(out, { document: { id: '0:1' } });
    assert.equal(requests.length, 1);
    assert.match(requests[0]?.url ?? '', /^https:\/\/api\.figma\.com\/v1\/files\/abc$/);
    const headers = (requests[0]?.init?.headers ?? {}) as Record<string, string>;
    assert.equal(headers['X-Figma-Token'], PAT, 'X-Figma-Token header must be set');
    // Must NOT use Authorization: Bearer ...
    assert.equal(headers['Authorization'], undefined);
    assert.equal((requests[0]?.init?.method ?? 'GET').toUpperCase(), 'GET');
  });
});

describe('figmaPost — happy path', () => {
  test('2) POST sets X-Figma-Token + Content-Type and sends JSON body', async () => {
    const { fetchImpl, requests } = makeScriptedFetch([
      { status: 200, body: { ok: true, meta: { tempIdToRealId: { tmp1: 'real1' } } } },
    ]);
    const out = await figmaPost('/v1/files/abc/variables', { variables: [{ a: 1 }] }, { pat: PAT, fetchImpl });
    assert.deepEqual(out, { ok: true, meta: { tempIdToRealId: { tmp1: 'real1' } } });
    assert.equal(requests.length, 1);
    const headers = (requests[0]?.init?.headers ?? {}) as Record<string, string>;
    assert.equal(headers['X-Figma-Token'], PAT);
    assert.equal(headers['Content-Type'], 'application/json');
    assert.equal((requests[0]?.init?.method ?? 'GET').toUpperCase(), 'POST');
    assert.equal(requests[0]?.init?.body, JSON.stringify({ variables: [{ a: 1 }] }));
  });
});

describe('figma rest-client — 429 Retry-After backoff', () => {
  test('3) 429 with Retry-After:2 → sleeps ~2000ms, retries once, succeeds', async () => {
    const { fetchImpl, sleepImpl, sleeps, requests } = makeScriptedFetch([
      { status: 429, headers: { 'Retry-After': '2' }, body: { reason: 'rate-limited' } },
      { status: 200, body: { ok: true } },
    ]);
    const out = await figmaGet('/v1/files/x', { pat: PAT, fetchImpl, sleepImpl });
    assert.deepEqual(out, { ok: true });
    assert.equal(requests.length, 2, 'should have retried exactly once');
    assert.equal(sleeps.length, 1);
    assert.equal(sleeps[0], 2000, 'must sleep 2 seconds per Retry-After header');
  });

  test('4) 429 TWICE → throws FigmaRateLimitError after one retry, NO 3rd attempt', async () => {
    const { fetchImpl, sleepImpl, requests, sleeps } = makeScriptedFetch([
      { status: 429, headers: { 'Retry-After': '1' }, body: { reason: 'rate-limited' } },
      { status: 429, headers: { 'Retry-After': '1' }, body: { reason: 'rate-limited' } },
    ]);
    await assert.rejects(
      figmaGet('/v1/x', { pat: PAT, fetchImpl, sleepImpl }),
      (err) => {
        assert.ok(err instanceof FigmaRateLimitError, 'must throw FigmaRateLimitError');
        assert.equal((err as FigmaRateLimitError).retryAfterSec, 1);
        return true;
      },
    );
    assert.equal(requests.length, 2, 'no 3rd attempt — single-retry policy');
    assert.equal(sleeps.length, 1, 'sleep once between attempts only');
  });
});

describe('figma rest-client — 403 kind disambiguation', () => {
  test('5) 403 body mentions "Enterprise" → kind = PLAN_REQUIRED', async () => {
    const { fetchImpl } = makeScriptedFetch([
      { status: 403, body: { reason: 'Variables write requires the Enterprise plan' } },
    ]);
    await assert.rejects(
      figmaPost('/v1/files/x/variables', {}, { pat: PAT, fetchImpl }),
      (err) => {
        assert.ok(err instanceof FigmaForbiddenError);
        assert.equal((err as FigmaForbiddenError).kind, 'PLAN_REQUIRED');
        return true;
      },
    );
  });

  test('6) 403 body mentions "expired" → kind = TOKEN_EXPIRED', async () => {
    const { fetchImpl } = makeScriptedFetch([
      { status: 403, body: { reason: 'token expired; re-issue your PAT' } },
    ]);
    await assert.rejects(
      figmaGet('/v1/files/x', { pat: PAT, fetchImpl }),
      (err) => {
        assert.ok(err instanceof FigmaForbiddenError);
        assert.equal((err as FigmaForbiddenError).kind, 'TOKEN_EXPIRED');
        return true;
      },
    );
  });

  test('6b) 403 body mentions "scope" → kind = SCOPE_MISSING', async () => {
    const { fetchImpl } = makeScriptedFetch([
      { status: 403, body: { reason: 'token lacks file_variables:write scope' } },
    ]);
    await assert.rejects(
      figmaPost('/v1/files/x/variables', {}, { pat: PAT, fetchImpl }),
      (err) => {
        assert.ok(err instanceof FigmaForbiddenError);
        assert.equal((err as FigmaForbiddenError).kind, 'SCOPE_MISSING');
        return true;
      },
    );
  });

  test('6c) 403 body unrecognized → kind = UNKNOWN (fail-loud, never silent)', async () => {
    const { fetchImpl } = makeScriptedFetch([
      { status: 403, body: { reason: 'something weird happened' } },
    ]);
    await assert.rejects(
      figmaGet('/v1/files/x', { pat: PAT, fetchImpl }),
      (err) => {
        assert.ok(err instanceof FigmaForbiddenError);
        assert.equal((err as FigmaForbiddenError).kind, 'UNKNOWN');
        return true;
      },
    );
  });
});

describe('figma rest-client — status code mapping', () => {
  test('7) 404 → FigmaNotFoundError, no retry', async () => {
    const { fetchImpl, requests } = makeScriptedFetch([
      { status: 404, body: { reason: 'file_key not found' } },
    ]);
    await assert.rejects(
      figmaGet('/v1/files/missing', { pat: PAT, fetchImpl }),
      (err) => err instanceof FigmaNotFoundError,
    );
    assert.equal(requests.length, 1, 'no retry on 404');
  });

  test('8) 500 → FigmaServerError, NO retry', async () => {
    const { fetchImpl, requests } = makeScriptedFetch([{ status: 500, body: { reason: 'oops' } }]);
    await assert.rejects(
      figmaGet('/v1/files/x', { pat: PAT, fetchImpl }),
      (err) => err instanceof FigmaServerError,
    );
    assert.equal(requests.length, 1, 'never retry on 500 (PLAN §Task 2 done criterion)');
  });

  test('8b) 400 → FigmaBadRequestError', async () => {
    const { fetchImpl } = makeScriptedFetch([{ status: 400, body: { reason: 'bad ids' } }]);
    await assert.rejects(
      figmaGet('/v1/files/x', { pat: PAT, fetchImpl }),
      (err) => err instanceof FigmaBadRequestError,
    );
  });

  test('8c) 413 → FigmaBodyTooLargeError', async () => {
    const { fetchImpl } = makeScriptedFetch([{ status: 413, body: { reason: 'body too large' } }]);
    await assert.rejects(
      figmaPost('/v1/files/x/variables', { huge: '...' }, { pat: PAT, fetchImpl }),
      (err) => err instanceof FigmaBodyTooLargeError,
    );
  });
});

describe('figma rest-client — PAT scrubbing on every error path', () => {
  test('9) Error message embedding a PAT comes out scrubbed', async () => {
    // Simulate a 400 whose body echoes the PAT (Figma sometimes echoes auth context).
    const leakedBody = { reason: `Invalid request with token ${PAT}` };
    const { fetchImpl } = makeScriptedFetch([{ status: 400, body: leakedBody }]);
    try {
      await figmaGet('/v1/files/x', { pat: PAT, fetchImpl });
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.doesNotMatch(err.message, /figd_testpat_AAAAAAA0123/, 'raw PAT must never appear in thrown error');
      assert.match(err.message, /figd_\*\*\*SCRUBBED\*\*\*/);
    }
  });

  test('10) fetch rejects (network error containing PAT) → throws scrubbed wrapper', async () => {
    const leak = new Error(`network down while sending X-Figma-Token: ${PAT}`);
    const { fetchImpl } = makeScriptedFetch([{ status: 0, rejectWith: leak }]);
    try {
      await figmaGet('/v1/files/x', { pat: PAT, fetchImpl });
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.doesNotMatch(err.message, /figd_testpat_AAAAAAA0123/, 'network error must scrub PAT');
      assert.match(err.message, /figd_\*\*\*SCRUBBED\*\*\*/);
    }
  });
});

describe('figma rest-client — Retry-After clamping', () => {
  test('Retry-After > 60s is clamped to 60s (cap on backoff)', async () => {
    const { fetchImpl, sleepImpl, sleeps } = makeScriptedFetch([
      { status: 429, headers: { 'Retry-After': '9999' }, body: {} },
      { status: 200, body: { ok: true } },
    ]);
    await figmaGet('/v1/x', { pat: PAT, fetchImpl, sleepImpl });
    assert.equal(sleeps[0], 60_000, 'must clamp to 60s upper bound');
  });

  test('Retry-After absent → defaults to 1s', async () => {
    const { fetchImpl, sleepImpl, sleeps } = makeScriptedFetch([
      { status: 429, body: {} },
      { status: 200, body: { ok: true } },
    ]);
    await figmaGet('/v1/x', { pat: PAT, fetchImpl, sleepImpl });
    assert.equal(sleeps[0], 1000, 'missing Retry-After → 1s default');
  });

  test('Retry-After in HTTP-date format → defaults to 1s (delta-seconds only for v0.2)', async () => {
    const { fetchImpl, sleepImpl, sleeps } = makeScriptedFetch([
      { status: 429, headers: { 'Retry-After': 'Wed, 21 Oct 2030 07:28:00 GMT' }, body: {} },
      { status: 200, body: { ok: true } },
    ]);
    await figmaGet('/v1/x', { pat: PAT, fetchImpl, sleepImpl });
    assert.equal(sleeps[0], 1000, 'HTTP-date intentionally unsupported in v0.2 → fallback 1s');
  });
});
