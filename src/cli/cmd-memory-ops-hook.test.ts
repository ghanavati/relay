process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeMemoryHookCommand, HOOK_SCRIPT } from './cmd-memory-ops.js';
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

describe('executeMemoryHookCommand — ENOENT vs EPARSE on settings.json', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-memory-hook-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test('ENOENT: install creates fresh .claude/settings.json with hook entry', async () => {
    // No .claude/ directory exists at all — this is the cold-start case.
    const cap = makeIO(tmp);
    const code = await executeMemoryHookCommand(
      { install: true, json: false },
      cap.io,
      tmp
    );
    assert.strictEqual(code, 0);

    const settingsPath = join(tmp, '.claude', 'settings.json');
    const raw = await readFile(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    };
    assert.ok(Array.isArray(parsed.hooks.SessionStart));
    assert.strictEqual(parsed.hooks.SessionStart.length, 1);
    assert.strictEqual(parsed.hooks.SessionStart[0]?.hooks[0]?.command, HOOK_SCRIPT);
    assert.match(cap.stdout.join(''), /SessionStart hook installed/);
    assert.strictEqual(cap.stderr.join(''), '');
  });

  test('ENOENT: install with valid pre-existing settings.json adds hook idempotently', async () => {
    // settings.json exists and parses cleanly — the happy path.
    const settingsPath = join(tmp, '.claude', 'settings.json');
    await mkdir(join(tmp, '.claude'), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({ env: { FOO: 'bar' } }, null, 2),
      'utf8'
    );

    const cap = makeIO(tmp);
    const code = await executeMemoryHookCommand(
      { install: true, json: false },
      cap.io,
      tmp
    );
    assert.strictEqual(code, 0);

    const parsed = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      env: { FOO: string };
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    };
    // Existing config preserved
    assert.strictEqual(parsed.env.FOO, 'bar');
    // Hook installed
    assert.strictEqual(parsed.hooks.SessionStart[0]?.hooks[0]?.command, HOOK_SCRIPT);
  });

  test('EPARSE: malformed JSON aborts install with non-zero exit and stderr message', async () => {
    // User hand-edited settings.json and left it broken. We MUST NOT overwrite.
    const settingsPath = join(tmp, '.claude', 'settings.json');
    await mkdir(join(tmp, '.claude'), { recursive: true });
    const malformed = '{ "hooks": { "SessionStart": [  // trailing comma + comment, broken\n';
    await writeFile(settingsPath, malformed, 'utf8');

    const cap = makeIO(tmp);
    const code = await executeMemoryHookCommand(
      { install: true, json: false },
      cap.io,
      tmp
    );
    assert.strictEqual(code, 1, 'must exit non-zero on parse error');

    const err = cap.stderr.join('');
    assert.match(err, /not valid JSON/);
    assert.match(err, /Aborted/);
    assert.match(err, /Fix the JSON manually/);

    // CRITICAL: file content must be UNTOUCHED — we must not overwrite the user's broken-but-real work.
    const after = await readFile(settingsPath, 'utf8');
    assert.strictEqual(after, malformed, 'settings.json must NOT be modified on parse error');
  });

  test('EPARSE: malformed JSON aborts uninstall with non-zero exit and stderr message', async () => {
    // Same protection on the uninstall path.
    const settingsPath = join(tmp, '.claude', 'settings.json');
    await mkdir(join(tmp, '.claude'), { recursive: true });
    const malformed = 'not json at all just words';
    await writeFile(settingsPath, malformed, 'utf8');

    const cap = makeIO(tmp);
    const code = await executeMemoryHookCommand(
      { install: false, json: false },
      cap.io,
      tmp
    );
    assert.strictEqual(code, 1);
    assert.match(cap.stderr.join(''), /not valid JSON/);

    // File content must be untouched
    const after = await readFile(settingsPath, 'utf8');
    assert.strictEqual(after, malformed);
  });

  test('EPARSE in --json mode emits error envelope to stdout AND stderr message, exits 1', async () => {
    const settingsPath = join(tmp, '.claude', 'settings.json');
    await mkdir(join(tmp, '.claude'), { recursive: true });
    await writeFile(settingsPath, '{ "hooks": [', 'utf8');

    const cap = makeIO(tmp);
    const code = await executeMemoryHookCommand(
      { install: true, json: true },
      cap.io,
      tmp
    );
    assert.strictEqual(code, 1);

    const out = cap.stdout.join('').trim();
    const parsed = JSON.parse(out) as { error: string; path: string; message: string };
    assert.strictEqual(parsed.error, 'settings-parse');
    assert.strictEqual(parsed.path, settingsPath);
    assert.ok(parsed.message.length > 0, 'message must include parse details');

    // stderr still gets the human-readable warning
    assert.match(cap.stderr.join(''), /not valid JSON/);
  });

  test('ENOENT: install --json mode on fresh project emits success envelope', async () => {
    // Cold-start path through the JSON output branch — confirms ENOENT reads
    // an empty settings dict and reaches the install-success branch instead of
    // the parse-error branch.
    const cap = makeIO(tmp);
    const code = await executeMemoryHookCommand(
      { install: true, json: true },
      cap.io,
      tmp
    );
    assert.strictEqual(code, 0);

    const out = cap.stdout.join('').trim();
    const parsed = JSON.parse(out) as { installed: boolean; path: string };
    assert.strictEqual(parsed.installed, true);
    assert.strictEqual(parsed.path, join(tmp, '.claude', 'settings.json'));
    assert.strictEqual(cap.stderr.join(''), '', 'no error noise on cold-start install');
  });
});
