process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { executeContextEmitCommand } from './cmd-context-emit.js';
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

const WORKDIR = '/tmp/relay-context-emit-test';

function seedMemories() {
  const store = new MemoryStore();
  store.remember({
    content: 'always run npm test before commit',
    memory_type: 'lesson',
    workdir: WORKDIR,
  });
  store.remember({
    content: 'never use force push to main',
    memory_type: 'lesson',
    workdir: WORKDIR,
  });
}

describe('executeContextEmitCommand — per-target wrapper format', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM memories').run();
    seedMemories();
  });

  test('--target cc → SessionStart hookSpecificOutput JSON envelope', async () => {
    const cap = makeIO(WORKDIR);
    const code = await executeContextEmitCommand(
      {
        target: 'cc',
        workdir: WORKDIR,
        tokenBudget: 800,
        types: ['lesson', 'fact', 'decision', 'context'],
      },
      cap.io
    );
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');
    assert.ok(out.endsWith('\n'), 'cc output must end with newline');
    const parsed = JSON.parse(out.trim()) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.ok(
      typeof parsed.hookSpecificOutput.additionalContext === 'string',
      'additionalContext must be a string'
    );
    // Memories are seeded in this workdir → markdown body must mention at least one
    assert.match(
      parsed.hookSpecificOutput.additionalContext,
      /npm test|force push/,
      'additionalContext should contain seeded memory text'
    );
  });

  test('--target codex → plain markdown to stdout (no envelope, no trailing newline)', async () => {
    const cap = makeIO(WORKDIR);
    const code = await executeContextEmitCommand(
      {
        target: 'codex',
        workdir: WORKDIR,
        tokenBudget: 800,
        types: ['lesson', 'fact', 'decision', 'context'],
      },
      cap.io
    );
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');
    // Plain markdown — no JSON brackets at start
    assert.ok(!out.startsWith('{'), 'codex output must not be JSON');
    assert.match(out, /Recalled Lessons/, 'codex output should contain markdown heading');
    assert.match(out, /npm test|force push/, 'codex output should contain seeded memory text');
  });

  test('--target lmstudio-http → {"role":"system","content":"..."} JSON fragment', async () => {
    const cap = makeIO(WORKDIR);
    const code = await executeContextEmitCommand(
      {
        target: 'lmstudio-http',
        workdir: WORKDIR,
        tokenBudget: 800,
        types: ['lesson', 'fact', 'decision', 'context'],
      },
      cap.io
    );
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');
    assert.ok(out.endsWith('\n'), 'lmstudio-http output must end with newline');
    const parsed = JSON.parse(out.trim()) as { role: string; content: string };
    assert.strictEqual(parsed.role, 'system');
    assert.ok(typeof parsed.content === 'string');
    assert.match(parsed.content, /npm test|force push/);
  });

  test('--target lmstudio-cli → single-line text with newlines escaped', async () => {
    const cap = makeIO(WORKDIR);
    const code = await executeContextEmitCommand(
      {
        target: 'lmstudio-cli',
        workdir: WORKDIR,
        tokenBudget: 800,
        types: ['lesson', 'fact', 'decision', 'context'],
      },
      cap.io
    );
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');
    // Must terminate with one trailing \n (writer-added)
    assert.ok(out.endsWith('\n'), 'lmstudio-cli output must end with newline');
    // Body itself must be a single line (no embedded raw newlines)
    const body = out.slice(0, -1);
    assert.ok(!body.includes('\n'), 'lmstudio-cli body must not contain raw newlines');
    // Must contain the literal escape sequence \\n (markdown had real newlines)
    assert.match(body, /\\n/, 'lmstudio-cli body must escape newlines as \\n');
    // And still contain seeded memory text
    assert.match(body, /npm test|force push/);
  });
});
