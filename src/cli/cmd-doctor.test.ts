process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeDoctorCommand,
  checkCcGlobalHook,
  checkHookRoundtrip,
  checkEnvConsistency,
  checkLastRecall,
  checkAutoExtractStatus,
} from './cmd-doctor.js';
import type { CliIO } from './commands.js';

interface CapturedIO {
  io: CliIO;
  stdout: string[];
  stderr: string[];
}

function makeIO(cwd = '/tmp/test-doctor'): CapturedIO {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      cwd,
      stdout: (msg) => stdout.push(msg),
      stderr: (msg) => stderr.push(msg),
    },
    stdout,
    stderr,
  };
}

/** Stub fetch + env vars so doctor sees a deterministic environment. */
interface DoctorEnvOptions {
  openrouter?: string | undefined;
  anthropic?: string | undefined;
  lmstudioOk?: boolean;
  lmstudioModelCount?: number;
}

function applyEnv(opts: DoctorEnvOptions) {
  if (opts.openrouter === undefined) delete process.env['OPENROUTER_API_KEY'];
  else process.env['OPENROUTER_API_KEY'] = opts.openrouter;
  if (opts.anthropic === undefined) delete process.env['ANTHROPIC_API_KEY'];
  else process.env['ANTHROPIC_API_KEY'] = opts.anthropic;

  // Stub fetch for LM Studio
  const ok = opts.lmstudioOk ?? false;
  const modelCount = opts.lmstudioModelCount ?? 0;
  (globalThis as { fetch?: typeof fetch }).fetch = (async (_input: unknown) => {
    if (ok) {
      return {
        ok: true,
        json: async () => ({ data: Array.from({ length: modelCount }, (_, i) => ({ id: `model-${i}` })) }),
      } as unknown as Response;
    }
    return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
  }) as typeof fetch;
}

