/**
 * PLAN-4 T2 — Embedding client unit tests.
 *
 * Mirrors `auto-extract-runner.test.ts` style: fetch-mocked, never touches the
 * network, asserts probe/timeout/never-throws contract. Embedding-specific
 * additions: 768-dim assertion, `search_document: ` vs `search_query: `
 * prefix discipline.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  probeEmbeddingsModel,
  embedDocument,
  embedQuery,
  EXPECTED_EMBEDDING_DIM,
} from './embedding-client.js';

interface FetchCall {
  url: string;
  init?: RequestInit;
}

interface ScriptedResponse {
  ok: boolean;
  status?: number;
  body: unknown;
  bodyIsText?: boolean;
  bodyIsInvalidJson?: boolean;
}

type FetchHandler = (call: FetchCall) => ScriptedResponse | Promise<ScriptedResponse>;

let savedFetch: typeof fetch | undefined;

function installFetch(handler: FetchHandler, calls: FetchCall[]): void {
  (globalThis as { fetch?: typeof fetch }).fetch = (async (
    input: unknown,
    init?: RequestInit
  ) => {
    const url = String(input);
    const call: FetchCall = init ? { url, init } : { url };
    calls.push(call);
    const scripted = await handler(call);
    return {
      ok: scripted.ok,
      status: scripted.status ?? (scripted.ok ? 200 : 500),
      json: async () => {
        if (scripted.bodyIsText || scripted.bodyIsInvalidJson) {
          throw new Error('not JSON');
        }
        return scripted.body;
      },
      text: async () =>
        typeof scripted.body === 'string'
          ? scripted.body
          : JSON.stringify(scripted.body),
    } as unknown as Response;
  }) as typeof fetch;
}

function makeNomicVector(dim = EXPECTED_EMBEDDING_DIM): number[] {
  const out: number[] = new Array(dim);
  for (let i = 0; i < dim; i++) out[i] = (i % 17) / 17 - 0.5;
  return out;
}

const NOMIC_MODEL = 'text-embedding-nomic-embed-text-v1.5';
const DEFAULT_ENDPOINT = 'http://localhost:1234';

describe('probeEmbeddingsModel', () => {
  beforeEach(() => {
    savedFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  });

  afterEach(() => {
    if (savedFetch) (globalThis as { fetch?: typeof fetch }).fetch = savedFetch;
  });

  test('returns ok=true when GET /v1/models lists the requested model', async () => {
    const calls: FetchCall[] = [];
    installFetch(
      () => ({
        ok: true,
        body: { data: [{ id: NOMIC_MODEL }, { id: 'qwen/qwen3-coder-next' }] },
      }),
      calls
    );

    const result = await probeEmbeddingsModel({
      endpoint: DEFAULT_ENDPOINT,
      model: NOMIC_MODEL,
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(calls[0]?.url, `${DEFAULT_ENDPOINT}/v1/models`);
  });

  test('returns ok=false reason=not-loaded when model id is absent from /v1/models', async () => {
    installFetch(
      () => ({ ok: true, body: { data: [{ id: 'some-other-model' }] } }),
      []
    );

    const result = await probeEmbeddingsModel({
      endpoint: DEFAULT_ENDPOINT,
      model: NOMIC_MODEL,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'not-loaded');
  });

  test('returns ok=false reason=unreachable on ECONNREFUSED', async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => {
      const err = new Error('ECONNREFUSED');
      throw err;
    }) as typeof fetch;

    const result = await probeEmbeddingsModel({
      endpoint: DEFAULT_ENDPOINT,
      model: NOMIC_MODEL,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'unreachable');
  });

  test('returns ok=false reason=http-500 on non-2xx response', async () => {
    installFetch(() => ({ ok: false, status: 500, body: 'oops' }), []);

    const result = await probeEmbeddingsModel({
      endpoint: DEFAULT_ENDPOINT,
      model: NOMIC_MODEL,
    });

    assert.strictEqual(result.ok, false);
    // probe maps any non-2xx to a reason; explicit 500 is fine, accept either
    assert.ok(
      result.reason === 'http-500' || result.reason === 'http-4xx',
      `expected http-* reason, got ${result.reason}`
    );
  });

  test('strips trailing slashes from endpoint', async () => {
    const calls: FetchCall[] = [];
    installFetch(
      () => ({ ok: true, body: { data: [{ id: NOMIC_MODEL }] } }),
      calls
    );

    await probeEmbeddingsModel({
      endpoint: `${DEFAULT_ENDPOINT}///`,
      model: NOMIC_MODEL,
    });

    assert.strictEqual(calls[0]?.url, `${DEFAULT_ENDPOINT}/v1/models`);
  });
});

describe('embedDocument', () => {
  beforeEach(() => {
    savedFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  });

  afterEach(() => {
    if (savedFetch) (globalThis as { fetch?: typeof fetch }).fetch = savedFetch;
  });

  test('POSTs to /v1/embeddings with the `search_document: ` prefix (trailing space)', async () => {
    const calls: FetchCall[] = [];
    installFetch(
      () => ({ ok: true, body: { data: [{ embedding: makeNomicVector() }] } }),
      calls
    );

    await embedDocument('hello world', {
      endpoint: DEFAULT_ENDPOINT,
      model: NOMIC_MODEL,
    });

    const call = calls.find((c) => c.url.endsWith('/v1/embeddings'));
    assert.ok(call, 'expected POST to /v1/embeddings');
    const body = JSON.parse(call.init?.body as string) as {
      model: string;
      input: string;
    };
    assert.strictEqual(body.model, NOMIC_MODEL);
    assert.strictEqual(body.input, 'search_document: hello world');
    // No sampling params on embeddings (NOMIC-EMBED-SPECS §3)
    assert.ok(!('temperature' in body));
    assert.ok(!('top_p' in body));
    assert.ok(!('stream' in body));
  });

  test('returns Float32Array(768) on a well-formed response', async () => {
    const vector = makeNomicVector();
    installFetch(
      () => ({ ok: true, body: { data: [{ embedding: vector }] } }),
      []
    );

    const result = await embedDocument('hello world', {
      endpoint: DEFAULT_ENDPOINT,
      model: NOMIC_MODEL,
    });

    assert.strictEqual(result.ok, true);
    assert.ok(result.vector instanceof Float32Array);
    assert.strictEqual(result.vector!.length, EXPECTED_EMBEDDING_DIM);
    assert.ok(Math.abs(result.vector![0]! - vector[0]!) < 1e-6);
    assert.ok(Math.abs(result.vector![100]! - vector[100]!) < 1e-6);
  });

  test('returns wrong-dim reason and NO vector when response.data[0].embedding.length !== 768', async () => {
    const wrongVec = makeNomicVector(512);
    installFetch(
      () => ({ ok: true, body: { data: [{ embedding: wrongVec }] } }),
      []
    );

    const result = await embedDocument('hello world', {
      endpoint: DEFAULT_ENDPOINT,
      model: NOMIC_MODEL,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'wrong-dim');
    assert.strictEqual(result.got, 512);
    assert.strictEqual(result.vector, undefined);
  });

  test('returns timeout reason on AbortController fire — never throws', async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async (
      _input: unknown,
      init?: RequestInit
    ) => {
      const signal = init?.signal as AbortSignal | undefined;
      return await new Promise<Response>((_, reject) => {
        if (signal) {
          signal.addEventListener('abort', () =>
            reject(new Error('aborted'))
          );
        }
      });
    }) as typeof fetch;

    const result = await embedDocument('hello world', {
      endpoint: DEFAULT_ENDPOINT,
      model: NOMIC_MODEL,
      timeoutMs: 30,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'timeout');
  });

  test('returns parse-error when response body is not JSON — never throws', async () => {
    installFetch(
      () => ({ ok: true, body: 'not json', bodyIsInvalidJson: true }),
      []
    );

    const result = await embedDocument('hello world', {
      endpoint: DEFAULT_ENDPOINT,
      model: NOMIC_MODEL,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'parse-error');
  });

  test('returns http-500 on HTTP 500 — never throws', async () => {
    installFetch(() => ({ ok: false, status: 500, body: 'server error' }), []);

    const result = await embedDocument('hello world', {
      endpoint: DEFAULT_ENDPOINT,
      model: NOMIC_MODEL,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'http-500');
  });

  test('returns empty-input reason without HTTP call when input is empty/whitespace', async () => {
    const calls: FetchCall[] = [];
    installFetch(() => {
      throw new Error('should not be called');
    }, calls);

    const r1 = await embedDocument('', {
      endpoint: DEFAULT_ENDPOINT,
      model: NOMIC_MODEL,
    });
    assert.strictEqual(r1.ok, false);
    assert.strictEqual(r1.reason, 'empty-input');

    const r2 = await embedDocument('   \n  ', {
      endpoint: DEFAULT_ENDPOINT,
      model: NOMIC_MODEL,
    });
    assert.strictEqual(r2.ok, false);
    assert.strictEqual(r2.reason, 'empty-input');

    assert.strictEqual(calls.length, 0, 'no HTTP call should have been made');
  });

  test('returns no-data when /v1/embeddings returns an empty data array — never throws', async () => {
    installFetch(() => ({ ok: true, body: { data: [] } }), []);

    const result = await embedDocument('hello world', {
      endpoint: DEFAULT_ENDPOINT,
      model: NOMIC_MODEL,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'no-data');
  });

  test('ignores usage.prompt_tokens field (LM Studio bug #1546 — always 0)', async () => {
    // We just confirm the embedding still parses fine when usage is the typical bogus 0.
    installFetch(
      () => ({
        ok: true,
        body: {
          data: [{ embedding: makeNomicVector() }],
          usage: { prompt_tokens: 0, total_tokens: 0 },
        },
      }),
      []
    );

    const result = await embedDocument('hello world', {
      endpoint: DEFAULT_ENDPOINT,
      model: NOMIC_MODEL,
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.vector?.length, EXPECTED_EMBEDDING_DIM);
  });
});

describe('embedQuery', () => {
  beforeEach(() => {
    savedFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  });

  afterEach(() => {
    if (savedFetch) (globalThis as { fetch?: typeof fetch }).fetch = savedFetch;
  });

  test('uses the `search_query: ` prefix (trailing space)', async () => {
    const calls: FetchCall[] = [];
    installFetch(
      () => ({ ok: true, body: { data: [{ embedding: makeNomicVector() }] } }),
      calls
    );

    await embedQuery('naming conventions for stylesheets', {
      endpoint: DEFAULT_ENDPOINT,
      model: NOMIC_MODEL,
    });

    const call = calls.find((c) => c.url.endsWith('/v1/embeddings'));
    assert.ok(call, 'expected POST to /v1/embeddings');
    const body = JSON.parse(call.init?.body as string) as {
      input: string;
    };
    assert.strictEqual(body.input, 'search_query: naming conventions for stylesheets');
  });

  test('returns Float32Array(768) on a well-formed response (mirrors embedDocument shape)', async () => {
    installFetch(
      () => ({ ok: true, body: { data: [{ embedding: makeNomicVector() }] } }),
      []
    );

    const result = await embedQuery('something', {
      endpoint: DEFAULT_ENDPOINT,
      model: NOMIC_MODEL,
    });

    assert.strictEqual(result.ok, true);
    assert.ok(result.vector instanceof Float32Array);
    assert.strictEqual(result.vector!.length, EXPECTED_EMBEDDING_DIM);
  });

  test('returns timeout on AbortController fire — never throws', async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async (
      _input: unknown,
      init?: RequestInit
    ) => {
      const signal = init?.signal as AbortSignal | undefined;
      return await new Promise<Response>((_, reject) => {
        if (signal) {
          signal.addEventListener('abort', () =>
            reject(new Error('aborted'))
          );
        }
      });
    }) as typeof fetch;

    const result = await embedQuery('q', {
      endpoint: DEFAULT_ENDPOINT,
      model: NOMIC_MODEL,
      timeoutMs: 30,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'timeout');
  });

  test('short-circuits empty input — no HTTP call', async () => {
    const calls: FetchCall[] = [];
    installFetch(() => {
      throw new Error('should not be called');
    }, calls);

    const result = await embedQuery('', {
      endpoint: DEFAULT_ENDPOINT,
      model: NOMIC_MODEL,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'empty-input');
    assert.strictEqual(calls.length, 0);
  });
});
