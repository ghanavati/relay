import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  extractLessonsViaLmStudio,
  stripJsonFences,
} from './auto-extract-runner.js';

interface FetchCall {
  url: string;
  init?: RequestInit;
}

interface ScriptedResponse {
  ok: boolean;
  status?: number;
  body: unknown;
  bodyIsText?: boolean;
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
        if (scripted.bodyIsText) {
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

describe('stripJsonFences', () => {
  test('removes ```json fenced blocks', () => {
    const input = '```json\n{"lessons":[]}\n```';
    assert.strictEqual(stripJsonFences(input), '{"lessons":[]}');
  });

  test('removes plain ``` fenced blocks', () => {
    const input = '```\n{"lessons":[]}\n```';
    assert.strictEqual(stripJsonFences(input), '{"lessons":[]}');
  });

  test('returns input unchanged when no fences present', () => {
    const input = '{"lessons":[]}';
    assert.strictEqual(stripJsonFences(input), '{"lessons":[]}');
  });

  test('trims surrounding whitespace', () => {
    const input = '   \n\n{"lessons":[]}\n  ';
    assert.strictEqual(stripJsonFences(input), '{"lessons":[]}');
  });

  test('handles fenced JSON with internal newlines', () => {
    const input = '```json\n{\n  "lessons": [\n    {"content": "x"}\n  ]\n}\n```';
    const expected = '{\n  "lessons": [\n    {"content": "x"}\n  ]\n}';
    assert.strictEqual(stripJsonFences(input), expected);
  });
});

describe('extractLessonsViaLmStudio — probe stage', () => {
  beforeEach(() => {
    savedFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  });

  afterEach(() => {
    if (savedFetch) (globalThis as { fetch?: typeof fetch }).fetch = savedFetch;
  });

  test('returns error:llm-down when /v1/models is unreachable', async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;

    const result = await extractLessonsViaLmStudio({
      transcript: 'hello',
      endpoint: 'http://localhost:1234',
      model: 'qwen/qwen3-coder-next',
      timeoutMs: 5000,
    });
    assert.strictEqual(result.status, 'error:llm-down');
    assert.ok(typeof result.durationMs === 'number');
    assert.ok(result.durationMs >= 0);
    assert.ok(result.note?.includes('unreachable'));
  });

  test('returns error:llm-down when /v1/models returns non-2xx', async () => {
    const calls: FetchCall[] = [];
    installFetch(() => ({ ok: false, status: 503, body: {} }), calls);

    const result = await extractLessonsViaLmStudio({
      transcript: 'hello',
      endpoint: 'http://localhost:1234',
      model: 'qwen/qwen3-coder-next',
      timeoutMs: 5000,
    });
    assert.strictEqual(result.status, 'error:llm-down');
    assert.ok(result.note?.includes('503'));
  });

  test('returns error:llm-down when requested model is not loaded', async () => {
    const calls: FetchCall[] = [];
    installFetch(
      () => ({
        ok: true,
        body: { data: [{ id: 'some-other-model' }] },
      }),
      calls
    );

    const result = await extractLessonsViaLmStudio({
      transcript: 'hello',
      endpoint: 'http://localhost:1234',
      model: 'qwen/qwen3-coder-next',
      timeoutMs: 5000,
    });
    assert.strictEqual(result.status, 'error:llm-down');
    assert.ok(result.note?.includes('not loaded'));
    // Should never have hit chat-completions
    assert.strictEqual(calls.length, 1);
  });

  test('strips trailing slashes from endpoint when probing', async () => {
    const calls: FetchCall[] = [];
    installFetch(
      () => ({
        ok: true,
        body: { data: [{ id: 'qwen/qwen3-coder-next' }] },
      }),
      calls
    );

    // Bad chat-completions response so we abort after probe — keeps test focused.
    let invocation = 0;
    installFetch((call) => {
      invocation++;
      if (invocation === 1) {
        return { ok: true, body: { data: [{ id: 'qwen/qwen3-coder-next' }] } };
      }
      return { ok: true, body: { choices: [{ message: { content: '{"lessons":[]}' } }] } };
    }, calls);

    await extractLessonsViaLmStudio({
      transcript: 'hello',
      endpoint: 'http://localhost:1234///',
      model: 'qwen/qwen3-coder-next',
      timeoutMs: 5000,
    });
    assert.strictEqual(calls[0]?.url, 'http://localhost:1234/v1/models');
  });
});

describe('extractLessonsViaLmStudio — chat-completions stage', () => {
  beforeEach(() => {
    savedFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  });

  afterEach(() => {
    if (savedFetch) (globalThis as { fetch?: typeof fetch }).fetch = savedFetch;
  });

  test('returns ok with stripped raw output on happy path', async () => {
    const calls: FetchCall[] = [];
    installFetch((call) => {
      if (call.url.endsWith('/v1/models')) {
        return { ok: true, body: { data: [{ id: 'qwen/qwen3-coder-next' }] } };
      }
      return {
        ok: true,
        body: {
          choices: [
            {
              message: {
                content:
                  '```json\n{"lessons":[{"content":"x","memory_type":"lesson","confidence":0.8}]}\n```',
              },
            },
          ],
        },
      };
    }, calls);

    const result = await extractLessonsViaLmStudio({
      transcript: 'transcript body here',
      endpoint: 'http://localhost:1234',
      model: 'qwen/qwen3-coder-next',
      timeoutMs: 5000,
    });
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(
      result.rawOutput,
      '{"lessons":[{"content":"x","memory_type":"lesson","confidence":0.8}]}'
    );
    assert.ok(result.durationMs >= 0);
  });

  test('payload uses correct sampling params and substitutes transcript', async () => {
    const calls: FetchCall[] = [];
    installFetch((call) => {
      if (call.url.endsWith('/v1/models')) {
        return { ok: true, body: { data: [{ id: 'qwen/qwen3-coder-next' }] } };
      }
      return {
        ok: true,
        body: { choices: [{ message: { content: '{"lessons":[]}' } }] },
      };
    }, calls);

    await extractLessonsViaLmStudio({
      transcript: 'TX_BODY',
      endpoint: 'http://localhost:1234',
      model: 'qwen/qwen3-coder-next',
      timeoutMs: 5000,
    });

    const chatCall = calls.find((c) => c.url.endsWith('/v1/chat/completions'));
    assert.ok(chatCall, 'expected POST to /v1/chat/completions');
    const body = JSON.parse(chatCall.init?.body as string) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      stream: boolean;
      temperature: number;
      top_p: number;
    };
    assert.strictEqual(body.model, 'qwen/qwen3-coder-next');
    assert.strictEqual(body.stream, false);
    assert.strictEqual(body.temperature, 1.0);
    assert.strictEqual(body.top_p, 0.95);
    assert.strictEqual(body.messages[0]?.role, 'user');
    assert.ok(body.messages[0]?.content.includes('TX_BODY'));
    assert.ok(body.messages[0]?.content.includes('extracting durable lessons'));
    assert.ok(!body.messages[0]?.content.includes('<<<TRANSCRIPT>>>'));
  });

  test('returns error:llm-down when chat-completions returns non-2xx', async () => {
    const calls: FetchCall[] = [];
    installFetch((call) => {
      if (call.url.endsWith('/v1/models')) {
        return { ok: true, body: { data: [{ id: 'qwen/qwen3-coder-next' }] } };
      }
      return { ok: false, status: 500, body: 'internal server error' };
    }, calls);

    const result = await extractLessonsViaLmStudio({
      transcript: 'hello',
      endpoint: 'http://localhost:1234',
      model: 'qwen/qwen3-coder-next',
      timeoutMs: 5000,
    });
    assert.strictEqual(result.status, 'error:llm-down');
    assert.ok(result.note?.includes('500'));
  });

  test('returns error:parse when response body is not JSON', async () => {
    const calls: FetchCall[] = [];
    installFetch((call) => {
      if (call.url.endsWith('/v1/models')) {
        return { ok: true, body: { data: [{ id: 'qwen/qwen3-coder-next' }] } };
      }
      return { ok: true, body: 'not json', bodyIsText: true };
    }, calls);

    const result = await extractLessonsViaLmStudio({
      transcript: 'hello',
      endpoint: 'http://localhost:1234',
      model: 'qwen/qwen3-coder-next',
      timeoutMs: 5000,
    });
    assert.strictEqual(result.status, 'error:parse');
  });

  test('returns error:parse when response is missing choices[0].message.content', async () => {
    const calls: FetchCall[] = [];
    installFetch((call) => {
      if (call.url.endsWith('/v1/models')) {
        return { ok: true, body: { data: [{ id: 'qwen/qwen3-coder-next' }] } };
      }
      return { ok: true, body: { choices: [] } };
    }, calls);

    const result = await extractLessonsViaLmStudio({
      transcript: 'hello',
      endpoint: 'http://localhost:1234',
      model: 'qwen/qwen3-coder-next',
      timeoutMs: 5000,
    });
    assert.strictEqual(result.status, 'error:parse');
  });

  test('returns error:empty when stripped content is empty', async () => {
    const calls: FetchCall[] = [];
    installFetch((call) => {
      if (call.url.endsWith('/v1/models')) {
        return { ok: true, body: { data: [{ id: 'qwen/qwen3-coder-next' }] } };
      }
      return { ok: true, body: { choices: [{ message: { content: '   \n\n  ' } }] } };
    }, calls);

    const result = await extractLessonsViaLmStudio({
      transcript: 'hello',
      endpoint: 'http://localhost:1234',
      model: 'qwen/qwen3-coder-next',
      timeoutMs: 5000,
    });
    assert.strictEqual(result.status, 'error:empty');
  });

  test('returns error:timeout when request exceeds timeoutMs', async () => {
    const calls: FetchCall[] = [];
    (globalThis as { fetch?: typeof fetch }).fetch = (async (
      input: unknown,
      init?: RequestInit
    ) => {
      const url = String(input);
      calls.push(init ? { url, init } : { url });
      // Probe responds immediately so we get past it
      if (url.endsWith('/v1/models')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: 'qwen/qwen3-coder-next' }] }),
          text: async () => '',
        } as unknown as Response;
      }
      // Chat completions hangs — abort fires from the AbortController
      const signal = init?.signal as AbortSignal | undefined;
      return await new Promise<Response>((_, reject) => {
        if (signal) {
          signal.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }
      });
    }) as typeof fetch;

    const result = await extractLessonsViaLmStudio({
      transcript: 'hello',
      endpoint: 'http://localhost:1234',
      model: 'qwen/qwen3-coder-next',
      timeoutMs: 60,
    });
    assert.strictEqual(result.status, 'error:timeout');
    assert.ok(result.durationMs >= 0);
  });
});