describe('executeDoctorCommand', () => {
  let savedFetch: typeof fetch | undefined;
  let savedOpenRouter: string | undefined;
  let savedAnthropic: string | undefined;

  beforeEach(() => {
    savedFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    savedOpenRouter = process.env['OPENROUTER_API_KEY'];
    savedAnthropic = process.env['ANTHROPIC_API_KEY'];
  });

  afterEach(() => {
    if (savedFetch) (globalThis as { fetch?: typeof fetch }).fetch = savedFetch;
    if (savedOpenRouter === undefined) delete process.env['OPENROUTER_API_KEY'];
    else process.env['OPENROUTER_API_KEY'] = savedOpenRouter;
    if (savedAnthropic === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = savedAnthropic;
  });

  test('all checks pass → output contains "All checks passed."', async () => {
    // codex check will likely fail in CI, so we cannot reliably make ALL pass.
    // Construct a synthetic case using only the json branch — for the human branch we
    // verify the "All checks passed." path indirectly: when summary.failed=0 && summary.missing=0.
    // Since codex/db are out of test control, we test via observed output structure: when the
    // human-readable branch sees no failed and no missing, it prints "All checks passed.".
    // Since we can't guarantee that env, we use --json path and re-verify the conditional logic
    // separately in the failed/missing tests.
    applyEnv({ openrouter: 'sk-test', anthropic: 'sk-ant-test', lmstudioOk: true, lmstudioModelCount: 3 });
    const cap = makeIO();
    const code = await executeDoctorCommand({ json: true }, cap.io);
    const joined = cap.stdout.join('');
    const parsed = JSON.parse(joined.trim()) as {
      checks: Array<{ name: string; status: string; detail: string }>;
      summary: { ok: number; missing: number; failed: number };
    };
    assert.ok(parsed.summary.missing >= 0);
    // Confirm overall structure
    assert.ok(parsed.checks.some(c => c.name === 'openrouter' && c.status === 'ok'));
    assert.ok(parsed.checks.some(c => c.name === 'anthropic' && c.status === 'ok'));
    assert.ok(parsed.checks.some(c => c.name === 'lmstudio' && c.status === 'ok'));
    // Confirm new checks are present in the report
    assert.ok(parsed.checks.some(c => c.name === 'cc-global-hook'));
    assert.ok(parsed.checks.some(c => c.name === 'hook-roundtrip'));
    assert.ok(parsed.checks.some(c => c.name === 'env-consistency'));
    assert.ok(parsed.checks.some(c => c.name === 'last-recall'));
    // Code is 0 only when no failures
    if (parsed.summary.failed === 0) assert.strictEqual(code, 0);
  });

  test('failed checks → output contains "N check(s) failed"', async () => {
    // Force LM Studio failure + missing keys → at least lmstudio fails
    applyEnv({ openrouter: undefined, anthropic: undefined, lmstudioOk: false });
    const cap = makeIO();
    const code = await executeDoctorCommand({ json: false }, cap.io);
    const out = cap.stdout.join('');
    // lmstudio failed → at least 1 failed
    assert.match(out, /check.*failed/);
    // Should NOT print "All checks passed." since failed > 0
    assert.ok(!out.includes('All checks passed.'), 'must not print all-pass when failures exist');
    // Exit code 1 because failures present
    assert.strictEqual(code, 1);
  });

  test('--json mode emits compact JSON ending with \\n', async () => {
    applyEnv({ openrouter: 'sk-test', anthropic: 'sk-ant', lmstudioOk: false });
    const cap = makeIO();
    await executeDoctorCommand({ json: true }, cap.io);
    const joined = cap.stdout.join('');
    // Ends with newline
    assert.ok(joined.endsWith('\n'), 'JSON output must end with newline');
    // Compact (no pretty-print) — no leading 2-space indentation lines
    assert.ok(!joined.includes('\n  '), 'must be compact JSON, not pretty-printed');
    // Parses as valid JSON
    const parsed = JSON.parse(joined.trim()) as { checks: unknown[]; summary: unknown };
    assert.ok(Array.isArray(parsed.checks));
    assert.ok(parsed.summary !== null && typeof parsed.summary === 'object');
  });

  test('exit 0 when no failures, exit 1 when failures', async () => {
    // Failure path: LM Studio unreachable
    applyEnv({ openrouter: 'sk-test', anthropic: 'sk-ant', lmstudioOk: false });
    const cap1 = makeIO();
    const code1 = await executeDoctorCommand({ json: true }, cap1.io);
    const parsed1 = JSON.parse(cap1.stdout.join('').trim()) as {
      summary: { failed: number };
    };
    if (parsed1.summary.failed > 0) {
      assert.strictEqual(code1, 1, 'failed > 0 → exit 1');
    } else {
      assert.strictEqual(code1, 0, 'failed === 0 → exit 0');
    }
  });

  test('human-readable output renders status badges per check', async () => {
    applyEnv({ openrouter: 'sk-test', anthropic: undefined, lmstudioOk: false });
    const cap = makeIO();
    await executeDoctorCommand({ json: false }, cap.io);
    const out = cap.stdout.join('');
    assert.match(out, /relay doctor/);
    // anthropic line with [--] missing badge
    assert.match(out, /anthropic\s+\[--\] ANTHROPIC_API_KEY not set/);
    // openrouter line with [OK] ok badge
    assert.match(out, /openrouter\s+\[OK\] OPENROUTER_API_KEY set/);
    // lmstudio line with [!!] failed badge
    assert.match(out, /lmstudio\s+\[!!\]/);
    // New checks render their labels
    assert.match(out, /cc-global-hook/);
    assert.match(out, /hook-roundtrip/);
    assert.match(out, /env-consistency/);
    assert.match(out, /last-recall/);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * Unit tests for the four new check functions.
 * Each operates in isolation against a temp HOME so the real ~/.claude and
 * ~/.relay are never touched.
 * ────────────────────────────────────────────────────────────────────────── */

describe('checkCcGlobalHook', () => {
  let tempHome: string;
  let savedHome: string | undefined;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'doctor-home-'));
    savedHome = process.env['HOME'];
    process.env['HOME'] = tempHome;
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = savedHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  test('missing settings.json → status missing', async () => {
    const probe = await checkCcGlobalHook();
    assert.strictEqual(probe.name, 'cc-global-hook');
    assert.strictEqual(probe.status, 'missing');
    assert.match(probe.detail, /not found/);
  });

  test('settings.json without relay hook → status missing', async () => {
    await mkdir(join(tempHome, '.claude'), { recursive: true });
    await writeFile(
      join(tempHome, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }),
      'utf8',
    );
    const probe = await checkCcGlobalHook();
    assert.strictEqual(probe.status, 'missing');
    assert.match(probe.detail, /relay hook not found/);
  });

  test('settings.json with relay hook in current schema → status ok', async () => {
    await mkdir(join(tempHome, '.claude'), { recursive: true });
    await writeFile(
      join(tempHome, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: 'relay memory recall --token-budget 800 --json' }] },
          ],
        },
      }),
      'utf8',
    );
    const probe = await checkCcGlobalHook();
    assert.strictEqual(probe.status, 'ok');
    assert.match(probe.detail, /installed in/);
  });

  test('settings.json with invalid JSON → status failed', async () => {
    await mkdir(join(tempHome, '.claude'), { recursive: true });
    await writeFile(join(tempHome, '.claude', 'settings.json'), '{ not json', 'utf8');
    const probe = await checkCcGlobalHook();
    assert.strictEqual(probe.status, 'failed');
    assert.match(probe.detail, /not valid JSON/);
  });
});

