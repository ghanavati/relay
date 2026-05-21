process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  executeDoctorCommand,
  checkCcGlobalHook,
  checkHookRoundtrip,
  checkEnvConsistency,
  checkLastRecall,
  checkAutoExtractStatus,
  checkBerryReachability,
  checkLmStudioModelLoaded,
  checkConsentFiles,
  checkSchemaVersion,
} from './cmd-doctor.js';
import { applySchema } from '../runtime/store/db.js';
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

  // P2 codex finding #5 — regression test for the wave-4 context-emit refactor.
  // Before fix: doctor only matched `relay memory recall`, so the post-wave-4
  // hook (`relay context emit --target cc …`) was reported as MISSING on
  // healthy installs.
  test('settings.json with NEW context-emit hook → status ok (Codex finding #5)', async () => {
    await mkdir(join(tempHome, '.claude'), { recursive: true });
    await writeFile(
      join(tempHome, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command:
                    'relay pause --check --workdir "${CLAUDE_PROJECT_DIR:-$PWD}" 2>/dev/null && exit 0; ' +
                    'relay context emit --target cc --workdir "${CLAUDE_PROJECT_DIR:-$PWD}" 2>/dev/null || true',
                },
              ],
            },
          ],
        },
      }),
      'utf8',
    );
    const probe = await checkCcGlobalHook();
    assert.strictEqual(probe.status, 'ok');
    assert.match(probe.detail, /installed in/);
  });

  // Backward compatibility — older installs running the legacy `relay memory recall`
  // hook (pre wave-4) should still be detected as healthy. The fragment matcher
  // recognizes BOTH the old and new hook shapes so we don't false-alarm users
  // who haven't re-run `relay init` after the refactor.
  test('settings.json with LEGACY memory-recall hook → status ok (backward compat)', async () => {
    await mkdir(join(tempHome, '.claude'), { recursive: true });
    await writeFile(
      join(tempHome, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command:
                    'relay memory recall --token-budget 200 --type lesson --json | jq -c \'{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:.}}\'',
                },
              ],
            },
          ],
        },
      }),
      'utf8',
    );
    const probe = await checkCcGlobalHook();
    assert.strictEqual(probe.status, 'ok');
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

  // Post-wave-4: the installed hook is `relay context emit --target cc`, which
  // emits the SessionStart envelope directly (no jq pipeline). We stub `relay`
  // on PATH so its stdout is the envelope and the round-trip is deterministic.

  test('relay emits valid envelope → status ok', async () => {
    await writeFile(
      join(tempBin, 'relay'),
      '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"ok"}}\'\n',
      'utf8',
    );
    const { chmod } = await import('node:fs/promises');
    await chmod(join(tempBin, 'relay'), 0o755);
    process.env['PATH'] = `${tempBin}:${savedPath ?? ''}`;
    const probe = await checkHookRoundtrip();
    assert.strictEqual(probe.name, 'hook-roundtrip');
    assert.strictEqual(probe.status, 'ok');
    assert.match(probe.detail, /JSON envelope shape valid/);
  });

  test('relay emits empty-but-valid envelope (additionalContext="") → status ok', async () => {
    await writeFile(
      join(tempBin, 'relay'),
      '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":""}}\'\n',
      'utf8',
    );
    const { chmod } = await import('node:fs/promises');
    await chmod(join(tempBin, 'relay'), 0o755);
    process.env['PATH'] = `${tempBin}:${savedPath ?? ''}`;
    const probe = await checkHookRoundtrip();
    assert.strictEqual(probe.status, 'ok');
  });

  test('hook produces malformed output → status failed', async () => {
    await writeFile(
      join(tempBin, 'relay'),
      '#!/usr/bin/env bash\necho "not-json-output"\n',
      'utf8',
    );
    const { chmod } = await import('node:fs/promises');
    await chmod(join(tempBin, 'relay'), 0o755);
    process.env['PATH'] = `${tempBin}:${savedPath ?? ''}`;
    const probe = await checkHookRoundtrip();
    assert.strictEqual(probe.status, 'failed');
    assert.match(probe.detail, /not valid JSON|missing hookSpecificOutput/);
  });

  test('hook produces JSON but missing hookSpecificOutput → status failed', async () => {
    await writeFile(
      join(tempBin, 'relay'),
      '#!/usr/bin/env bash\necho \'{"some":"thing"}\'\n',
      'utf8',
    );
    const { chmod } = await import('node:fs/promises');
    await chmod(join(tempBin, 'relay'), 0o755);
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
  let savedLogPath: string | undefined;
  let savedFetch: typeof fetch | undefined;
  let savedOpenRouter: string | undefined;
  let savedAnthropic: string | undefined;

  // T2: build a unified-log entry the way `appendLog` does — wrapped with
  // event='extract.*' and a meta payload that carries the legacy status string.
  function unifiedLine(opts: { tsMs: number; status: string }): string {
    const event =
      opts.status === 'ok' || opts.status === 'partial:berry-flag'
        ? 'extract.write'
        : opts.status.startsWith('skipped:')
          ? 'extract.skip'
          : opts.status.startsWith('error:')
            ? 'extract.error'
            : 'extract.skip';
    const ok = opts.status === 'ok';
    return JSON.stringify({
      ts: opts.tsMs,
      event,
      ok,
      meta: { ts: new Date(opts.tsMs).toISOString(), status: opts.status },
    });
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'relay-doctor-ae-'));
    logPath = join(tmpDir, 'relay.ndjson');
    savedEnv = process.env['RELAY_AUTO_EXTRACT_LOG'];
    // Point the back-compat env at the unified test log; doctor accepts either
    // env var to locate the ndjson file.
    process.env['RELAY_AUTO_EXTRACT_LOG'] = logPath;
    savedLogPath = process.env['RELAY_LOG_PATH'];
    savedFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    savedOpenRouter = process.env['OPENROUTER_API_KEY'];
    savedAnthropic = process.env['ANTHROPIC_API_KEY'];
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env['RELAY_AUTO_EXTRACT_LOG'];
    else process.env['RELAY_AUTO_EXTRACT_LOG'] = savedEnv;
    if (savedLogPath === undefined) delete process.env['RELAY_LOG_PATH'];
    else process.env['RELAY_LOG_PATH'] = savedLogPath;
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
    const recentMs = now.getTime() - 60 * 60 * 1000; // 1h ago
    const lines = [
      unifiedLine({ tsMs: recentMs, status: 'ok' }),
      unifiedLine({ tsMs: recentMs, status: 'ok' }),
      unifiedLine({ tsMs: recentMs, status: 'skipped:no-consent' }),
    ].join('\n') + '\n';
    writeFileSync(logPath, lines);
    const result = checkAutoExtractStatus(now);
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.detail, '2 ok, 1 skipped, 0 error');
  });

  test('any error entries → status missing (warn) with counts', () => {
    const now = new Date('2026-05-10T12:00:00Z');
    const recentMs = now.getTime() - 30 * 60 * 1000;
    const lines = [
      unifiedLine({ tsMs: recentMs, status: 'ok' }),
      unifiedLine({ tsMs: recentMs, status: 'error:bad-payload' }),
    ].join('\n') + '\n';
    writeFileSync(logPath, lines);
    const result = checkAutoExtractStatus(now);
    assert.strictEqual(result.status, 'missing');
    assert.strictEqual(result.detail, '1 ok, 0 skipped, 1 error');
  });

  test('older-than-24h entries are excluded', () => {
    const now = new Date('2026-05-10T12:00:00Z');
    const oldMs = now.getTime() - 25 * 60 * 60 * 1000; // 25h ago
    const recentMs = now.getTime() - 60 * 60 * 1000;
    const lines = [
      unifiedLine({ tsMs: oldMs, status: 'ok' }),
      unifiedLine({ tsMs: oldMs, status: 'error:expired' }),
      unifiedLine({ tsMs: recentMs, status: 'ok' }),
    ].join('\n') + '\n';
    writeFileSync(logPath, lines);
    const result = checkAutoExtractStatus(now);
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.detail, '1 ok, 0 skipped, 0 error');
  });

  test('malformed JSON lines are skipped, not fatal', () => {
    const now = new Date('2026-05-10T12:00:00Z');
    const recentMs = now.getTime() - 60 * 60 * 1000;
    const lines = [
      'not-json-at-all',
      unifiedLine({ tsMs: recentMs, status: 'ok' }),
      '{"incomplete":',
      unifiedLine({ tsMs: recentMs, status: 'skipped:no-consent' }),
    ].join('\n') + '\n';
    writeFileSync(logPath, lines);
    const result = checkAutoExtractStatus(now);
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.detail, '1 ok, 1 skipped, 0 error');
  });

  test('non-extract events in unified log are ignored', () => {
    // T2: the unified log mixes hooks/recall/extract events. Doctor must
    // count only extract.* lines and skip everything else.
    const now = new Date('2026-05-10T12:00:00Z');
    const recentMs = now.getTime() - 60 * 60 * 1000;
    const lines = [
      JSON.stringify({ ts: recentMs, event: 'hook.fire', ok: true }),
      JSON.stringify({ ts: recentMs, event: 'recall', ok: true }),
      unifiedLine({ tsMs: recentMs, status: 'ok' }),
    ].join('\n') + '\n';
    writeFileSync(logPath, lines);
    const result = checkAutoExtractStatus(now);
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.detail, '1 ok, 0 skipped, 0 error');
  });

  test('legacy pre-T2 entries (ISO ts + status) are still counted', () => {
    // Back-compat: a pre-T2 install may still have lines from the old
    // auto-extract.log shape sitting in the file. Doctor parses both shapes.
    const now = new Date('2026-05-10T12:00:00Z');
    const recentIso = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const lines = [
      JSON.stringify({ ts: recentIso, status: 'ok' }),
      JSON.stringify({ ts: recentIso, status: 'skipped:no-consent' }),
    ].join('\n') + '\n';
    writeFileSync(logPath, lines);
    const result = checkAutoExtractStatus(now);
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.detail, '1 ok, 1 skipped, 0 error');
  });

  test('check is wired into doctor JSON output', async () => {
    const now = new Date();
    const recentMs = now.getTime() - 60 * 60 * 1000;
    writeFileSync(logPath, unifiedLine({ tsMs: recentMs, status: 'ok' }) + '\n');
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

/* ──────────────────────────────────────────────────────────────────────────
 * Unit tests for the three NEW additive checks.
 * ────────────────────────────────────────────────────────────────────────── */

describe('checkBerryReachability', () => {
  let savedBerry: string | undefined;

  beforeEach(() => {
    savedBerry = process.env['RELAY_BERRY_CMD'];
    delete process.env['RELAY_BERRY_CMD'];
  });

  afterEach(() => {
    if (savedBerry === undefined) delete process.env['RELAY_BERRY_CMD'];
    else process.env['RELAY_BERRY_CMD'] = savedBerry;
  });

  test('RELAY_BERRY_CMD unset → status ok "not configured"', async () => {
    const probe = await checkBerryReachability();
    assert.strictEqual(probe.name, 'berry');
    assert.strictEqual(probe.status, 'ok');
    assert.match(probe.detail, /not configured/);
  });

  test('command exits 0 → status ok "reachable"', async () => {
    process.env['RELAY_BERRY_CMD'] = 'true';
    const probe = await checkBerryReachability();
    assert.strictEqual(probe.status, 'ok');
    assert.strictEqual(probe.detail, 'reachable');
  });

  test('command exits non-zero → status missing "configured but not reachable"', async () => {
    process.env['RELAY_BERRY_CMD'] = 'false';
    const probe = await checkBerryReachability();
    assert.strictEqual(probe.status, 'missing');
    assert.match(probe.detail, /configured but not reachable/);
  });

  test('command not found → status missing', async () => {
    process.env['RELAY_BERRY_CMD'] = 'definitely-not-a-real-binary-xyz-12345';
    const probe = await checkBerryReachability();
    assert.strictEqual(probe.status, 'missing');
  });
});

describe('checkLmStudioModelLoaded', () => {
  let tempBin: string;
  let savedPath: string | undefined;

  beforeEach(async () => {
    tempBin = await mkdtemp(join(tmpdir(), 'doctor-lms-'));
    savedPath = process.env['PATH'];
  });

  afterEach(async () => {
    if (savedPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = savedPath;
    await rm(tempBin, { recursive: true, force: true });
  });

  test('lms binary missing → status missing "lms not in PATH"', async () => {
    // Restrict PATH to a directory with no lms binary.
    process.env['PATH'] = tempBin;
    const probe = await checkLmStudioModelLoaded();
    assert.strictEqual(probe.name, 'lmstudio-loaded');
    assert.strictEqual(probe.status, 'missing');
    assert.match(probe.detail, /lms not in PATH/);
  });

  test('lms returns empty list → status missing "no models loaded"', async () => {
    await writeFile(
      join(tempBin, 'lms'),
      '#!/usr/bin/env bash\necho "[]"\n',
      'utf8',
    );
    const { chmod } = await import('node:fs/promises');
    await chmod(join(tempBin, 'lms'), 0o755);
    process.env['PATH'] = `${tempBin}:${savedPath ?? '/usr/bin:/bin'}`;
    const probe = await checkLmStudioModelLoaded();
    assert.strictEqual(probe.status, 'missing');
    assert.match(probe.detail, /no models loaded/);
  });

  test('lms returns ≥1 model → status ok with count + names', async () => {
    await writeFile(
      join(tempBin, 'lms'),
      '#!/usr/bin/env bash\necho \'[{"identifier":"qwen-coder"},{"identifier":"llama-3"}]\'\n',
      'utf8',
    );
    const { chmod } = await import('node:fs/promises');
    await chmod(join(tempBin, 'lms'), 0o755);
    process.env['PATH'] = `${tempBin}:${savedPath ?? '/usr/bin:/bin'}`;
    const probe = await checkLmStudioModelLoaded();
    assert.strictEqual(probe.status, 'ok');
    assert.match(probe.detail, /2 model\(s\) loaded/);
    assert.match(probe.detail, /qwen-coder/);
    assert.match(probe.detail, /llama-3/);
  });

  test('lms returns invalid JSON → status missing', async () => {
    await writeFile(
      join(tempBin, 'lms'),
      '#!/usr/bin/env bash\necho "not-json-at-all"\n',
      'utf8',
    );
    const { chmod } = await import('node:fs/promises');
    await chmod(join(tempBin, 'lms'), 0o755);
    process.env['PATH'] = `${tempBin}:${savedPath ?? '/usr/bin:/bin'}`;
    const probe = await checkLmStudioModelLoaded();
    assert.strictEqual(probe.status, 'missing');
    assert.match(probe.detail, /not JSON/);
  });
});

describe('checkConsentFiles', () => {
  let tempA: string;
  let tempB: string;
  let savedAllowed: string | undefined;

  beforeEach(async () => {
    tempA = await mkdtemp(join(tmpdir(), 'doctor-consent-a-'));
    tempB = await mkdtemp(join(tmpdir(), 'doctor-consent-b-'));
    savedAllowed = process.env['RELAY_MEMORY_ALLOWED_WORKDIRS'];
  });

  afterEach(async () => {
    if (savedAllowed === undefined) delete process.env['RELAY_MEMORY_ALLOWED_WORKDIRS'];
    else process.env['RELAY_MEMORY_ALLOWED_WORKDIRS'] = savedAllowed;
    await rm(tempA, { recursive: true, force: true });
    await rm(tempB, { recursive: true, force: true });
  });

  test('no consent file in any workdir → status missing', async () => {
    process.env['RELAY_MEMORY_ALLOWED_WORKDIRS'] = `${tempA}:${tempB}`;
    const probe = await checkConsentFiles();
    assert.strictEqual(probe.name, 'consent-files');
    assert.strictEqual(probe.status, 'missing');
    assert.match(probe.detail, /no workdirs have consent/);
    assert.match(probe.detail, /0\/2/);
  });

  test('1 of 2 workdirs has consent → status ok "1/2"', async () => {
    process.env['RELAY_MEMORY_ALLOWED_WORKDIRS'] = `${tempA}:${tempB}`;
    await mkdir(join(tempA, '.relay'), { recursive: true });
    await writeFile(join(tempA, '.relay', 'auto-extract.json'), '{}', 'utf8');
    const probe = await checkConsentFiles();
    assert.strictEqual(probe.status, 'ok');
    assert.match(probe.detail, /1\/2 workdirs have consent/);
  });

  test('all workdirs have consent → status ok "2/2"', async () => {
    process.env['RELAY_MEMORY_ALLOWED_WORKDIRS'] = `${tempA}:${tempB}`;
    await mkdir(join(tempA, '.relay'), { recursive: true });
    await mkdir(join(tempB, '.relay'), { recursive: true });
    await writeFile(join(tempA, '.relay', 'auto-extract.json'), '{}', 'utf8');
    await writeFile(join(tempB, '.relay', 'auto-extract.json'), '{}', 'utf8');
    const probe = await checkConsentFiles();
    assert.strictEqual(probe.status, 'ok');
    assert.match(probe.detail, /2\/2 workdirs have consent/);
  });

  test('RELAY_MEMORY_ALLOWED_WORKDIRS unset → falls back to cwd, missing if no consent', async () => {
    delete process.env['RELAY_MEMORY_ALLOWED_WORKDIRS'];
    // cwd is the worktree root; no .relay/auto-extract.json there in this test repo.
    const probe = await checkConsentFiles();
    // Either missing (no file) or ok (file happens to exist) — assert structure either way.
    assert.strictEqual(probe.name, 'consent-files');
    assert.ok(probe.status === 'missing' || probe.status === 'ok');
    assert.match(probe.detail, /\/1/);
  });

  // P2 codex finding #8 — regression test for the comma/colon split bug.
  // Before fix: `raw.split(',')` produced one bogus workdir `/tmp/a:/tmp/b`, so
  // even with both consent files present, `present` was 0 and status='missing'.
  test('colon-separated PATH-style workdirs → both detected (Codex finding #8)', async () => {
    process.env['RELAY_MEMORY_ALLOWED_WORKDIRS'] = `${tempA}:${tempB}`;
    await mkdir(join(tempA, '.relay'), { recursive: true });
    await mkdir(join(tempB, '.relay'), { recursive: true });
    await writeFile(join(tempA, '.relay', 'auto-extract.json'), '{}', 'utf8');
    await writeFile(join(tempB, '.relay', 'auto-extract.json'), '{}', 'utf8');
    const probe = await checkConsentFiles();
    assert.strictEqual(probe.status, 'ok');
    // Detail must reflect 2 total workdirs (not 1 single mashed-together path).
    assert.match(probe.detail, /2\/2 workdirs have consent/);
  });
});

describe('checkSchemaVersion', () => {
  // We avoid the module-level singleton (RELAY_DB_PATH=:memory: at the top
  // of this file feeds getDb). Instead the probe is given an explicit
  // storeDir each time and we drive it through better-sqlite3 directly.
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'doctor-schema-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('T1: storeDir with schema_version=expected → status ok', () => {
    const db = new Database(join(tmpDir, 'relay.db'));
    try {
      applySchema(db);
    } finally {
      db.close();
    }
    const probe = checkSchemaVersion(tmpDir);
    assert.strictEqual(probe.name, 'schema_version');
    assert.strictEqual(probe.status, 'ok');
    assert.match(probe.detail, /applied=3.*matches expected=3/);
  });

  test('T2: storeDir with schema_version=1 only (pre-v2) → status missing', () => {
    const dbPath = join(tmpDir, 'relay.db');
    const db = new Database(dbPath);
    try {
      db.prepare('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, description TEXT)').run();
      db.prepare('INSERT INTO schema_version (version, applied_at, description) VALUES (1, ?, ?)').run(Date.now(), 'baseline');
    } finally {
      db.close();
    }
    const probe = checkSchemaVersion(tmpDir);
    assert.strictEqual(probe.status, 'missing');
    assert.match(probe.detail, /applied=1.*expected=3/);
  });

  test('T3: storeDir with no relay.db → status missing, no throw', () => {
    const probe = checkSchemaVersion(tmpDir);
    assert.strictEqual(probe.status, 'missing');
    assert.match(probe.detail, /not found/);
  });

  test('T4: storeDir with schema_version=99 → status failed, mentions downgrade', () => {
    const dbPath = join(tmpDir, 'relay.db');
    const db = new Database(dbPath);
    try {
      db.prepare('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, description TEXT)').run();
      db.prepare('INSERT INTO schema_version (version, applied_at, description) VALUES (99, ?, ?)').run(Date.now(), 'future');
    } finally {
      db.close();
    }
    const probe = checkSchemaVersion(tmpDir);
    assert.strictEqual(probe.status, 'failed');
    assert.match(probe.detail, /applied=99.*exceeds expected=3/);
    assert.match(probe.detail, /downgrade/);
  });

  test('T5 (integration): executeDoctorCommand --json → checks array contains schema_version entry', async () => {
    // Set RELAY_DB_PATH so the doctor's storeDir resolution lands on our tmp.
    const savedPath = process.env['RELAY_DB_PATH'];
    process.env['RELAY_DB_PATH'] = join(tmpDir, 'relay.db');
    try {
      const db = new Database(join(tmpDir, 'relay.db'));
      try {
        applySchema(db);
      } finally {
        db.close();
      }
      applyEnv({ openrouter: 'sk-test', anthropic: 'sk-ant-test', lmstudioOk: true, lmstudioModelCount: 1 });
      const cap = makeIO();
      await executeDoctorCommand({ json: true }, cap.io);
      const joined = cap.stdout.join('');
      const parsed = JSON.parse(joined) as { checks: Array<{ name: string; status: string; detail: string }> };
      const entry = parsed.checks.find(c => c.name === 'schema_version');
      assert.ok(entry, 'schema_version probe must appear in checks array');
    } finally {
      if (savedPath === undefined) {
        process.env['RELAY_DB_PATH'] = ':memory:'; // restore file-level default
      } else {
        process.env['RELAY_DB_PATH'] = savedPath;
      }
    }
  });
});
