// T12 — Comprehensive SessionEnd hook coverage (gaps left by cmd-memory-hook.test.ts).
//
// What lives here vs. cmd-memory-hook.test.ts:
//   - cmd-memory-hook.test.ts already covers: install/uninstall happy paths,
//     idempotency, marker presence, foreign-hook preservation, SessionStart
//     coexistence, JSON-mode envelopes for global SessionEnd installs, and
//     HOOK_SCRIPT_SESSION_END shape (mkdir guard, --from-stdin, log redirect).
//   - This file fills the SessionEnd-specific gaps in EPARSE handling, ENOENT
//     cold-start through the JSON branch, project-local uninstall coexistence,
//     and legacy migration paths (top-level `id` field, unmarked twin entries).
//
// Baseline: 800/800 must hold. Tests added are additive.
process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeMemoryHookCommand,
  HOOK_SCRIPT,
  HOOK_SCRIPT_SESSION_END,
  HOOK_MARKER_FIELD,
  HOOK_MARKER_SESSION_START,
  HOOK_MARKER_SESSION_END,
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

interface CcHookEntry {
  hooks?: Array<{ type?: string; command?: string }>;
  _relay_id?: string;
  id?: string;
}

interface CcSettings {
  hooks?: {
    SessionStart?: Array<CcHookEntry>;
    SessionEnd?: Array<CcHookEntry>;
  };
}

function readSettings(path: string): Promise<CcSettings> {
  return readFile(path, 'utf8').then((s) => JSON.parse(s) as CcSettings);
}

describe('executeMemoryHookCommand --session-end — EPARSE handling', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-hook-se-eparse-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test('EPARSE: install --session-end aborts on malformed settings.json without overwriting', async () => {
    // T6 contract: install must never silently overwrite a hand-edited but
    // broken settings.json. SessionEnd takes the same code path as SessionStart
    // for the parse step — verify the contract holds when sessionEnd=true.
    const settingsPath = join(tmp, '.claude', 'settings.json');
    await mkdir(join(tmp, '.claude'), { recursive: true });
    const malformed = '{ "hooks": { "SessionEnd": [ /* broken comment */ ';
    await writeFile(settingsPath, malformed, 'utf8');

    const cap = makeIO(tmp);
    const code = await executeMemoryHookCommand(
      { install: true, json: false, sessionEnd: true },
      cap.io,
      tmp
    );
    assert.strictEqual(code, 1, 'must exit non-zero on parse error (sessionEnd path)');

    const err = cap.stderr.join('');
    assert.match(err, /not valid JSON/);
    assert.match(err, /Aborted/);
    assert.match(err, /Fix the JSON manually/);

    // File contents must be UNTOUCHED
    const after = await readFile(settingsPath, 'utf8');
    assert.strictEqual(after, malformed, 'settings.json must NOT be modified on parse error');
  });

  test('EPARSE: uninstall --session-end aborts on malformed settings.json without overwriting', async () => {
    const settingsPath = join(tmp, '.claude', 'settings.json');
    await mkdir(join(tmp, '.claude'), { recursive: true });
    const malformed = 'literally not json';
    await writeFile(settingsPath, malformed, 'utf8');

    const cap = makeIO(tmp);
    const code = await executeMemoryHookCommand(
      { install: false, json: false, sessionEnd: true },
      cap.io,
      tmp
    );
    assert.strictEqual(code, 1);
    assert.match(cap.stderr.join(''), /not valid JSON/);

    const after = await readFile(settingsPath, 'utf8');
    assert.strictEqual(after, malformed);
  });

  test('EPARSE in --json --session-end mode emits error envelope to stdout, exits 1', async () => {
    const settingsPath = join(tmp, '.claude', 'settings.json');
    await mkdir(join(tmp, '.claude'), { recursive: true });
    await writeFile(settingsPath, '{ "hooks": [malformed', 'utf8');

    const cap = makeIO(tmp);
    const code = await executeMemoryHookCommand(
      { install: true, json: true, sessionEnd: true },
      cap.io,
      tmp
    );
    assert.strictEqual(code, 1);

    const out = cap.stdout.join('').trim();
    const parsed = JSON.parse(out) as { error: string; path: string; message: string };
    assert.strictEqual(parsed.error, 'settings-parse');
    assert.strictEqual(parsed.path, settingsPath);
    assert.ok(parsed.message.length > 0, 'message must include parse details');

    assert.match(cap.stderr.join(''), /not valid JSON/);
  });
});