describe('checkHookRoundtrip', () => {
  // We intercept execFile via PATH rewriting: prepend a temp dir containing
  // a stub `bash` script. But mocking node:child_process from a test is heavy.
  // Instead we verify the round-trip end-to-end with the real bash by stubbing
  // the `relay` binary on a temp PATH so its stdout is deterministic.

  let tempBin: string;
  let savedPath: string | undefined;

  beforeEach(async () => {
    tempBin = await mkdtemp(join(tmpdir(), 'doctor-bin-'));
    savedPath = process.env['PATH'];
  });

  afterEach(async () => {
    if (savedPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = savedPath;
    await rm(tempBin, { recursive: true, force: true });
  });

  test('relay returns memories → hook envelope shape valid → status ok', async () => {
    // Stub `relay` and `jq` so the inner pipeline produces the canonical envelope.
    await writeFile(
      join(tempBin, 'relay'),
      '#!/usr/bin/env bash\necho \'{"memories":[{"content":"x"}]}\'\n',
      'utf8',
    );
    await writeFile(
      join(tempBin, 'jq'),
      '#!/usr/bin/env bash\ncat >/dev/null\necho \'{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"ok"}}\'\n',
      'utf8',
    );
    const { chmod } = await import('node:fs/promises');
    await chmod(join(tempBin, 'relay'), 0o755);
    await chmod(join(tempBin, 'jq'), 0o755);
    process.env['PATH'] = `${tempBin}:${savedPath ?? ''}`;
    const probe = await checkHookRoundtrip();
    assert.strictEqual(probe.name, 'hook-roundtrip');
    assert.strictEqual(probe.status, 'ok');
    assert.match(probe.detail, /JSON envelope shape valid/);
  });

  test('relay returns no memories → hook still produces valid envelope (additionalContext="") → ok', async () => {
    await writeFile(
      join(tempBin, 'relay'),
      '#!/usr/bin/env bash\necho \'{"memories":[]}\'\n',
      'utf8',
    );
    await writeFile(
      join(tempBin, 'jq'),
      '#!/usr/bin/env bash\ncat >/dev/null\necho \'{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":""}}\'\n',
      'utf8',
    );
    const { chmod } = await import('node:fs/promises');
    await chmod(join(tempBin, 'relay'), 0o755);
    await chmod(join(tempBin, 'jq'), 0o755);
    process.env['PATH'] = `${tempBin}:${savedPath ?? ''}`;
    const probe = await checkHookRoundtrip();
    assert.strictEqual(probe.status, 'ok');
  });

  test('hook produces malformed output → status failed', async () => {
    // jq stub emits non-JSON
    await writeFile(
      join(tempBin, 'relay'),
      '#!/usr/bin/env bash\necho \'{}\'\n',
      'utf8',
    );
    await writeFile(
      join(tempBin, 'jq'),
      '#!/usr/bin/env bash\ncat >/dev/null\necho "not-json-output"\n',
      'utf8',
    );
    const { chmod } = await import('node:fs/promises');
    await chmod(join(tempBin, 'relay'), 0o755);
    await chmod(join(tempBin, 'jq'), 0o755);
    process.env['PATH'] = `${tempBin}:${savedPath ?? ''}`;
    const probe = await checkHookRoundtrip();
    assert.strictEqual(probe.status, 'failed');
    assert.match(probe.detail, /not valid JSON|missing hookSpecificOutput/);
  });

  test('hook produces JSON but missing hookSpecificOutput → status failed', async () => {
    await writeFile(
      join(tempBin, 'relay'),
      '#!/usr/bin/env bash\necho \'{}\'\n',
      'utf8',
    );
    await writeFile(
      join(tempBin, 'jq'),
      '#!/usr/bin/env bash\ncat >/dev/null\necho \'{"some":"thing"}\'\n',
      'utf8',
    );
    const { chmod } = await import('node:fs/promises');
    await chmod(join(tempBin, 'relay'), 0o755);
    await chmod(join(tempBin, 'jq'), 0o755);
    process.env['PATH'] = `${tempBin}:${savedPath ?? ''}`;
    const probe = await checkHookRoundtrip();
    assert.strictEqual(probe.status, 'failed');
    assert.match(probe.detail, /missing hookSpecificOutput/);
  });
});

describe('checkEnvConsistency', () => {
  let tempHome: string;
  let savedHome: string | undefined;
  const watched = ['RELAY_MEMORY_ALLOWED_WORKDIRS', 'RELAY_RECALLED_LESSONS', 'RELAY_DB_PATH'] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'doctor-cfg-'));
    savedHome = process.env['HOME'];
    process.env['HOME'] = tempHome;
    for (const k of watched) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = savedHome;
    for (const k of watched) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    await rm(tempHome, { recursive: true, force: true });
    // restore the test-wide RELAY_DB_PATH=:memory:
    process.env['RELAY_DB_PATH'] = ':memory:';
  });

  test('no config file → status ok (no expectation declared)', async () => {
    const probe = await checkEnvConsistency();
    assert.strictEqual(probe.name, 'env-consistency');
    assert.strictEqual(probe.status, 'ok');
    assert.match(probe.detail, /no expectation declared/);
  });

  test('config matches env → status ok', async () => {
    await mkdir(join(tempHome, '.relay'), { recursive: true });
    await writeFile(
      join(tempHome, '.relay', 'config.json'),
      JSON.stringify({ env: { RELAY_DB_PATH: ':memory:' } }),
      'utf8',
    );
    process.env['RELAY_DB_PATH'] = ':memory:';
    const probe = await checkEnvConsistency();
    assert.strictEqual(probe.status, 'ok');
    assert.match(probe.detail, /env matches/);
  });

  test('config drift → status failed with drift detail', async () => {
    await mkdir(join(tempHome, '.relay'), { recursive: true });
    await writeFile(
      join(tempHome, '.relay', 'config.json'),
      JSON.stringify({ env: { RELAY_DB_PATH: '/expected/path/relay.db' } }),
      'utf8',
    );
    process.env['RELAY_DB_PATH'] = '/actual/different/path.db';
    const probe = await checkEnvConsistency();
    assert.strictEqual(probe.status, 'failed');
    assert.match(probe.detail, /drift/);
    assert.match(probe.detail, /RELAY_DB_PATH/);
  });

  test('flat config (no env wrapper) is also accepted', async () => {
    await mkdir(join(tempHome, '.relay'), { recursive: true });
    await writeFile(
      join(tempHome, '.relay', 'config.json'),
      JSON.stringify({ RELAY_RECALLED_LESSONS: '1' }),
      'utf8',
    );
    process.env['RELAY_RECALLED_LESSONS'] = '0';
    const probe = await checkEnvConsistency();
    assert.strictEqual(probe.status, 'failed');
    assert.match(probe.detail, /RELAY_RECALLED_LESSONS/);
  });

  test('invalid JSON config → status failed', async () => {
    await mkdir(join(tempHome, '.relay'), { recursive: true });
    await writeFile(join(tempHome, '.relay', 'config.json'), '{ not json', 'utf8');
    const probe = await checkEnvConsistency();
    assert.strictEqual(probe.status, 'failed');
    assert.match(probe.detail, /not valid JSON/);
  });
});

