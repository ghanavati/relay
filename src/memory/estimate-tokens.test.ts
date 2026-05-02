import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { estimateTokens } from './memory-engine.js';

describe('estimateTokens', () => {
  test('empty string returns 0', () => {
    assert.strictEqual(estimateTokens(''), 0);
  });

  test('4 chars (abcd) returns 1', () => {
    assert.strictEqual(estimateTokens('abcd'), 1);
  });

  test('3 chars (abc) returns 1 (ceil rounds up)', () => {
    assert.strictEqual(estimateTokens('abc'), 1);
  });

  test('8 chars returns 2', () => {
    assert.strictEqual(estimateTokens('abcdefgh'), 2);
  });

  test('100 chars returns 25', () => {
    assert.strictEqual(estimateTokens('a'.repeat(100)), 25);
  });

  test('1000 chars returns 250', () => {
    assert.strictEqual(estimateTokens('a'.repeat(1000)), 250);
  });
});