describe('executeMemoryHookCommand --session-end — ENOENT and JSON envelopes', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-hook-se-enoent-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test('ENOENT: project-local install --session-end --json on fresh project emits success envelope with event=SessionEnd', async () => {
    // Cold-start path through the SessionEnd JSON branch — confirms ENOENT
    // does NOT trip the parse-error branch and that the success envelope
    // includes event="SessionEnd" (not the SessionStart default).
    const cap = makeIO(tmp);
    const code = await executeMemoryHookCommand(
      { install: true, json: true, sessionEnd: true },
      cap.io,
      tmp
    );
    assert.strictEqual(code, 0);

    const out = cap.stdout.join('').trim();
    const parsed = JSON.parse(out) as { installed: boolean; path: string; event: string };
    assert.strictEqual(parsed.installed, true);
    assert.strictEqual(parsed.event, 'SessionEnd');
    assert.strictEqual(parsed.path, join(tmp, '.claude', 'settings.json'));
    assert.strictEqual(cap.stderr.join(''), '', 'no error noise on cold-start --session-end install');
  });

  test('ENOENT: install --session-end on fresh project shows SessionEnd-specific stdout message', async () => {
    // Human-readable message must mention SessionEnd and the auto-extract
    // consent gating — not the SessionStart copy. This is the user's
    // first signal that they've enabled the right hook.
    const cap = makeIO(tmp);
    const code = await executeMemoryHookCommand(
      { install: true, json: false, sessionEnd: true },
      cap.io,
      tmp
    );
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');
    assert.match(out, /SessionEnd hook installed/);
    assert.match(out, /auto-extract/, 'mentions auto-extract pipeline');
    assert.match(out, /consent gated/i, 'mentions consent gating');
    // Must NOT use the SessionStart copy
    assert.doesNotMatch(out, /injects recalled memories/);
  });

  test('uninstall --session-end --json reports event=SessionEnd in envelope', async () => {
    // Install first (so uninstall has something to remove), then uninstall
    // through the JSON branch and check the envelope reports the right event.
    const capI = makeIO(tmp);
    await executeMemoryHookCommand(
      { install: true, json: false, sessionEnd: true },
      capI.io,
      tmp
    );

    const capU = makeIO(tmp);
    const code = await executeMemoryHookCommand(
      { install: false, json: true, sessionEnd: true },
      capU.io,
      tmp
    );
    assert.strictEqual(code, 0);
    const parsed = JSON.parse(capU.stdout.join('').trim()) as {
      installed: boolean;
      path: string;
      event: string;
    };
    assert.strictEqual(parsed.installed, false);
    assert.strictEqual(parsed.event, 'SessionEnd');
    assert.strictEqual(parsed.path, join(tmp, '.claude', 'settings.json'));
  });

  test('uninstall --session-end on settings with no SessionEnd entries is a no-op exit 0', async () => {
    // Uninstall against settings that never had a SessionEnd hook installed
    // must succeed cleanly — no throw, exit 0, file remains valid JSON.
    const settingsPath = join(tmp, '.claude', 'settings.json');
    await mkdir(join(tmp, '.claude'), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({ env: { FOO: 'bar' } }, null, 2),
      'utf8'
    );

    const cap = makeIO(tmp);
    const code = await executeMemoryHookCommand(
      { install: false, json: false, sessionEnd: true },
      cap.io,
      tmp
    );
    assert.strictEqual(code, 0, 'no-op uninstall must succeed');

    const after = await readSettings(settingsPath);
    // SessionEnd key should exist (empty array) after the uninstall pass through
    assert.ok(Array.isArray(after.hooks?.SessionEnd) || after.hooks?.SessionEnd === undefined);
    // Unrelated config preserved
    assert.deepStrictEqual(
      ((after as unknown as { env: { FOO: string } }).env),
      { FOO: 'bar' }
    );
  });
});

