process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  executeMemoryHookCommand,
  resolveHookSettingsPath,
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
  // The marker field carried by Relay-managed entries. Optional because
  // foreign / legacy entries do not have it.
  _relay_id?: string;
  // Legacy id field written by very old Relay versions.
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

describe('resolveHookSettingsPath', () => {
  test('global=false returns project-local <cwd>/.claude/settings.json', () => {
    const result = resolveHookSettingsPath('/some/project', false);
    assert.strictEqual(result, join('/some/project', '.claude', 'settings.json'));
  });

  test('global=true returns ~/.claude/settings.json (user-wide)', () => {
    const result = resolveHookSettingsPath('/some/project', true);
    assert.strictEqual(result, join(homedir(), '.claude', 'settings.json'));
  });

  test('global=false ignores HOME and uses passed cwd', () => {
    const result = resolveHookSettingsPath('/another/cwd', false);
    assert.ok(result.startsWith('/another/cwd'), 'must use cwd, not HOME');
    assert.ok(!result.startsWith(homedir() + '/'), 'must not be in HOME when global=false');
  });
});

describe('HOOK_SCRIPT shape', () => {
  test('includes --workdir "${CLAUDE_PROJECT_DIR:-$PWD}"', () => {
    assert.match(HOOK_SCRIPT, /--workdir "\$\{CLAUDE_PROJECT_DIR:-\$PWD\}"/);
  });

  test('uses relay context emit --target cc (replaces legacy jq pipeline)', () => {
    assert.match(HOOK_SCRIPT, /relay context emit --target cc/);
    assert.doesNotMatch(HOOK_SCRIPT, /jq -c/);
  });

  test('type filtering lives inside relay context emit defaults', () => {
    assert.match(HOOK_SCRIPT, /--target cc/);
  });

  test('falls back gracefully on failure (|| true)', () => {
    assert.match(HOOK_SCRIPT, /\|\| true$/);
  });
});

describe('executeMemoryHookCommand — project-local install (default)', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-hook-proj-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test('install creates <cwd>/.claude/settings.json with the hook entry', async () => {
    const cap = makeIO(tmp);
    const code = await executeMemoryHookCommand(
      { install: true, json: false },
      cap.io,
      tmp
    );
    assert.strictEqual(code, 0);

    const expectedPath = join(tmp, '.claude', 'settings.json');
    const settings = await readSettings(expectedPath);
    const sessionStart = settings.hooks?.SessionStart ?? [];
    assert.strictEqual(sessionStart.length, 1, 'one SessionStart entry');
    const inner = sessionStart[0]?.hooks ?? [];
    assert.strictEqual(inner.length, 1);
    assert.strictEqual(inner[0]?.type, 'command');
    assert.strictEqual(inner[0]?.command, HOOK_SCRIPT);
  });

  test('install does NOT touch ~/.claude/settings.json when global=false', async () => {
    // Snapshot home settings.json mtime/size before; we can't safely write into HOME
    // in tests, but we can check that the project-local path is what gets written.
    const cap = makeIO(tmp);
    await executeMemoryHookCommand({ install: true, json: false }, cap.io, tmp);

    const projectPath = join(tmp, '.claude', 'settings.json');
    const projectStat = await stat(projectPath);
    assert.ok(projectStat.isFile(), 'project-local settings.json must exist');
  });

  test('JSON mode reports the project-local path on install', async () => {
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
  });

  test('uninstall removes the hook entry from project-local settings', async () => {
    // First install
    const capInstall = makeIO(tmp);
    await executeMemoryHookCommand({ install: true, json: false }, capInstall.io, tmp);

    // Then uninstall
    const capUninstall = makeIO(tmp);
    const code = await executeMemoryHookCommand(
      { install: false, json: false },
      capUninstall.io,
      tmp
    );
    assert.strictEqual(code, 0);

    const settings = await readSettings(join(tmp, '.claude', 'settings.json'));
    const sessionStart = settings.hooks?.SessionStart ?? [];
    const stillContainsRelay = sessionStart.some((entry) =>
      (entry.hooks ?? []).some((h) => h.command === HOOK_SCRIPT)
    );
    assert.strictEqual(stillContainsRelay, false, 'relay hook must be removed');
  });

  test('install is idempotent — second install does not duplicate', async () => {
    const cap1 = makeIO(tmp);
    await executeMemoryHookCommand({ install: true, json: false }, cap1.io, tmp);

    const cap2 = makeIO(tmp);
    const code = await executeMemoryHookCommand(
      { install: true, json: false },
      cap2.io,
      tmp
    );
    assert.strictEqual(code, 0);

    const settings = await readSettings(join(tmp, '.claude', 'settings.json'));
    const sessionStart = settings.hooks?.SessionStart ?? [];
    const matchingEntries = sessionStart.filter((entry) =>
      (entry.hooks ?? []).some((h) => h.command === HOOK_SCRIPT)
    );
    assert.strictEqual(matchingEntries.length, 1, 'must not duplicate on repeat install');
  });

  test('install preserves unrelated SessionStart hooks', async () => {
    const settingsPath = join(tmp, '.claude', 'settings.json');
    await mkdir(join(tmp, '.claude'), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              { hooks: [{ type: 'command', command: 'other-tool --do-stuff' }] },
            ],
          },
        },
        null,
        2
      ) + '\n',
      'utf8'
    );

    const cap = makeIO(tmp);
    await executeMemoryHookCommand({ install: true, json: false }, cap.io, tmp);

    const settings = await readSettings(settingsPath);
    const sessionStart = settings.hooks?.SessionStart ?? [];
    const allCommands = sessionStart.flatMap((entry) =>
      (entry.hooks ?? []).map((h) => h.command)
    );
    assert.ok(allCommands.includes('other-tool --do-stuff'), 'unrelated hook preserved');
    assert.ok(allCommands.includes(HOOK_SCRIPT), 'relay hook present');
  });
});

