import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  executeBudgetShowCommand,
  BUDGET_DEFERRED_MESSAGE,
  BUDGET_DEFERRED_REASON,
  BUDGET_DEFERRED_TARGET,
} from './cmd-budget.js';
import type { CliIO } from './commands.js';

interface CapturedIO {
  io: CliIO;
  stdout: string[];
  stderr: string[];
}

function makeIO(): CapturedIO {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { cwd: '/tmp', stdout: (m) => stdout.push(m), stderr: (m) => stderr.push(m) },
    stdout,
    stderr,
  };
}

describe('executeBudgetShowCommand', () => {
  test('text mode: returns 0, prints deferred-to-v0.2 message to stdout, no stderr', () => {
    const cap = makeIO();
    const code = executeBudgetShowCommand({ json: false }, cap.io);
    assert.strictEqual(code, 0);
    assert.strictEqual(cap.stdout.join(''), `${BUDGET_DEFERRED_MESSAGE}\n`);
    assert.strictEqual(cap.stderr.join(''), '');
  });

  test('text mode: message references CHANGELOG forward-pointer', () => {
    const cap = makeIO();
    executeBudgetShowCommand({ json: false }, cap.io);
    const out = cap.stdout.join('');
    assert.match(out, /Deferred to v0\.2/);
    assert.match(out, /CHANGELOG\.md/);
  });

  test('json mode: returns 0 with status=deferred + target_version + reason', () => {
    const cap = makeIO();
    const code = executeBudgetShowCommand({ json: true }, cap.io);
    assert.strictEqual(code, 0);
    assert.strictEqual(cap.stderr.join(''), '');
    const out = cap.stdout.join('').trim();
    const parsed = JSON.parse(out);
    assert.deepStrictEqual(parsed, {
      status: 'deferred',
      target_version: BUDGET_DEFERRED_TARGET,
      reason: BUDGET_DEFERRED_REASON,
    });
  });

  test('json mode: target_version is exactly 0.2.0 and reason mentions per-provider scope', () => {
    const cap = makeIO();
    executeBudgetShowCommand({ json: true }, cap.io);
    const parsed = JSON.parse(cap.stdout.join('').trim());
    assert.strictEqual(parsed.target_version, '0.2.0');
    assert.match(parsed.reason, /per-provider scope/);
  });

  test('json mode: emits valid single-line JSON terminated by newline', () => {
    const cap = makeIO();
    executeBudgetShowCommand({ json: true }, cap.io);
    const raw = cap.stdout.join('');
    assert.ok(raw.endsWith('\n'), 'json output must end with a newline');
    const lines = raw.split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 1, 'json mode must emit exactly one line');
  });
});