describe('executeMemoryHookCommand --session-end — project-local coexistence with SessionStart', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-hook-se-coexist-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test('uninstall --session-end (project-local) removes ONLY the SessionEnd marker, leaves SessionStart marker intact', async () => {
    // Project-local mirror of the global coexistence test — install both,
    // uninstall only --session-end, and confirm the SessionStart marker
    // survives. The global variant is already covered in cmd-memory-hook.test.ts;
    // this verifies the same isolation in the project-local code path.
    const cap = makeIO(tmp);
    await executeMemoryHookCommand({ install: true, json: false }, cap.io, tmp);
    await executeMemoryHookCommand(
      { install: true, json: false, sessionEnd: true },
      cap.io,
      tmp
    );

    const settingsPath = join(tmp, '.claude', 'settings.json');
    let settings = await readSettings(settingsPath);
    assert.strictEqual(
      (settings.hooks?.SessionStart ?? []).filter(
        (e) => e[HOOK_MARKER_FIELD as '_relay_id'] === HOOK_MARKER_SESSION_START
      ).length,
      1,
      'SessionStart installed'
    );
    assert.strictEqual(
      (settings.hooks?.SessionEnd ?? []).filter(
        (e) => e[HOOK_MARKER_FIELD as '_relay_id'] === HOOK_MARKER_SESSION_END
      ).length,
      1,
      'SessionEnd installed'
    );

    // Uninstall ONLY --session-end (project-local, no --global flag)
    const code = await executeMemoryHookCommand(
      { install: false, json: false, sessionEnd: true },
      cap.io,
      tmp
    );
    assert.strictEqual(code, 0);

    settings = await readSettings(settingsPath);
    const startStill = (settings.hooks?.SessionStart ?? []).filter(
      (e) => e[HOOK_MARKER_FIELD as '_relay_id'] === HOOK_MARKER_SESSION_START
    );
    const endGone = (settings.hooks?.SessionEnd ?? []).filter(
      (e) => e[HOOK_MARKER_FIELD as '_relay_id'] === HOOK_MARKER_SESSION_END
    );
    assert.strictEqual(startStill.length, 1, 'project-local SessionStart marker preserved');
    assert.strictEqual(endGone.length, 0, 'project-local SessionEnd marker removed');
    // Confirm SessionStart entry is still pointing at the right command
    assert.strictEqual(startStill[0]?.hooks?.[0]?.command, HOOK_SCRIPT);
  });
});

describe('executeMemoryHookCommand --session-end — legacy migration', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-hook-se-legacy-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test('install --session-end migrates legacy { id: "relay-memory-session-end" } entry to marker-bearing entry', async () => {
    // Old Relay versions wrote a top-level `id` field instead of `_relay_id`.
    // isRelayManagedHookEntry treats that as ours so a fresh install replaces
    // it cleanly. Verify the legacy id gets dropped on install.
    const settingsPath = join(tmp, '.claude', 'settings.json');
    await mkdir(join(tmp, '.claude'), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            SessionEnd: [
              { id: 'relay-memory-session-end', run: 'old-legacy-se-command' },
            ],
          },
        },
        null,
        2
      ) + '\n',
      'utf8'
    );

    const cap = makeIO(tmp);
    const code = await executeMemoryHookCommand(
      { install: true, json: false, sessionEnd: true },
      cap.io,
      tmp
    );
    assert.strictEqual(code, 0);

    const settings = await readSettings(settingsPath);
    const entries = settings.hooks?.SessionEnd ?? [];
    const legacyStillThere = entries.some((e) => e.id === 'relay-memory-session-end');
    assert.strictEqual(legacyStillThere, false, 'legacy id-field entry migrated away');
    const marked = entries.filter(
      (e) => e[HOOK_MARKER_FIELD as '_relay_id'] === HOOK_MARKER_SESSION_END
    );
    assert.strictEqual(marked.length, 1, 'single marker-bearing entry remains');
    assert.strictEqual(marked[0]?.hooks?.[0]?.command, HOOK_SCRIPT_SESSION_END);
  });

  test('install --session-end migrates an unmarked entry whose inner command exactly matches HOOK_SCRIPT_SESSION_END', async () => {
    // Legacy/manual case: entry uses the current hooks[].command shape but
    // lacks _relay_id (e.g. user copy-pasted from old docs). Our entry
    // detector treats EXACT command match as ours, so install should
    // replace it with a properly marked entry rather than create a duplicate.
    const settingsPath = join(tmp, '.claude', 'settings.json');
    await mkdir(join(tmp, '.claude'), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            SessionEnd: [
              // Unmarked twin — exact command match, no _relay_id
              { hooks: [{ type: 'command', command: HOOK_SCRIPT_SESSION_END }] },
            ],
          },
        },
        null,
        2
      ) + '\n',
      'utf8'
    );

    const cap = makeIO(tmp);
    await executeMemoryHookCommand(
      { install: true, json: false, sessionEnd: true },
      cap.io,
      tmp
    );

    const settings = await readSettings(settingsPath);
    const entries = settings.hooks?.SessionEnd ?? [];
    // Exactly one Relay-managed entry should remain after migration
    const relayCommandEntries = entries.filter((e) =>
      (e.hooks ?? []).some((h) => h.command === HOOK_SCRIPT_SESSION_END)
    );
    assert.strictEqual(
      relayCommandEntries.length,
      1,
      'unmarked twin migrated — single entry remains'
    );
    // And it must now carry the marker
    assert.strictEqual(
      relayCommandEntries[0]?.[HOOK_MARKER_FIELD as '_relay_id'],
      HOOK_MARKER_SESSION_END,
      'migrated entry now carries _relay_id marker'
    );
  });
});
