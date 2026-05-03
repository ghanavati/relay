import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { probeCodex, probeLmStudio, probeEnvKey } from './probes.js';

describe('probeEnvKey', () => {
  test('returns ok when env var is set', () => {
    const TEST_VAR = 'PROBE_TEST_VAR_SET_' + Date.now();
    process.env[TEST_VAR] = 'something';
    try {
      const result = probeEnvKey(TEST_VAR, 'foo');
      assert.deepStrictEqual(result, {
        name: 'foo',
        status: 'ok',
        detail: `${TEST_VAR} set`,
      });
    } finally {
      delete process.env[TEST_VAR];
    }
  });

  test('returns missing when env var is not set', () => {
    const TEST_VAR = 'PROBE_TEST_VAR_UNSET_' + Date.now();
    delete process.env[TEST_VAR];
    const result = probeEnvKey(TEST_VAR, 'foo');
    assert.deepStrictEqual(result, {
      name: 'foo',
      status: 'missing',
      detail: `${TEST_VAR} not set`,
    });
  });
});

describe('probeLmStudio', () => {
  let savedFetch: typeof fetch | undefined;
  let savedEndpoint: string | undefined;

  beforeEach(() => {
    savedFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    savedEndpoint = process.env['LMSTUDIO_ENDPOINT'];
  });

  afterEach(() => {
    if (savedFetch) (globalThis as { fetch?: typeof fetch }).fetch = savedFetch;
    if (savedEndpoint === undefined) delete process.env['LMSTUDIO_ENDPOINT'];
    else process.env['LMSTUDIO_ENDPOINT'] = savedEndpoint;
  });

  test('returns ok when fetch succeeds with model list', async () => {
    delete process.env['LMSTUDIO_ENDPOINT']; // use default
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'model-a' }, { id: 'model-b' }] }),
    } as unknown as Response)) as typeof fetch;

    const result = await probeLmStudio();
    assert.strictEqual(result.name, 'lmstudio');
    assert.strictEqual(result.status, 'ok');
    assert.match(result.detail, /http:\/\/localhost:1234/);
    assert.match(result.detail, /\(2 models\)/);
  });

  test('returns failed when fetch throws (network unreachable)', async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;

    const result = await probeLmStudio();
    assert.strictEqual(result.name, 'lmstudio');
    assert.strictEqual(result.status, 'failed');
    assert.ok(result.detail.length > 0);
  });

  test('returns failed when fetch returns non-2xx', async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as unknown as Response)) as typeof fetch;

    const result = await probeLmStudio();
    assert.strictEqual(result.name, 'lmstudio');
    assert.strictEqual(result.status, 'failed');
  });

  test('honors LMSTUDIO_ENDPOINT env var', async () => {
    process.env['LMSTUDIO_ENDPOINT'] = 'http://custom-host:9999';
    let observedUrl = '';
    (globalThis as { fetch?: typeof fetch }).fetch = (async (input: unknown) => {
      observedUrl = String(input);
      return {
        ok: true,
        json: async () => ({ data: [] }),
      } as unknown as Response;
    }) as typeof fetch;

    const result = await probeLmStudio();
    assert.strictEqual(result.status, 'ok');
    assert.match(observedUrl, /http:\/\/custom-host:9999\/v1\/models/);
    assert.match(result.detail, /http:\/\/custom-host:9999/);
  });
});

describe('probeCodex', () => {
  test('returns a probe with name=codex, valid status, and string detail', async () => {
    // Integration-flavored: we don't mock node:child_process here.
    // We just verify the contract: probe shape is correct regardless of host
    // codex availability. Status MUST be either 'ok' or 'failed' (never 'missing').
    const result = await probeCodex();
    assert.strictEqual(result.name, 'codex');
    assert.ok(result.status === 'ok' || result.status === 'failed',
      `expected status ok|failed, got ${result.status}`);
    assert.strictEqual(typeof result.detail, 'string');
    assert.ok(result.detail.length > 0, 'detail must be non-empty');
  });
});
