process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeMemoryHookCommand,
  HOOK_SCRIPT,
  HOOK_SCRIPT_SESSION_END,
} from './cmd-memory-ops.js';
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

// ============================================================================
// P1 fix (Codex finding #1): the installed hook command MUST short-circuit
// before invoking `relay context emit` / `relay memory auto-extract` when the
// pause sentinel is present. Without this gate, paused sessions still recall
// memories into context (SessionStart) and still auto-extract transcripts
// (SessionEnd) — the privacy off-switch is bypassed entirely.
//
// The gate is `relay pause --check ... && exit 0; <emit-or-extract>`.
// When paused, `relay pause --check` exits 0 → the script exits 0 with no
// downstream invocation. When active, it exits 1 → the chain falls through to
// the `;` separator and proceeds normally.
// ============================================================================
describe('HOOK_SCRIPT — pause sentinel gate (P1 privacy off-switch)', () => {
  test('SessionStart hook starts with `relay pause --check` short-circuit', () => {
    // The gate must precede `relay context emit` so the emit never runs when paused.
    const pauseIdx = HOOK_SCRIPT.indexOf('relay pause --check');
    const emitIdx = HOOK_SCRIPT.indexOf('relay context emit');
    assert.ok(pauseIdx >= 0, 'must invoke `relay pause --check`');
    assert.ok(emitIdx > pauseIdx, 'pause check must come BEFORE relay context emit');
  });

  test('SessionStart hook passes `--workdir "${CLAUDE_PROJECT_DIR:-$PWD}"` to pause check', () => {
    // The pause check must be scoped to the same workdir the emit uses — otherwise
    // a project-local pause sentinel would be ignored on --global installs.
    const gateSection = HOOK_SCRIPT.split(';')[0] ?? '';
    assert.match(
      gateSection,
      /relay pause --check --workdir "\$\{CLAUDE_PROJECT_DIR:-\$PWD\}"/,
      'pause check must reuse the CLAUDE_PROJECT_DIR workdir resolution'
    );
  });

  test('SessionStart hook short-circuits with `&& exit 0` when paused', () => {
    // `&& exit 0` is the contract: paused → exit 0, never reach emit.
    const gateSection = HOOK_SCRIPT.split(';')[0] ?? '';
    assert.match(gateSection, /&& exit 0/, 'paused path must exit 0 before emit');
  });

  test('SessionEnd hook also includes the pause gate before auto-extract', () => {
    // Same privacy contract for SessionEnd — paused projects must not auto-extract.
    const pauseIdx = HOOK_SCRIPT_SESSION_END.indexOf('relay pause --check');
    const extractIdx = HOOK_SCRIPT_SESSION_END.indexOf('relay memory auto-extract');
    const mkdirIdx = HOOK_SCRIPT_SESSION_END.indexOf('mkdir -p');
    assert.ok(pauseIdx >= 0, 'SessionEnd must invoke `relay pause --check`');
    assert.ok(extractIdx > pauseIdx, 'pause check must precede auto-extract');
    assert.ok(mkdirIdx > pauseIdx, 'pause check must precede mkdir (no side effects when paused)');
  });

  test('SessionEnd pause gate also uses `&& exit 0` semantics', () => {
    const gateSection = HOOK_SCRIPT_SESSION_END.split(';')[0] ?? '';
    assert.match(gateSection, /relay pause --check/);
    assert.match(gateSection, /&& exit 0/);
  });

  test('installed SessionStart hook string carries the pause gate end-to-end', async () => {
    // Behavioral check: the command CC actually executes (read from settings.json
    // after install) must contain the pause gate. This is the regression test
    // for the original bug — pre-fix this string was just the emit invocation.
    const tmp = await mkdtemp(join(tmpdir(), 'relay-hook-pausegate-'));
    try {
      const cap = makeIO(tmp);
      await executeMemoryHookCommand({ install: true, json: false }, cap.io, tmp);
      const settingsPath = join(tmp, '.claude', 'settings.json');
      const raw = await readFile(settingsPath, 'utf8');
      const parsed = JSON.parse(raw) as {
        hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
      };
      const installedCmd = parsed.hooks.SessionStart[0]?.hooks[0]?.command ?? '';
      assert.match(installedCmd, /relay pause --check/, 'installed hook must contain pause gate');
      assert.match(installedCmd, /&& exit 0/, 'installed hook must short-circuit on pause');
      // The pause gate must precede the emit (paused → never emit)
      assert.ok(
        installedCmd.indexOf('relay pause --check') < installedCmd.indexOf('relay context emit'),
        'pause gate must run BEFORE emit'
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

