process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeVerifyCommand, type VerifyCheck } from './cmd-verify.js';
import { getDb } from '../runtime/store/db.js';
import { MemoryStore } from '../memory/memory-store.js';
import type { CliIO } from './commands.js';

interface CapturedIO {
  io: CliIO;
  stdout: string[];
  stderr: string[];
}

function makeIO(cwd: string): CapturedIO {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { cwd, stdout: (m) => stdout.push(m), stderr: (m) => stderr.push(m) },
    stdout,
    stderr,
  };
}

describe('executeVerifyCommand', () => {
  let tmp: string;

  beforeEach(async () => {
    // Isolate from other test files using shared :memory: DB
    getDb().prepare('DELETE FROM memories').run();
    tmp = await mkdtemp(join(tmpdir(), 'relay-verify-'));
  });

  test('runs without throwing on a clean :memory: DB and returns exit code', async () => {
    const cap = makeIO(tmp);
    const code = await executeVerifyCommand({ json: true }, cap.io);
    assert.ok(code === 0 || code === 1, 'exit code must be 0 or 1');
    await rm(tmp, { recursive: true, force: true });
  });

  test('--json emits structured result with checks + summary + ok flag', async () => {
    const cap = makeIO(tmp);
    await executeVerifyCommand({ json: true }, cap.io);
    const joined = cap.stdout.join('').trim();
    assert.ok(joined.endsWith('}'), 'must end with JSON object');
    const parsed = JSON.parse(joined) as {
      checks: VerifyCheck[];
      summary: { pass: number; fail: number; skip: number };
      ok: boolean;
    };
    assert.ok(Array.isArray(parsed.checks), 'checks array present');
    assert.ok(parsed.checks.length >= 5, 'at least 5 checks ran');
    assert.ok(typeof parsed.summary.pass === 'number');
    assert.ok(typeof parsed.summary.fail === 'number');
    assert.ok(typeof parsed.summary.skip === 'number');
    assert.ok(typeof parsed.ok === 'boolean');
    // ok must align with summary.fail (only critical failures flip ok=false,
    // but our test checks have no skips by design, so this holds)
    if (parsed.summary.fail === 0) assert.strictEqual(parsed.ok, true);
    await rm(tmp, { recursive: true, force: true });
  });

  test('checks include all 5 named steps', async () => {
    const cap = makeIO(tmp);
    await executeVerifyCommand({ json: true }, cap.io);
    const parsed = JSON.parse(cap.stdout.join('').trim()) as { checks: VerifyCheck[] };
    const names = new Set(parsed.checks.map(c => c.name));
    for (const expected of ['remember', 'recall', 'context-emit', 'hook', 'db-roundtrip']) {
      assert.ok(names.has(expected), `missing check: ${expected}`);
    }
    await rm(tmp, { recursive: true, force: true });
  });

  test('human-readable mode prints relay verify header + status badges', async () => {
    const cap = makeIO(tmp);
    await executeVerifyCommand({ json: false }, cap.io);
    const out = cap.stdout.join('');
    assert.match(out, /relay verify/);
    // each check line has a badge ([OK] [!!] or [--])
    assert.match(out, /(remember|recall|context-emit|hook|db-roundtrip)\s+\[(OK|!!|--)\]/);
    await rm(tmp, { recursive: true, force: true });
  });

  test('happy path on clean DB → all checks pass + exit 0', async () => {
    const cap = makeIO(tmp);
    const code = await executeVerifyCommand({ json: true }, cap.io);
    const parsed = JSON.parse(cap.stdout.join('').trim()) as {
      checks: VerifyCheck[];
      summary: { pass: number; fail: number; skip: number };
      ok: boolean;
    };
    // On a clean :memory: DB with no missing deps, all checks should pass.
    assert.strictEqual(parsed.summary.fail, 0, `expected 0 failures, got ${parsed.summary.fail}: ${JSON.stringify(parsed.checks.filter(c => c.status === 'fail'))}`);
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(code, 0);
    await rm(tmp, { recursive: true, force: true });
  });
});