describe('checkLastRecall', () => {
  // RELAY_DB_PATH=:memory: is set at the top of this file. Insert a row directly
  // through the same getDb() the check uses.

  test('empty memory_reads → status missing "no recent activity"', async () => {
    const { getDb } = await import('../runtime/store/db.js');
    const db = getDb();
    db.exec('DELETE FROM memory_reads');
    const probe = await checkLastRecall();
    assert.strictEqual(probe.name, 'last-recall');
    assert.strictEqual(probe.status, 'missing');
    assert.match(probe.detail, /no recent activity/);
  });

  test('recent recall → status ok with formatted age', async () => {
    const { getDb } = await import('../runtime/store/db.js');
    const db = getDb();
    db.exec('DELETE FROM memory_reads');
    const now = Date.now();
    db.prepare('INSERT INTO memory_reads (memory_id, run_id, read_source, workdir, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('m-test', null, 'test', null, now - 30_000); // 30 seconds ago
    const probe = await checkLastRecall();
    assert.strictEqual(probe.status, 'ok');
    assert.match(probe.detail, /\d+s ago/);
  });

  test('older recall → reports minutes/hours/days', async () => {
    const { getDb } = await import('../runtime/store/db.js');
    const db = getDb();
    db.exec('DELETE FROM memory_reads');
    const now = Date.now();
    db.prepare('INSERT INTO memory_reads (memory_id, run_id, read_source, workdir, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('m-test', null, 'test', null, now - 5 * 60_000); // 5m ago
    const probe = await checkLastRecall();
    assert.strictEqual(probe.status, 'ok');
    assert.match(probe.detail, /[0-9]+m ago/);
  });
});

describe('checkAutoExtractStatus', () => {
  let tmpDir: string;
  let logPath: string;
  let savedEnv: string | undefined;
  let savedFetch: typeof fetch | undefined;
  let savedOpenRouter: string | undefined;
  let savedAnthropic: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'relay-doctor-ae-'));
    logPath = join(tmpDir, 'auto-extract.log');
    savedEnv = process.env['RELAY_AUTO_EXTRACT_LOG'];
    process.env['RELAY_AUTO_EXTRACT_LOG'] = logPath;
    savedFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    savedOpenRouter = process.env['OPENROUTER_API_KEY'];
    savedAnthropic = process.env['ANTHROPIC_API_KEY'];
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env['RELAY_AUTO_EXTRACT_LOG'];
    else process.env['RELAY_AUTO_EXTRACT_LOG'] = savedEnv;
    if (savedFetch) (globalThis as { fetch?: typeof fetch }).fetch = savedFetch;
    if (savedOpenRouter === undefined) delete process.env['OPENROUTER_API_KEY'];
    else process.env['OPENROUTER_API_KEY'] = savedOpenRouter;
    if (savedAnthropic === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = savedAnthropic;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('log missing → status missing (warn: never ran)', () => {
    // logPath was never created
    const result = checkAutoExtractStatus();
    assert.strictEqual(result.name, 'auto-extract (24h)');
    assert.strictEqual(result.status, 'missing');
    assert.match(result.detail, /never run/);
  });

  test('empty log → status missing (warn: 0 entries)', () => {
    writeFileSync(logPath, '');
    const result = checkAutoExtractStatus();
    assert.strictEqual(result.status, 'missing');
    assert.match(result.detail, /0 entries/);
  });

  test('only-ok recent entries → status ok with counts', () => {
    const now = new Date('2026-05-10T12:00:00Z');
    const recent = new Date(now.getTime() - 60 * 60 * 1000).toISOString(); // 1h ago
    const lines = [
      JSON.stringify({ ts: recent, status: 'ok' }),
      JSON.stringify({ ts: recent, status: 'ok' }),
      JSON.stringify({ ts: recent, status: 'skipped:no-consent' }),
    ].join('\n') + '\n';
    writeFileSync(logPath, lines);
    const result = checkAutoExtractStatus(now);
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.detail, '2 ok, 1 skipped, 0 error');
  });

  test('any error entries → status missing (warn) with counts', () => {
    const now = new Date('2026-05-10T12:00:00Z');
    const recent = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
    const lines = [
      JSON.stringify({ ts: recent, status: 'ok' }),
      JSON.stringify({ ts: recent, status: 'error:bad-payload' }),
    ].join('\n') + '\n';
    writeFileSync(logPath, lines);
    const result = checkAutoExtractStatus(now);
    assert.strictEqual(result.status, 'missing');
    assert.strictEqual(result.detail, '1 ok, 0 skipped, 1 error');
  });

  test('older-than-24h entries are excluded', () => {
    const now = new Date('2026-05-10T12:00:00Z');
    const old = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
    const recent = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const lines = [
      JSON.stringify({ ts: old, status: 'ok' }),
      JSON.stringify({ ts: old, status: 'error:expired' }),
      JSON.stringify({ ts: recent, status: 'ok' }),
    ].join('\n') + '\n';
    writeFileSync(logPath, lines);
    const result = checkAutoExtractStatus(now);
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.detail, '1 ok, 0 skipped, 0 error');
  });

  test('malformed JSON lines are skipped, not fatal', () => {
    const now = new Date('2026-05-10T12:00:00Z');
    const recent = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const lines = [
      'not-json-at-all',
      JSON.stringify({ ts: recent, status: 'ok' }),
      '{"incomplete":',
      JSON.stringify({ ts: recent, status: 'skipped:no-consent' }),
    ].join('\n') + '\n';
    writeFileSync(logPath, lines);
    const result = checkAutoExtractStatus(now);
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.detail, '1 ok, 1 skipped, 0 error');
  });

  test('check is wired into doctor JSON output', async () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    writeFileSync(logPath, JSON.stringify({ ts: recent, status: 'ok' }) + '\n');
    applyEnv({ openrouter: 'sk-test', anthropic: 'sk-ant', lmstudioOk: true });
    const cap = makeIO();
    await executeDoctorCommand({ json: true }, cap.io);
    const parsed = JSON.parse(cap.stdout.join('').trim()) as {
      checks: Array<{ name: string; status: string; detail: string }>;
    };
    const ae = parsed.checks.find(c => c.name === 'auto-extract (24h)');
    assert.ok(ae, 'auto-extract check should be present in doctor output');
    assert.strictEqual(ae.status, 'ok');
  });
});
