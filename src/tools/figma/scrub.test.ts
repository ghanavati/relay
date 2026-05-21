/**
 * Phase 7 / Task 1 — PAT scrubbing utility tests (RED phase).
 *
 * scrub.ts must mask Figma PATs (`figd_*`) in every string that could become
 * a log line, error message, or stderr emission. Layered defense (FIGMA-04 + R-07-01).
 *
 * Six cases per PLAN §Task 1:
 *   1) single PAT replacement
 *   2) multi-occurrence in one string
 *   3) header object — X-Figma-Token masked, NEW object returned (immutability)
 *   4) nested object — deep walk of values
 *   5) multi-line stack trace
 *   6) no-PAT input — pass-through unchanged
 */

import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { scrubPat, scrubHeaders, scrubError } from './scrub.js';

describe('scrubPat — single-string masking', () => {
  test('1) single PAT occurrence is replaced with sentinel', () => {
    const input = 'token: figd_abcdef0123456789_-ghijkl';
    const out = scrubPat(input);
    assert.match(out, /figd_\*\*\*SCRUBBED\*\*\*/);
    assert.doesNotMatch(out, /figd_abcdef0123456789_-ghijkl/);
  });

  test('2) multiple PAT occurrences are all replaced', () => {
    const input = 'first=figd_AAAAAAAAAA, second=figd_BBBBBBBBBB';
    const out = scrubPat(input);
    const matches = out.match(/figd_\*\*\*SCRUBBED\*\*\*/g) ?? [];
    assert.equal(matches.length, 2, 'both PATs must be scrubbed');
    assert.doesNotMatch(out, /figd_AAAAAAAAAA/);
    assert.doesNotMatch(out, /figd_BBBBBBBBBB/);
  });

  test('5) multi-line input (stack trace) — PAT scrubbed across lines', () => {
    const stack = [
      'Error: Figma 403',
      '  at fetch (https://api.figma.com)',
      '  X-Figma-Token: figd_supersecret123',
      '  at handleListLayers',
    ].join('\n');
    const out = scrubPat(stack);
    assert.match(out, /figd_\*\*\*SCRUBBED\*\*\*/);
    assert.doesNotMatch(out, /figd_supersecret123/);
    // line structure preserved
    assert.ok(out.includes('Error: Figma 403'));
    assert.ok(out.includes('at handleListLayers'));
  });

  test('6) no-PAT input is returned unchanged (identity)', () => {
    const input = 'just a regular message with no secrets at all';
    assert.strictEqual(scrubPat(input), input);
  });
});

describe('scrubHeaders — header object masking', () => {
  test('3) X-Figma-Token header is masked and a NEW object is returned (no mutation)', () => {
    const input = {
      'X-Figma-Token': 'figd_realsecret_abcdef',
      'Content-Type': 'application/json',
    };
    const snapshot = { ...input }; // preserve reference values
    const out = scrubHeaders(input);
    // Returned object is masked
    assert.match(out['X-Figma-Token'] ?? '', /figd_\*\*\*SCRUBBED\*\*\*/);
    assert.strictEqual(out['Content-Type'], 'application/json');
    // Source object is unmutated
    assert.strictEqual(input['X-Figma-Token'], snapshot['X-Figma-Token']);
    assert.notStrictEqual(out, input, 'must return a new object reference');
  });

  test('3b) lowercase and mixed-case header keys are also masked', () => {
    const out = scrubHeaders({
      'x-figma-token': 'figd_secretA',
      'X-FIGMA-TOKEN': 'figd_secretB',
    });
    assert.doesNotMatch(JSON.stringify(out), /figd_secretA/);
    assert.doesNotMatch(JSON.stringify(out), /figd_secretB/);
  });
});

describe('scrubError — error message + stack scrubbing', () => {
  test('4) returns NEW Error with .message and .stack scrubbed (nested values walked)', () => {
    const err = new Error('Figma POST failed; header X-Figma-Token: figd_leak_abc123');
    // simulate a stack with the PAT
    err.stack = `Error: Figma POST failed; header X-Figma-Token: figd_leak_abc123\n  at line1\n  at line2`;
    const out = scrubError(err);
    assert.ok(out instanceof Error, 'must be an Error instance');
    assert.notStrictEqual(out, err, 'must return a NEW Error (no in-place mutation)');
    assert.doesNotMatch(out.message, /figd_leak_abc123/);
    assert.match(out.message, /figd_\*\*\*SCRUBBED\*\*\*/);
    assert.ok(out.stack, 'stack must be defined');
    assert.doesNotMatch(out.stack ?? '', /figd_leak_abc123/);
    // original is untouched
    assert.match(err.message, /figd_leak_abc123/);
  });

  test('4b) non-Error input wrapped into Error and scrubbed', () => {
    const raw = 'plain string with figd_planeleak123 inside';
    const out = scrubError(raw);
    assert.ok(out instanceof Error);
    assert.doesNotMatch(out.message, /figd_planeleak123/);
    assert.match(out.message, /figd_\*\*\*SCRUBBED\*\*\*/);
  });
});
