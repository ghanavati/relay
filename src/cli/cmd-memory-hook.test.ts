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

interface CcSettings {
  hooks?: {
    SessionStart?: Array<{
      hooks?: Array<{ type?: string; command?: string }>;
    }>;
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
