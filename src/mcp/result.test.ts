import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { toMcpResult, relayErrorToMcpResult, withMcpResult } from './result.js';
import { makeError, toRelayException } from '../errors.js';

// Secret-shaped fixtures are built at runtime from string parts so no literal
// credential-looking value sits in source (secret scanners stay quiet, and the
// parts are individually inert).
const figmaSecret = (): string => ['figd', 'AAAA1111BBBB2222cccc'].join('_');
const openaiSecret = (): string => ['sk', 'abcdefghij0123456789xyz'].join('-');

describe('toMcpResult', () => {
  test('wraps a value in the MCP text-content envelope (Test 1)', () => {
    assert.deepStrictEqual(toMcpResult({ a: 1 }), {
      content: [{ type: 'text', text: '{"a":1}' }],
    });
  });

  test('redacts a secret nested in the serialized value (Test 2)', () => {
    const secret = figmaSecret();
    const result = toMcpResult({ memo: { note: `token is ${secret}` } });
    const text = result.content[0].text;
    assert.ok(!text.includes(secret), 'raw secret must not cross the MCP boundary');
    assert.ok(text.includes('[REDACTED:FIGMA_PAT]'), `expected placeholder in: ${text}`);
  });

  test('does not mutate the input value', () => {
    const input = { note: figmaSecret() };
    const before = JSON.stringify(input) === JSON.stringify({ note: figmaSecret() });
    toMcpResult(input);
    assert.ok(before);
    assert.strictEqual(input.note, figmaSecret(), 'input must be untouched');
  });
});

describe('relayErrorToMcpResult', () => {
  test('maps a coded RelayException to an isError result carrying the code (Test 3)', () => {
    const err = toRelayException(makeError('MEMORY_WORKDIR_FORBIDDEN', 'workdir not allowed', false));
    const result = relayErrorToMcpResult(err);
    assert.strictEqual(result.isError, true);
    const parsed = JSON.parse(result.content[0].text) as {
      ok: boolean;
      code: string;
      message: string;
    };
    assert.deepStrictEqual(parsed, {
      ok: false,
      code: 'MEMORY_WORKDIR_FORBIDDEN',
      message: 'workdir not allowed',
    });
  });

  test('redacts a secret embedded in the error message (Test 4)', () => {
    const secret = openaiSecret();
    const err = toRelayException(makeError('PROVIDER_ERROR', `upstream rejected key ${secret}`, true));
    const result = relayErrorToMcpResult(err);
    assert.strictEqual(result.isError, true);
    const text = result.content[0].text;
    assert.ok(!text.includes(secret), 'raw secret must not cross the MCP boundary');
    assert.ok(text.includes('[REDACTED:OPENAI_KEY]'), `expected placeholder in: ${text}`);
  });

  test('never throws, even on a null/non-Error input', () => {
    const result = relayErrorToMcpResult(null);
    assert.strictEqual(result.isError, true);
    const parsed = JSON.parse(result.content[0].text) as { code: string };
    assert.strictEqual(parsed.code, 'UNKNOWN');
  });
});

describe('withMcpResult', () => {
  test('maps an unknown throw to a generic UNKNOWN isError result (Test 5)', async () => {
    const result = await withMcpResult(async () => {
      throw new Error('boom');
    });
    assert.strictEqual(result.isError, true);
    const parsed = JSON.parse(result.content[0].text) as {
      ok: boolean;
      code: string;
      message: string;
    };
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.code, 'UNKNOWN');
    assert.strictEqual(parsed.message, 'boom');
    assert.ok(
      !result.content[0].text.includes('    at '),
      'raw stack frames must not cross the MCP boundary'
    );
  });

  test('wraps a successful return in the toMcpResult envelope (Test 6)', async () => {
    const result = await withMcpResult(async () => ({ ok: true }));
    assert.deepStrictEqual(result, {
      content: [{ type: 'text', text: '{"ok":true}' }],
    });
  });

  test('routes a RelayException through the code-bearing error mapping', async () => {
    const result = await withMcpResult(() => {
      throw toRelayException(makeError('INVALID_ARGS', 'bad input', false));
    });
    assert.strictEqual(result.isError, true);
    const parsed = JSON.parse(result.content[0].text) as { code: string; message: string };
    assert.strictEqual(parsed.code, 'INVALID_ARGS');
    assert.strictEqual(parsed.message, 'bad input');
  });

  test('redacts secrets on the success path end to end', async () => {
    const secret = figmaSecret();
    const result = await withMcpResult(() => ({ token: secret }));
    assert.ok(!result.content[0].text.includes(secret));
    assert.ok(result.content[0].text.includes('[REDACTED:FIGMA_PAT]'));
  });
});
