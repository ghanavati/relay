import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { isTruthy } from './utils.js';

describe('isTruthy', () => {
  test('undefined returns false', async () => {
    assert.strictEqual(isTruthy(undefined), false);
  });

  test('empty string returns false', async () => {
    assert.strictEqual(isTruthy(''), false);
  });

  test("'0', 'false', 'no', 'nope' return false", async () => {
    assert.strictEqual(isTruthy('0'), false);
    assert.strictEqual(isTruthy('false'), false);
    assert.strictEqual(isTruthy('no'), false);
    assert.strictEqual(isTruthy('nope'), false);
  });

  test("'1', 'true', 'yes' return true", async () => {
    assert.strictEqual(isTruthy('1'), true);
    assert.strictEqual(isTruthy('true'), true);
    assert.strictEqual(isTruthy('yes'), true);
  });

  test("'TRUE', 'YES', '  1  ' return true (case/trim)", async () => {
    assert.strictEqual(isTruthy('TRUE'), true);
    assert.strictEqual(isTruthy('YES'), true);
    assert.strictEqual(isTruthy('  1  '), true);
  });

  test("'maybe', 'ok', '2' return false", async () => {
    assert.strictEqual(isTruthy('maybe'), false);
    assert.strictEqual(isTruthy('ok'), false);
    assert.strictEqual(isTruthy('2'), false);
  });
});