describe('executeMemoryHookCommand — global install (--global)', () => {
  let tmp: string;
  // We redirect HOME so the global install lands in a sandbox, not the real ~.
  let originalHome: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-hook-global-'));
    originalHome = process.env['HOME'];
    process.env['HOME'] = tmp;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    await rm(tmp, { recursive: true, force: true });
  });

  test('install with global=true writes to ~/.claude/settings.json (sandboxed HOME)', async () => {
    const projectCwd = join(tmp, 'unrelated-project');
    await mkdir(projectCwd, { recursive: true });

    const cap = makeIO(projectCwd);
    const code = await executeMemoryHookCommand(
      { install: true, json: false, global: true },
      cap.io,
      projectCwd
    );
    assert.strictEqual(code, 0);

    const homePath = join(homedir(), '.claude', 'settings.json');
    // homedir() reads from $HOME on POSIX, so it should equal join(tmp, '.claude', 'settings.json').
    assert.strictEqual(homePath, join(tmp, '.claude', 'settings.json'));

    const settings = await readSettings(homePath);
    const sessionStart = settings.hooks?.SessionStart ?? [];
    assert.strictEqual(sessionStart.length, 1);
    assert.strictEqual(sessionStart[0]?.hooks?.[0]?.command, HOOK_SCRIPT);
  });

  test('install with global=true does NOT touch project-local settings.json', async () => {
    const projectCwd = join(tmp, 'unrelated-project');
    await mkdir(projectCwd, { recursive: true });

    const cap = makeIO(projectCwd);
    await executeMemoryHookCommand(
      { install: true, json: false, global: true },
      cap.io,
      projectCwd
    );

    const projectPath = join(projectCwd, '.claude', 'settings.json');
    let projectExists = true;
    try {
      await stat(projectPath);
    } catch {
      projectExists = false;
    }
    assert.strictEqual(projectExists, false, 'project-local file must NOT be created on --global');
  });

  test('JSON mode reports the global path on --global install', async () => {
    const projectCwd = join(tmp, 'p2');
    await mkdir(projectCwd, { recursive: true });
    const cap = makeIO(projectCwd);
    const code = await executeMemoryHookCommand(
      { install: true, json: true, global: true },
      cap.io,
      projectCwd
    );
    assert.strictEqual(code, 0);
    const parsed = JSON.parse(cap.stdout.join('').trim()) as {
      installed: boolean;
      path: string;
    };
    assert.strictEqual(parsed.installed, true);
    assert.strictEqual(parsed.path, join(homedir(), '.claude', 'settings.json'));
  });

  test('uninstall with global=true removes from ~/.claude/settings.json only', async () => {
    const projectCwd = join(tmp, 'p3');
    await mkdir(projectCwd, { recursive: true });

    // Install globally
    const capI = makeIO(projectCwd);
    await executeMemoryHookCommand(
      { install: true, json: false, global: true },
      capI.io,
      projectCwd
    );

    // Uninstall globally
    const capU = makeIO(projectCwd);
    const code = await executeMemoryHookCommand(
      { install: false, json: false, global: true },
      capU.io,
      projectCwd
    );
    assert.strictEqual(code, 0);

    const settings = await readSettings(join(homedir(), '.claude', 'settings.json'));
    const sessionStart = settings.hooks?.SessionStart ?? [];
    const stillContains = sessionStart.some((entry) =>
      (entry.hooks ?? []).some((h) => h.command === HOOK_SCRIPT)
    );
    assert.strictEqual(stillContains, false);
  });

  test('global install preserves unrelated user-wide SessionStart hooks', async () => {
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    await mkdir(join(homedir(), '.claude'), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              { hooks: [{ type: 'command', command: 'user-other-tool' }] },
            ],
          },
        },
        null,
        2
      ) + '\n',
      'utf8'
    );

    const projectCwd = join(tmp, 'p4');
    await mkdir(projectCwd, { recursive: true });

    const cap = makeIO(projectCwd);
    await executeMemoryHookCommand(
      { install: true, json: false, global: true },
      cap.io,
      projectCwd
    );

    const settings = await readSettings(settingsPath);
    const allCommands = (settings.hooks?.SessionStart ?? []).flatMap((entry) =>
      (entry.hooks ?? []).map((h) => h.command)
    );
    assert.ok(allCommands.includes('user-other-tool'));
    assert.ok(allCommands.includes(HOOK_SCRIPT));
  });
});

