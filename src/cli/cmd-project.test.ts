process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeProjectDisableCommand,
  executeProjectEnableCommand,
  executeProjectAuditCommand,
  executeProjectCommand,
} from './cmd-project.js';
import { MemoryStore } from '../memory/memory-store.js';
import { getDb } from '../runtime/store/db.js';
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

async function pathExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

describe('relay project disable', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-project-disable-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test('--yes writes .relayignore with all four fields off and adds it to .gitignore', async () => {
    const cap = makeIO(tmp);
    const code = await executeProjectDisableCommand(
      { action: 'disable', yes: true, json: false },
      cap.io,
    );
    assert.strictEqual(code, 0);
    const content = await readFile(join(tmp, '.relayignore'), 'utf8');
    assert.match(content, /^extract: off$/m);
    assert.match(content, /^recall: off$/m);
    assert.match(content, /^hook: off$/m);
    assert.match(content, /^shareable: false$/m);

    const gitignore = await readFile(join(tmp, '.gitignore'), 'utf8');
    assert.match(gitignore, /^\.relayignore$/m);
  });

  test('--json mode emits structured payload and skips prompts', async () => {
    const cap = makeIO(tmp);
    const code = await executeProjectDisableCommand(
      { action: 'disable', yes: false, json: true },
      cap.io,
    );
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('').trim();
    const parsed = JSON.parse(out) as {
      action: string;
      relayignore_path: string;
      gitignore_updated: boolean;
    };
    assert.strictEqual(parsed.action, 'disable');
    assert.strictEqual(parsed.gitignore_updated, true);
    assert.ok(parsed.relayignore_path.endsWith('.relayignore'));
  });

  test('does not duplicate .relayignore entry in existing .gitignore', async () => {
    await writeFile(join(tmp, '.gitignore'), 'node_modules/\n.relayignore\n', 'utf8');
    const cap = makeIO(tmp);
    const code = await executeProjectDisableCommand(
      { action: 'disable', yes: true, json: true },
      cap.io,
    );
    assert.strictEqual(code, 0);
    const gitignore = await readFile(join(tmp, '.gitignore'), 'utf8');
    const matches = gitignore.match(/^\.relayignore$/gm) ?? [];
    assert.strictEqual(matches.length, 1, '.relayignore must appear exactly once in .gitignore');
  });

  test('appends newline before adding entry when .gitignore lacks trailing newline', async () => {
    await writeFile(join(tmp, '.gitignore'), 'node_modules/', 'utf8'); // no newline
    const cap = makeIO(tmp);
    await executeProjectDisableCommand(
      { action: 'disable', yes: true, json: true },
      cap.io,
    );
    const gitignore = await readFile(join(tmp, '.gitignore'), 'utf8');
    assert.strictEqual(gitignore, 'node_modules/\n.relayignore\n');
  });
});

describe('relay project enable', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-project-enable-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test('removes existing .relayignore with --yes', async () => {
    await writeFile(join(tmp, '.relayignore'), 'extract: off\n', 'utf8');
    const cap = makeIO(tmp);
    const code = await executeProjectEnableCommand(
      { action: 'enable', yes: true, json: false },
      cap.io,
    );
    assert.strictEqual(code, 0);
    assert.strictEqual(await pathExists(join(tmp, '.relayignore')), false);
  });

  test('no-op when .relayignore is absent', async () => {
    const cap = makeIO(tmp);
    const code = await executeProjectEnableCommand(
      { action: 'enable', yes: true, json: true },
      cap.io,
    );
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('').trim();
    const parsed = JSON.parse(out) as { already_enabled?: boolean };
    assert.strictEqual(parsed.already_enabled, true);
  });
});

describe('relay project audit', () => {
  let tmp: string;

  beforeEach(async () => {
    // Isolate from other test files that share the :memory: DB
    getDb().prepare('DELETE FROM memories').run();
    tmp = await mkdtemp(join(tmpdir(), 'relay-project-audit-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test('detects relay hook in committed .claude/settings.json', async () => {
    await mkdir(join(tmp, '.claude'), { recursive: true });
    await writeFile(
      join(tmp, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: 'relay memory recall --token-budget 800' }] },
          ],
        },
      }),
      'utf8',
    );
    const cap = makeIO(tmp);
    const code = await executeProjectAuditCommand(
      { action: 'audit', yes: false, json: true },
      cap.io,
    );
    assert.strictEqual(code, 0);
    const parsed = JSON.parse(cap.stdout.join('').trim()) as {
      hooks_deployed: number;
      hook_settings_path: string | null;
      workdir_memories: number;
    };
    assert.strictEqual(parsed.hooks_deployed, 1);
    assert.ok(parsed.hook_settings_path?.endsWith('settings.json'));
    assert.strictEqual(parsed.workdir_memories, 0);
  });

  test('counts memories scoped to workdir', async () => {
    const store = new MemoryStore();
    store.remember({ content: 'lesson one for this workdir', memory_type: 'lesson', workdir: tmp });
    store.remember({ content: 'fact two for this workdir', memory_type: 'fact', workdir: tmp });
    store.remember({ content: 'unrelated memory', memory_type: 'fact', workdir: '/some/other/path' });

    const cap = makeIO(tmp);
    const code = await executeProjectAuditCommand(
      { action: 'audit', yes: false, json: true },
      cap.io,
    );
    assert.strictEqual(code, 0);
    const parsed = JSON.parse(cap.stdout.join('').trim()) as {
      hooks_deployed: number;
      workdir_memories: number;
    };
    assert.strictEqual(parsed.workdir_memories, 2);
    assert.strictEqual(parsed.hooks_deployed, 0);
  });

  test('human-readable output renders summary line', async () => {
    const cap = makeIO(tmp);
    const code = await executeProjectAuditCommand(
      { action: 'audit', yes: false, json: false },
      cap.io,
    );
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');
    assert.match(out, /relay project audit/);
    assert.match(out, /0 hooks would deploy if cloned, 0 memories would leak/);
  });

  test('does not crash when settings.json is invalid JSON', async () => {
    await mkdir(join(tmp, '.claude'), { recursive: true });
    await writeFile(join(tmp, '.claude', 'settings.json'), 'not valid {json', 'utf8');
    const cap = makeIO(tmp);
    const code = await executeProjectAuditCommand(
      { action: 'audit', yes: false, json: true },
      cap.io,
    );
    assert.strictEqual(code, 0);
    const parsed = JSON.parse(cap.stdout.join('').trim()) as { hooks_deployed: number };
    assert.strictEqual(parsed.hooks_deployed, 0);
  });
});

describe('executeProjectCommand dispatcher', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-project-dispatch-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test('routes "audit" to audit command', async () => {
    const cap = makeIO(tmp);
    const code = await executeProjectCommand(
      { action: 'audit', yes: false, json: true },
      cap.io,
    );
    assert.strictEqual(code, 0);
    const parsed = JSON.parse(cap.stdout.join('').trim()) as { workdir: string };
    assert.strictEqual(parsed.workdir, tmp);
  });

  test('rejects unknown action with exit 2', async () => {
    const cap = makeIO(tmp);
    const code = await executeProjectCommand(
      { action: 'bogus' as 'disable', yes: false, json: true },
      cap.io,
    );
    assert.strictEqual(code, 2);
    assert.match(cap.stderr.join(''), /unknown action/);
  });
});
