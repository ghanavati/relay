process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeVerifyCommand, runCommandCentralCheck, type VerifyCheck, type VerifyDeps } from './cmd-verify.js';
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

  // ---------------------------------------------------------------------------
  // 08-09 — Command Central snapshot health wired as a verify check
  // ---------------------------------------------------------------------------
  // The terminal Command Central (and `relay tui --json`) consume the bounded
  // ControlSnapshot read model. `relay verify` proves that read model builds
  // and reports the pending grant-request queue depth (D-14) so a broken
  // operator console surfaces in the smoke, not only when the TUI is opened.
  test('includes the command-central snapshot check (snapshot + pending grant depth)', async () => {
    const cap = makeIO(tmp);
    await executeVerifyCommand({ json: true }, cap.io);
    const parsed = JSON.parse(cap.stdout.join('').trim()) as { checks: VerifyCheck[] };
    const cc = parsed.checks.find(c => c.name === 'command-central');
    assert.ok(cc, 'command-central check present in verify report');
    assert.strictEqual(cc.status, 'pass', `expected pass on clean DB, got ${cc.status}: ${cc.message}`);
    assert.match(cc.message, /pending|grant/i, 'message reports pending grant-request depth');
    await rm(tmp, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // T23 — Failure-path coverage (DI stubs via VerifyDeps)
  // ---------------------------------------------------------------------------
  // Defaults: real check implementations everywhere except the one under test.
  // We stub the *other* checks to predictable passes so we isolate the failure
  // we care about. Non-critical fails (hook) must NOT flip exit code to 1.

  function passingDeps(): VerifyDeps {
    return {
      runRememberCheck: async () => ({ name: 'remember', status: 'pass', message: 'stub-pass', critical: true }),
      runRecallCheck: async () => ({ name: 'recall', status: 'pass', message: 'stub-pass', critical: true }),
      runContextEmitCheck: async () => ({ name: 'context-emit', status: 'pass', message: 'stub-pass', critical: true }),
      runHookCheck: async () => ({ name: 'hook', status: 'pass', message: 'stub-pass', critical: false }),
      runDbRoundtripCheck: async () => ({ name: 'db-roundtrip', status: 'pass', message: 'stub-pass', critical: true }),
      runControlCheck: async () => ({ name: 'control', status: 'pass', message: 'stub-pass', critical: true }),
    };
  }

  test('db write failure → db-roundtrip reports fail (critical) + exit 1', async () => {
    const cap = makeIO(tmp);
    const deps: VerifyDeps = {
      ...passingDeps(),
      runDbRoundtripCheck: async () => ({
        name: 'db-roundtrip',
        status: 'fail',
        message: 'simulated MemoryStore.remember error: disk I/O',
        critical: true,
      }),
    };
    const code = await executeVerifyCommand({ json: true }, cap.io, deps);
    const parsed = JSON.parse(cap.stdout.join('').trim()) as {
      checks: VerifyCheck[];
      summary: { pass: number; fail: number; skip: number };
      ok: boolean;
    };
    const dbCheck = parsed.checks.find(c => c.name === 'db-roundtrip');
    assert.ok(dbCheck, 'db-roundtrip check present');
    assert.strictEqual(dbCheck.status, 'fail');
    assert.strictEqual(dbCheck.critical, true);
    assert.match(dbCheck.message, /disk I\/O/);
    assert.strictEqual(parsed.ok, false, 'ok=false when critical fails');
    assert.strictEqual(code, 1, 'exit 1 on critical failure');
    await rm(tmp, { recursive: true, force: true });
  });

  test('recall returns empty after remember (mocked) → recall reports fail + exit 1', async () => {
    const cap = makeIO(tmp);
    const deps: VerifyDeps = {
      ...passingDeps(),
      // Simulate the real fail path: remember succeeded, recall returned empty,
      // so the smoke token is not in any recalled memory.
      runRecallCheck: async (token: string) => ({
        name: 'recall',
        status: 'fail',
        message: `token ${token} not in recalled memories`,
        critical: true,
      }),
    };
    const code = await executeVerifyCommand({ json: true }, cap.io, deps);
    const parsed = JSON.parse(cap.stdout.join('').trim()) as {
      checks: VerifyCheck[];
      summary: { pass: number; fail: number; skip: number };
      ok: boolean;
    };
    const recallCheck = parsed.checks.find(c => c.name === 'recall');
    assert.ok(recallCheck);
    assert.strictEqual(recallCheck.status, 'fail');
    assert.match(recallCheck.message, /not in recalled memories/);
    assert.strictEqual(parsed.summary.fail, 1);
    assert.strictEqual(parsed.summary.pass, 5);
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(code, 1);
    await rm(tmp, { recursive: true, force: true });
  });

  test('context emit returns empty (mocked) → context-emit reports fail + exit 1', async () => {
    const cap = makeIO(tmp);
    const deps: VerifyDeps = {
      ...passingDeps(),
      runContextEmitCheck: async () => ({
        name: 'context-emit',
        status: 'fail',
        message: 'recalled_lessons emitted empty content',
        critical: true,
      }),
    };
    const code = await executeVerifyCommand({ json: true }, cap.io, deps);
    const parsed = JSON.parse(cap.stdout.join('').trim()) as {
      checks: VerifyCheck[];
      summary: { pass: number; fail: number; skip: number };
      ok: boolean;
    };
    const ctxCheck = parsed.checks.find(c => c.name === 'context-emit');
    assert.ok(ctxCheck);
    assert.strictEqual(ctxCheck.status, 'fail');
    assert.strictEqual(ctxCheck.critical, true);
    assert.match(ctxCheck.message, /empty content/);
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(code, 1);
    await rm(tmp, { recursive: true, force: true });
  });

  test('HOOK_SCRIPT mocked-empty → hook reports fail (NON-critical so exit stays 0)', async () => {
    const cap = makeIO(tmp);
    // Per cmd-verify.ts, the hook check returns critical:false on a successful
    // pass. Real-code error paths DO set critical:true, but the spec for this
    // test is: a non-critical fail must not affect exit code. We stub a
    // non-critical fail to pin that contract.
    const deps: VerifyDeps = {
      ...passingDeps(),
      runHookCheck: async () => ({
        name: 'hook',
        status: 'fail',
        message: 'HOOK_SCRIPT empty (mocked)',
        critical: false,
      }),
    };
    const code = await executeVerifyCommand({ json: true }, cap.io, deps);
    const parsed = JSON.parse(cap.stdout.join('').trim()) as {
      checks: VerifyCheck[];
      summary: { pass: number; fail: number; skip: number };
      ok: boolean;
    };
    const hookCheck = parsed.checks.find(c => c.name === 'hook');
    assert.ok(hookCheck);
    assert.strictEqual(hookCheck.status, 'fail');
    assert.strictEqual(hookCheck.critical, false);
    assert.strictEqual(parsed.summary.fail, 1, 'summary records the failure');
    // Critical-failed gate did not trip → ok=true and exit 0.
    assert.strictEqual(parsed.ok, true, 'non-critical fail does not flip ok');
    assert.strictEqual(code, 0, 'non-critical fail keeps exit 0');
    await rm(tmp, { recursive: true, force: true });
  });

  test('--json output structure validated under failure (multiple critical fails)', async () => {
    const cap = makeIO(tmp);
    const deps: VerifyDeps = {
      ...passingDeps(),
      runRememberCheck: async () => ({ name: 'remember', status: 'fail', message: 'remember boom', critical: true }),
      runDbRoundtripCheck: async () => ({ name: 'db-roundtrip', status: 'fail', message: 'db boom', critical: true }),
    };
    const code = await executeVerifyCommand({ json: true }, cap.io, deps);
    const joined = cap.stdout.join('').trim();
    // JSON envelope is well-formed even on failure.
    assert.ok(joined.endsWith('}'));
    const parsed = JSON.parse(joined) as {
      checks: VerifyCheck[];
      summary: { pass: number; fail: number; skip: number };
      ok: boolean;
    };
    // Required top-level keys all present.
    assert.ok(Array.isArray(parsed.checks));
    assert.ok(parsed.summary && typeof parsed.summary === 'object');
    assert.ok(typeof parsed.ok === 'boolean');
    // Each check still has the canonical shape.
    for (const ch of parsed.checks) {
      assert.ok(typeof ch.name === 'string');
      assert.ok(['pass', 'fail', 'skip'].includes(ch.status));
      assert.ok(typeof ch.message === 'string');
      assert.ok(typeof ch.critical === 'boolean');
    }
    assert.strictEqual(parsed.summary.fail, 2);
    assert.strictEqual(parsed.summary.pass, 4);
    assert.strictEqual(parsed.summary.skip, 0);
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(code, 1);
    await rm(tmp, { recursive: true, force: true });
  });

  test('only critical fails set exit 1 — non-critical fails alone keep exit 0', async () => {
    // Mix: a non-critical fail (hook) AND a non-critical pass for everything
    // else. Confirms the gate is `critical && fail`, not just `fail`.
    const cap = makeIO(tmp);
    const deps: VerifyDeps = {
      ...passingDeps(),
      runHookCheck: async () => ({ name: 'hook', status: 'fail', message: 'soft fail', critical: false }),
    };
    const code = await executeVerifyCommand({ json: true }, cap.io, deps);
    const parsed = JSON.parse(cap.stdout.join('').trim()) as {
      checks: VerifyCheck[]; summary: { pass: number; fail: number; skip: number }; ok: boolean;
    };
    assert.strictEqual(parsed.summary.fail, 1);
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(code, 0);

    // And the inverse: a single critical fail with all others passing → exit 1.
    const cap2 = makeIO(tmp);
    const deps2: VerifyDeps = {
      ...passingDeps(),
      runRememberCheck: async () => ({ name: 'remember', status: 'fail', message: 'hard fail', critical: true }),
    };
    const code2 = await executeVerifyCommand({ json: true }, cap2.io, deps2);
    const parsed2 = JSON.parse(cap2.stdout.join('').trim()) as { ok: boolean };
    assert.strictEqual(parsed2.ok, false);
    assert.strictEqual(code2, 1);
    await rm(tmp, { recursive: true, force: true });
  });

  test('human-readable mode under failure shows red failure summary', async () => {
    const cap = makeIO(tmp);
    const deps: VerifyDeps = {
      ...passingDeps(),
      runDbRoundtripCheck: async () => ({ name: 'db-roundtrip', status: 'fail', message: 'boom', critical: true }),
    };
    const code = await executeVerifyCommand({ json: false }, cap.io, deps);
    const out = cap.stdout.join('');
    assert.match(out, /relay verify/);
    assert.match(out, /check\(s\) failed/);
    assert.strictEqual(code, 1);
    await rm(tmp, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // P2 codex finding #6 — RELAY_MEMORY_ALLOWED_WORKDIRS regression
  // ---------------------------------------------------------------------------
  // When the documented production allowlist is set, the smoke writes used
  // workdir=undefined → MemoryStore.assertWorkdirAllowed(undefined) threw
  // MEMORY_WORKDIR_FORBIDDEN → healthy installs reported false critical
  // failures on `remember` and `db-roundtrip`. The fix passes io.cwd through
  // to every smoke write/recall so the allowlist gate passes.
  test('passes smoke writes under RELAY_MEMORY_ALLOWED_WORKDIRS (P2 codex finding #6)', async () => {
    const ALLOW_LIST_ENV = 'RELAY_MEMORY_ALLOWED_WORKDIRS';
    const ALLOWED_WORKDIR = '/tmp/relay-verify-test';
    const savedAllowList = process.env[ALLOW_LIST_ENV];

    try {
      // Set the allowlist BEFORE the executeVerifyCommand call so
      // assertWorkdirAllowed() reads it on every internal write.
      process.env[ALLOW_LIST_ENV] = ALLOWED_WORKDIR;
      await mkdir(join(ALLOWED_WORKDIR, '.relay'), { recursive: true });

      const cap = makeIO(ALLOWED_WORKDIR);
      const code = await executeVerifyCommand({ json: true }, cap.io);

      const joined = cap.stdout.join('').trim();
      const parsed = JSON.parse(joined) as {
        checks: VerifyCheck[];
        summary: { pass: number; fail: number; skip: number };
        ok: boolean;
      };

      // Critical fails for the two writes used to be guaranteed under this env.
      // Asserting the negative pins the regression closed: even with the
      // allowlist set, the smoke writes must succeed because they now scope
      // to io.cwd (which is on the allow-list).
      const remember = parsed.checks.find(c => c.name === 'remember');
      const dbRoundtrip = parsed.checks.find(c => c.name === 'db-roundtrip');
      assert.ok(remember, 'remember check must be present');
      assert.ok(dbRoundtrip, 'db-roundtrip check must be present');

      const isCriticalFail = (ch: VerifyCheck): boolean =>
        ch.critical === true && ch.status === 'fail';

      assert.strictEqual(
        isCriticalFail(remember),
        false,
        `remember must not critical-fail under allowlist; message=${remember.message}`,
      );
      assert.strictEqual(
        isCriticalFail(dbRoundtrip),
        false,
        `db-roundtrip must not critical-fail under allowlist; message=${dbRoundtrip.message}`,
      );

      // And the workdir-forbidden error must not appear in any message — the
      // signature of the original bug.
      for (const ch of parsed.checks) {
        assert.doesNotMatch(
          ch.message,
          /MEMORY_WORKDIR_FORBIDDEN/i,
          `no check should leak MEMORY_WORKDIR_FORBIDDEN; ${ch.name}: ${ch.message}`,
        );
      }

      // Exit code reflects critical health only — accept either 0 (full green)
      // or 1 if some unrelated non-write check failed. The regression we care
      // about is the two write checks above.
      assert.ok(code === 0 || code === 1, `exit code ${code} out of range`);
    } finally {
      if (savedAllowList === undefined) delete process.env[ALLOW_LIST_ENV];
      else process.env[ALLOW_LIST_ENV] = savedAllowList;
      await rm(ALLOWED_WORKDIR, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 08-09 — runCommandCentralCheck unit coverage
// ---------------------------------------------------------------------------
describe('runCommandCentralCheck', () => {
  beforeEach(() => {
    // Clean control tables so the snapshot is deterministic on the shared
    // :memory: DB (other test files may have left sessions/events behind).
    const db = getDb();
    for (const table of [
      'control_delivery_attempts',
      'control_mailbox',
      'control_grants',
      'control_events',
      'control_sessions',
    ]) {
      try { db.prepare(`DELETE FROM ${table}`).run(); } catch { /* table may not exist in older schema */ }
    }
  });

  test('healthy control store → pass, reports a bounded snapshot + pending grant depth', async () => {
    const check = await runCommandCentralCheck();
    assert.strictEqual(check.name, 'command-central');
    assert.strictEqual(check.status, 'pass', `expected pass, got ${check.status}: ${check.message}`);
    assert.strictEqual(check.critical, true);
    // Clean store → zero pending grant requests, and the message must say so.
    assert.match(check.message, /0 pending grant request/i);
  });

  test('surfaces pending model-driven grant requests in the depth count', async () => {
    const { ControlSessionStore } = await import('../control/session-store.js');
    const { ControlBroker } = await import('../control/broker.js');
    const store = new ControlSessionStore();
    const broker = new ControlBroker(store);
    const now = Date.now();
    store.upsertSession({ session_id: 'cc-src', provider: 'fake', capabilities: ['register', 'tool_call'], state: 'active' });
    store.upsertSession({ session_id: 'cc-tgt', provider: 'fake', capabilities: ['register', 'mailbox'], state: 'active' });
    // A model opens a visible grant request (D-14): stays pending until a human resolves it.
    broker.requestGrant(
      {
        source_session_id: 'cc-src',
        target_session_id: 'cc-tgt',
        ttl_ms: 15 * 60_000,
        max_messages: 5,
        actor_kind: 'llm',
        reason: 'verify pending depth',
      },
      now,
    );
    const check = await runCommandCentralCheck(now);
    assert.strictEqual(check.status, 'pass');
    assert.match(check.message, /1 pending grant request/i, `pending request must be counted: ${check.message}`);
  });
});