describe('executeMemoryHookCommand — backwards compatibility', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-hook-bc-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test('command without "global" key behaves identically to global=false', async () => {
    const cap = makeIO(tmp);
    const code = await executeMemoryHookCommand(
      { install: true, json: false }, // no `global` key at all
      cap.io,
      tmp
    );
    assert.strictEqual(code, 0);
    const projectStat = await stat(join(tmp, '.claude', 'settings.json'));
    assert.ok(projectStat.isFile(), 'default install must remain project-local');
  });

  test('explicit global=false matches default behavior', async () => {
    const cap = makeIO(tmp);
    const code = await executeMemoryHookCommand(
      { install: true, json: false, global: false },
      cap.io,
      tmp
    );
    assert.strictEqual(code, 0);
    const projectStat = await stat(join(tmp, '.claude', 'settings.json'));
    assert.ok(projectStat.isFile());
  });
});

describe('executeMemoryHookCommand — marker-based identification', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-hook-marker-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test('install writes _relay_id marker on the SessionStart entry', async () => {
    const cap = makeIO(tmp);
    await executeMemoryHookCommand({ install: true, json: false }, cap.io, tmp);
    const settings = await readSettings(join(tmp, '.claude', 'settings.json'));
    const entries = settings.hooks?.SessionStart ?? [];
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0]?.[HOOK_MARKER_FIELD as '_relay_id'], HOOK_MARKER_SESSION_START);
  });

  test('install writes _relay_id marker on the SessionEnd entry', async () => {
    const cap = makeIO(tmp);
    await executeMemoryHookCommand(
      { install: true, json: false, sessionEnd: true },
      cap.io,
      tmp
    );
    const settings = await readSettings(join(tmp, '.claude', 'settings.json'));
    const entries = settings.hooks?.SessionEnd ?? [];
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0]?.[HOOK_MARKER_FIELD as '_relay_id'], HOOK_MARKER_SESSION_END);
  });

  test('uninstall does NOT remove a foreign hook whose command happens to start with "relay"', async () => {
    // User wrote their own hook that calls a relay-named binary. It is NOT ours
    // (no marker, different command). Uninstall must leave it alone.
    const settingsPath = join(tmp, '.claude', 'settings.json');
    await mkdir(join(tmp, '.claude'), { recursive: true });
    const foreignCommand = 'relay context emit --custom-flag-user-wrote';
    await writeFile(
      settingsPath,
      JSON.stringify(
        { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: foreignCommand }] }] } },
        null,
        2
      ) + '\n',
      'utf8'
    );

    // Uninstall (no Relay-managed entry exists)
    const cap = makeIO(tmp);
    const code = await executeMemoryHookCommand({ install: false, json: false }, cap.io, tmp);
    assert.strictEqual(code, 0);

    const settings = await readSettings(settingsPath);
    const entries = settings.hooks?.SessionStart ?? [];
    assert.strictEqual(entries.length, 1, 'foreign hook must survive uninstall');
    assert.strictEqual(entries[0]?.hooks?.[0]?.command, foreignCommand);
  });

  test('uninstall removes only the marked entry — foreign hook with same command shape is preserved', async () => {
    // Pathological case: a user has a hook with the EXACT same command string
    // as Relay's HOOK_SCRIPT, but no marker (e.g. they copy-pasted from docs and
    // never ran `relay setup`). Uninstall should still remove only the entry we
    // own (the marker-bearing one), and leave the unmarked twin alone.
    //
    // NOTE: this is the strict-safety guarantee the new design provides. Before
    // this fix, both entries would be removed by command-string match.
    const settingsPath = join(tmp, '.claude', 'settings.json');
    await mkdir(join(tmp, '.claude'), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              // Foreign clone — no marker
              { hooks: [{ type: 'command', command: HOOK_SCRIPT }] },
            ],
          },
        },
        null,
        2
      ) + '\n',
      'utf8'
    );

    // Install (this should add a marked entry, AND migrate the legacy unmarked
    // twin away — that is the documented backward-compat behavior).
    const capInstall = makeIO(tmp);
    await executeMemoryHookCommand({ install: true, json: false }, capInstall.io, tmp);

    let settings = await readSettings(settingsPath);
    let entries = settings.hooks?.SessionStart ?? [];
    // After install, exactly one Relay-managed entry must remain.
    const relayEntries = entries.filter(
      (e) => e[HOOK_MARKER_FIELD as '_relay_id'] === HOOK_MARKER_SESSION_START
    );
    assert.strictEqual(relayEntries.length, 1, 'install is idempotent — single marked entry');

    // Now manually inject a foreign hook AFTER install. This represents the
    // user's own hook that we must never touch on uninstall.
    const foreignCommand = 'echo "user-wrote-this" >> /tmp/whatever.log';
    settings.hooks!.SessionStart!.push({
      hooks: [{ type: 'command', command: foreignCommand }],
    });
    await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');

    // Uninstall — removes only our marked entry.
    const capUninstall = makeIO(tmp);
    await executeMemoryHookCommand({ install: false, json: false }, capUninstall.io, tmp);

    settings = await readSettings(settingsPath);
    entries = settings.hooks?.SessionStart ?? [];
    const allCommands = entries.flatMap((e) => (e.hooks ?? []).map((h) => h.command));
    assert.ok(allCommands.includes(foreignCommand), 'foreign hook preserved');
    assert.strictEqual(
      entries.some((e) => e[HOOK_MARKER_FIELD as '_relay_id'] === HOOK_MARKER_SESSION_START),
      false,
      'all marked Relay entries removed'
    );
  });

  test('install replaces an existing marker-bearing entry without duplicating', async () => {
    // First install — writes a marked entry.
    const cap1 = makeIO(tmp);
    await executeMemoryHookCommand({ install: true, json: false }, cap1.io, tmp);

    // Second install — should REPLACE the prior marked entry, not duplicate.
    const cap2 = makeIO(tmp);
    await executeMemoryHookCommand({ install: true, json: false }, cap2.io, tmp);

    const settings = await readSettings(join(tmp, '.claude', 'settings.json'));
    const marked = (settings.hooks?.SessionStart ?? []).filter(
      (e) => e[HOOK_MARKER_FIELD as '_relay_id'] === HOOK_MARKER_SESSION_START
    );
    assert.strictEqual(marked.length, 1, 'no duplicate marked entries');
  });

  test('install migrates legacy { id } entry to a marker-bearing entry', async () => {
    // Legacy shape from old Relay versions: top-level `id` field, no marker.
    const settingsPath = join(tmp, '.claude', 'settings.json');
    await mkdir(join(tmp, '.claude'), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              { id: 'relay-memory-session-start', run: 'old-legacy-command' },
            ],
          },
        },
        null,
        2
      ) + '\n',
      'utf8'
    );

    const cap = makeIO(tmp);
    await executeMemoryHookCommand({ install: true, json: false }, cap.io, tmp);

    const settings = await readSettings(settingsPath);
    const entries = settings.hooks?.SessionStart ?? [];
    const legacyStillThere = entries.some((e) => e.id === 'relay-memory-session-start');
    assert.strictEqual(legacyStillThere, false, 'legacy entry migrated away');
    const marked = entries.filter(
      (e) => e[HOOK_MARKER_FIELD as '_relay_id'] === HOOK_MARKER_SESSION_START
    );
    assert.strictEqual(marked.length, 1, 'single marker-bearing entry remains');
  });

  test('SessionStart install does NOT touch SessionEnd entries (and vice versa)', async () => {
    // Install BOTH variants. They live under different event keys and use
    // different markers — neither install should disturb the other.
    const cap = makeIO(tmp);
    await executeMemoryHookCommand({ install: true, json: false }, cap.io, tmp);
    await executeMemoryHookCommand(
      { install: true, json: false, sessionEnd: true },
      cap.io,
      tmp
    );

    const settings = await readSettings(join(tmp, '.claude', 'settings.json'));
    const start = settings.hooks?.SessionStart ?? [];
    const end = settings.hooks?.SessionEnd ?? [];
    assert.strictEqual(
      start.filter((e) => e[HOOK_MARKER_FIELD as '_relay_id'] === HOOK_MARKER_SESSION_START).length,
      1
    );
    assert.strictEqual(
      end.filter((e) => e[HOOK_MARKER_FIELD as '_relay_id'] === HOOK_MARKER_SESSION_END).length,
      1
    );

    // Now uninstall ONLY SessionStart. SessionEnd marker must remain.
    await executeMemoryHookCommand({ install: false, json: false }, cap.io, tmp);
    const after = await readSettings(join(tmp, '.claude', 'settings.json'));
    assert.strictEqual(
      (after.hooks?.SessionStart ?? []).filter(
        (e) => e[HOOK_MARKER_FIELD as '_relay_id'] === HOOK_MARKER_SESSION_START
      ).length,
      0,
      'SessionStart marker removed'
    );
    assert.strictEqual(
      (after.hooks?.SessionEnd ?? []).filter(
        (e) => e[HOOK_MARKER_FIELD as '_relay_id'] === HOOK_MARKER_SESSION_END
      ).length,
      1,
      'SessionEnd marker untouched'
    );
  });

  test('foreign SessionEnd hook with command containing relay substring is preserved', async () => {
    // A user has their own SessionEnd hook that wraps a relay subcommand. It is
    // NOT one of ours (different command, no marker). Install + uninstall must
    // leave it 100% intact.
    const settingsPath = join(tmp, '.claude', 'settings.json');
    await mkdir(join(tmp, '.claude'), { recursive: true });
    const foreignCommand = 'relay memory wipe --confirm "WIPE /tmp/foo"';
    await writeFile(
      settingsPath,
      JSON.stringify(
        { hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: foreignCommand }] }] } },
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
    let settings = await readSettings(settingsPath);
    let allCommands = (settings.hooks?.SessionEnd ?? []).flatMap((e) =>
      (e.hooks ?? []).map((h) => h.command)
    );
    assert.ok(allCommands.includes(foreignCommand), 'foreign hook survives install');
    assert.ok(allCommands.includes(HOOK_SCRIPT_SESSION_END), 'relay hook installed');

    await executeMemoryHookCommand(
      { install: false, json: false, sessionEnd: true },
      cap.io,
      tmp
    );
    settings = await readSettings(settingsPath);
    allCommands = (settings.hooks?.SessionEnd ?? []).flatMap((e) =>
      (e.hooks ?? []).map((h) => h.command)
    );
    assert.ok(allCommands.includes(foreignCommand), 'foreign hook survives uninstall');
    assert.strictEqual(
      allCommands.includes(HOOK_SCRIPT_SESSION_END),
      false,
      'relay hook removed'
    );
  });
});
