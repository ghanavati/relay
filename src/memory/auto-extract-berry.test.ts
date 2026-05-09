import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { checkLessonViaBerry } from './auto-extract-berry.js';

describe('checkLessonViaBerry', () => {
  let savedFetch: typeof fetch | undefined;

  beforeEach(() => {
    savedFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  });

  afterEach(() => {
    if (savedFetch) (globalThis as { fetch?: typeof fetch }).fetch = savedFetch;
  });

  test('returns "pass" when Berry verifies the lesson is grounded', async () => {
    let received: { url: string; body: unknown } | undefined;
    (globalThis as { fetch?: typeof fetch }).fetch = (async (url: string, init?: RequestInit) => {
      received = { url, body: JSON.parse(init?.body as string) as unknown };
      return {
        ok: true,
        json: async () => ({ hallucinated: false, score: 0.92 }),
      } as unknown as Response;
    }) as typeof fetch;

    const result = await checkLessonViaBerry({
      lessonContent: 'Always run npm test before commit',
      transcriptSpans: [
        { source: 'tool:bash', text: 'I ran npm test and it passed before committing' },
      ],
      endpoint: 'http://test/check',
    });

    assert.strictEqual(result.ok, 'pass');
    assert.ok(received, 'fetch must have been called');
    assert.strictEqual(received!.url, 'http://test/check');
    const body = received!.body as { answer: string; spans: Array<{ source: string; text: string }> };
    assert.strictEqual(body.answer, 'Always run npm test before commit');
    assert.strictEqual(body.spans.length, 1);
    assert.strictEqual(body.spans[0]?.source, 'tool:bash');
  });

  test('returns "flagged" when Berry reports the lesson is hallucinated', async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => ({
      ok: true,
      json: async () => ({ hallucinated: true, reason: 'no supporting evidence' }),
    } as unknown as Response)) as typeof fetch;

    const result = await checkLessonViaBerry({
      lessonContent: 'The build always succeeds in 30 seconds',
      transcriptSpans: [{ source: 'tool:bash', text: 'unrelated chatter' }],
      endpoint: 'http://test/check',
    });

    assert.strictEqual(result.ok, 'flagged');
  });

  test('accepts the newer normalized envelope { ok: "pass" }', async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => ({
      ok: true,
      json: async () => ({ ok: 'pass' }),
    } as unknown as Response)) as typeof fetch;

    const result = await checkLessonViaBerry({
      lessonContent: 'foo',
      transcriptSpans: [{ source: 's', text: 't' }],
      endpoint: 'http://test/check',
    });
    assert.strictEqual(result.ok, 'pass');
  });

  test('returns "unavailable" when fetch throws (Berry down / network error)', async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:8765');
    }) as typeof fetch;

    const result = await checkLessonViaBerry({
      lessonContent: 'lesson content',
      transcriptSpans: [{ source: 's', text: 't' }],
      endpoint: 'http://localhost:8765/check',
    });

    assert.strictEqual(result.ok, 'unavailable');
    const details = result.details as { error: string };
    assert.match(details.error, /ECONNREFUSED/);
  });

  test('returns "unavailable" when Berry returns non-2xx HTTP status', async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    } as unknown as Response)) as typeof fetch;

    const result = await checkLessonViaBerry({
      lessonContent: 'foo',
      transcriptSpans: [{ source: 's', text: 't' }],
      endpoint: 'http://test/check',
    });
    assert.strictEqual(result.ok, 'unavailable');
    const details = result.details as { status: number };
    assert.strictEqual(details.status, 503);
  });

  test('returns "unavailable" when Berry returns an unparseable verdict', async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => ({
      ok: true,
      json: async () => ({ unrelated_field: true }),
    } as unknown as Response)) as typeof fetch;

    const result = await checkLessonViaBerry({
      lessonContent: 'foo',
      transcriptSpans: [{ source: 's', text: 't' }],
      endpoint: 'http://test/check',
    });
    assert.strictEqual(result.ok, 'unavailable');
  });

  test('returns "unavailable" for empty lesson content (no point checking)', async () => {
    let called = false;
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => {
      called = true;
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }) as typeof fetch;

    const result = await checkLessonViaBerry({
      lessonContent: '   ',
      transcriptSpans: [{ source: 's', text: 't' }],
      endpoint: 'http://test/check',
    });
    assert.strictEqual(result.ok, 'unavailable');
    assert.strictEqual(called, false, 'should short-circuit before fetch');
  });

  test('respects custom timeoutMs and aborts on slow Berry', async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = ((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
        // Never resolve naturally — only the abort path completes the promise.
      });
    }) as typeof fetch;

    const result = await checkLessonViaBerry({
      lessonContent: 'foo',
      transcriptSpans: [{ source: 's', text: 't' }],
      endpoint: 'http://test/check',
      timeoutMs: 50,
    });
    assert.strictEqual(result.ok, 'unavailable');
  });
});
