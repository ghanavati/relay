process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach, afterEach, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  executePauseCommand,
  executeResumeCommand,
  executePauseCheckCommand,
  isPaused,
  SENTINEL_FILENAME,
} from './cmd-pause.js';
import type { CliIO } from './commands.js';

/**
 * NOTE: cmd-pause.ts uses `homedir()` lazily inside helpers, BUT we still cannot
 * safely write the global sentinel during tests because the parent agent's real
 * `~/.relay/paused` would be clobbered. We back up + restore the real global
 * sentinel around every test that writes one.
 *
 * Workdir-scoped tests use a tmp dir and never touch the user's home.
 */

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

async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

const REAL_GLOBAL_SENTINEL = join(homedir(), '.relay', SENTINEL_FILENAME);
let realGlobalBackup: string | null = null;
let realGlobalExisted = false;

describe('cmd-pause', () => {
  let tmp: string;

  before(async () => {
    realGlobalExisted = await fileExists(REAL_GLOBAL_SENTINEL);
    if (realGlobalExisted) {
      realGlobalBackup = await readFile(REAL_GLOBAL_SENTINEL, 'utf8');
    }
  });

  after(async () => {
    // Restore (or remove if it didn't exist before tests)
    if (realGlobalExisted && realGlobalBackup !== null) {
      await mkdir(join(homedir(), '.relay'), { recursive: true });
      await writeFile(REAL_GLOBAL_SENTINEL, realGlobalBackup, 'utf8');
    } else if (await fileExists(REAL_GLOBAL_SENTINEL)) {
      await rm(REAL_GLOBAL_SENTINEL, { force: true });
    }
  });

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-pause-'));
    // Ensure clean global sentinel slate per test
    if (await fileExists(REAL_GLOBAL_SENTINEL)) {
      await rm(REAL_GLOBAL_SENTINEL, { force: true });
    }
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    // Always remove any global sentinel a test created — restore happens in `after`
    if (await fileExists(REAL_GLOBAL_SENTINEL)) {
      await rm(REAL_GLOBAL_SENTINEL, { force: true });
    }
  });

  test('pause --workdir writes sentinel JSON with no expiry', async () => {
    const cap = makeIO(tmp);
    const code = await executePauseCommand({ workdir: tmp, json: false }, cap.io);
    assert.strictEqual(code, 0);
    const sentinelPath = join(tmp, '.relay', SENTINEL_FILENAME);
    const raw = await readFile(sentinelPath, 'utf8');
    const parsed = JSON.parse(raw) as {
      paused_at: number;
      expires_at: number | null;
      scope: string;
      workdir?: string;
    };
    assert.strictEqual(parsed.expires_at, null);
    assert.strictEqual(parsed.scope, 'workdir');
    assert.strictEqual(parsed.workdir, tmp);
    assert.ok(parsed.paused_at > 0, 'paused_at must be a positive timestamp');
  });

  test('pause --minutes 5 --workdir sets expires_at to now+5m (within tolerance)', async () => {
    const cap = makeIO(tmp);
    const before = Date.now();
    const code = await executePauseCommand({ minutes: 5, workdir: tmp, json: true }, cap.io);
    const after = Date.now();
    assert.strictEqual(code, 0);
    const sentinelPath = join(tmp, '.relay', SENTINEL_FILENAME);
    const parsed = JSON.parse(await readFile(sentinelPath, 'utf8')) as {
      paused_at: number;
      expires_at: number | null;
    };
    assert.ok(parsed.expires_at !== null, 'expires_at must be non-null when minutes set');
    const expected_min = before + 5 * 60_000;
    const expected_max = after + 5 * 60_000;
    assert.ok(
      parsed.expires_at! >= expected_min && parsed.expires_at! <= expected_max,
      `expires_at ${parsed.expires_at} not in [${expected_min}, ${expected_max}]`
    );

    // JSON output sanity
    const lastLine = cap.stdout.join('').trim().split('\n').pop()!;
    const stdoutJson = JSON.parse(lastLine) as { paused: boolean; sentinel: string };
    assert.strictEqual(stdoutJson.paused, true);
    assert.ok(stdoutJson.sentinel.endsWith(join('.relay', SENTINEL_FILENAME)));
  });

  test('isPaused returns true while sentinel valid, false after expiry', async () => {
    const cap = makeIO(tmp);
    await executePauseCommand({ minutes: 1, workdir: tmp, json: false }, cap.io);

    // "Now" before expiry → paused
    assert.strictEqual(await isPaused(tmp, Date.now()), true);
    // "Now" simulated 2 minutes in the future → expired, not paused
    assert.strictEqual(await isPaused(tmp, Date.now() + 2 * 60_000), false);
  });

  test('isPaused returns false when no sentinel present', async () => {
    assert.strictEqual(await isPaused(tmp), false);
    assert.strictEqual(await isPaused(undefined), false);
  });

  test('resume removes the sentinel and is idempotent', async () => {
    const cap1 = makeIO(tmp);
    await executePauseCommand({ workdir: tmp, json: false }, cap1.io);
    const sentinelPath = join(tmp, '.relay', SENTINEL_FILENAME);
    assert.strictEqual(await fileExists(sentinelPath), true);

    const cap2 = makeIO(tmp);
    const code = await executeResumeCommand({ workdir: tmp, json: false }, cap2.io);
    assert.strictEqual(code, 0);
    assert.strictEqual(await fileExists(sentinelPath), false);
    assert.match(cap2.stdout.join(''), /resumed/);

    // Idempotent: second resume still returns 0, prints "was not paused"
    const cap3 = makeIO(tmp);
    const code2 = await executeResumeCommand({ workdir: tmp, json: false }, cap3.io);
    assert.strictEqual(code2, 0);
    assert.match(cap3.stdout.join(''), /not paused/);
  });

  test('resume --json reports removed flag', async () => {
    const cap1 = makeIO(tmp);
    await executePauseCommand({ workdir: tmp, json: false }, cap1.io);

    const cap2 = makeIO(tmp);
    await executeResumeCommand({ workdir: tmp, json: true }, cap2.io);
    const lastLine = cap2.stdout.join('').trim().split('\n').pop()!;
    const parsed = JSON.parse(lastLine) as { paused: boolean; removed: boolean };
    assert.strictEqual(parsed.paused, false);
    assert.strictEqual(parsed.removed, true);

    const cap3 = makeIO(tmp);
    await executeResumeCommand({ workdir: tmp, json: true }, cap3.io);
    const lastLine3 = cap3.stdout.join('').trim().split('\n').pop()!;
    const parsed3 = JSON.parse(lastLine3) as { removed: boolean };
    assert.strictEqual(parsed3.removed, false);
  });

  test('pause --check exits 0 when paused, 1 when not (workdir scope)', async () => {
    // Not paused → 1
    const code1 = await executePauseCheckCommand({ workdir: tmp });
    assert.strictEqual(code1, 1);

    // Paused → 0
    const cap = makeIO(tmp);
    await executePauseCommand({ workdir: tmp, json: false }, cap.io);
    const code2 = await executePauseCheckCommand({ workdir: tmp });
    assert.strictEqual(code2, 0);

    // Resumed → 1 again
    const cap2 = makeIO(tmp);
    await executeResumeCommand({ workdir: tmp, json: false }, cap2.io);
    const code3 = await executePauseCheckCommand({ workdir: tmp });
    assert.strictEqual(code3, 1);
  });

  test('global pause overrides workdir check (no workdir sentinel needed)', async () => {
    // Write a global sentinel with no expiry
    await mkdir(join(homedir(), '.relay'), { recursive: true });
    await writeFile(
      REAL_GLOBAL_SENTINEL,
      JSON.stringify({ paused_at: Date.now(), expires_at: null, scope: 'global' }) + '\n',
      'utf8'
    );

    // isPaused with a workdir still returns true because global trumps
    assert.strictEqual(await isPaused(tmp), true);
    // Without workdir, also true
    assert.strictEqual(await isPaused(undefined), true);

    // Cleanup happens in afterEach
  });

  test('expired global sentinel is treated as not paused', async () => {
    await mkdir(join(homedir(), '.relay'), { recursive: true });
    const expired = Date.now() - 60_000; // expired 1m ago
    await writeFile(
      REAL_GLOBAL_SENTINEL,
      JSON.stringify({ paused_at: expired - 60_000, expires_at: expired, scope: 'global' }) + '\n',
      'utf8'
    );
    assert.strictEqual(await isPaused(undefined), false);
  });

  test('malformed sentinel JSON is treated as not paused', async () => {
    const sentinelPath = join(tmp, '.relay', SENTINEL_FILENAME);
    await mkdir(join(tmp, '.relay'), { recursive: true });
    await writeFile(sentinelPath, 'not-json{garbage', 'utf8');
    assert.strictEqual(await isPaused(tmp), false);
  });

  test('pause without --workdir defaults to global (writes ~/.relay/paused)', async () => {
    const cap = makeIO(tmp);
    const code = await executePauseCommand({ json: false }, cap.io);
    assert.strictEqual(code, 0);
    assert.strictEqual(await fileExists(REAL_GLOBAL_SENTINEL), true);
    const parsed = JSON.parse(await readFile(REAL_GLOBAL_SENTINEL, 'utf8')) as { scope: string };
    assert.strictEqual(parsed.scope, 'global');

    // resume removes it
    const cap2 = makeIO(tmp);
    await executeResumeCommand({ json: false }, cap2.io);
    assert.strictEqual(await fileExists(REAL_GLOBAL_SENTINEL), false);
  });

  test('--minutes 0 treated as no-expiry (validation handled by cli.ts)', async () => {
    // The cli.ts dispatcher rejects minutes <= 0; this test confirms cmd-pause
    // itself treats undefined/0 minutes as "no expiry" (defensive).
    const cap = makeIO(tmp);
    await executePauseCommand({ minutes: 0, workdir: tmp, json: false }, cap.io);
    const parsed = JSON.parse(
      await readFile(join(tmp, '.relay', SENTINEL_FILENAME), 'utf8')
    ) as { expires_at: number | null };
    assert.strictEqual(parsed.expires_at, null);
  });
});
