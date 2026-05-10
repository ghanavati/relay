process.env['RELAY_DB_PATH'] = ':memory:';

/**
 * E2E round-trip tests for `relay context emit --target <X>`.
 *
 * Calls executeContextEmitCommand directly (no shell-out) with a captured
 * CliIO so we can assert on the exact bytes each LLM target receives.
 *
 * Complements the unit-level test in cmd-context-emit.test.ts by adding
 * full round-trip scenarios:
 *   - empty DB
 *   - 1 memory present
 *   - multiple memories
 *   - workdir scoping under RELAY_MEMORY_ALLOWED_WORKDIRS
 *   - token budget enforcement
 *   - per-target output shape (cc, codex, lmstudio-http, lmstudio-cli)
 *
 * Memories are written via handleRemember (the same entry point the CLI uses)
 * so the test exercises the full write→recall→render pipeline.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { executeContextEmitCommand } from './cmd-context-emit.js';
import { handleRemember } from '../tools/remember.js';
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

const WORKDIR_A = '/tmp/relay-emit-e2e-a';
const WORKDIR_B = '/tmp/relay-emit-e2e-b';

function clearMemories(): void {
  getDb().prepare('DELETE FROM memories').run();
}

function defaultEmit(target: 'cc' | 'codex' | 'lmstudio-http' | 'lmstudio-cli', workdir: string, tokenBudget = 800) {
  return {
    target,
    workdir,
    tokenBudget,
    types: ['lesson', 'fact', 'decision', 'context'] as const,
  };
}

describe('relay context emit — E2E round-trip per target', () => {
  beforeEach(() => {
    clearMemories();
    delete process.env['RELAY_MEMORY_ALLOWED_WORKDIRS'];
  });

  afterEach(() => {
    delete process.env['RELAY_MEMORY_ALLOWED_WORKDIRS'];
  });

  test('empty DB + target cc → SessionStart envelope with empty additionalContext', async () => {
    const cap = makeIO(WORKDIR_A);
    const code = await executeContextEmitCommand(defaultEmit('cc', WORKDIR_A), cap.io);
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');
    const parsed = JSON.parse(out.trim()) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.strictEqual(parsed.hookSpecificOutput.additionalContext, '');
  });

  test('1 memory + target cc → additionalContext non-empty markdown containing the content', async () => {
    handleRemember(
      { content: 'always run npm test before commit', memory_type: 'lesson', tags: [], pinned: false, workdir: WORKDIR_A },
      'human',
    );
    const cap = makeIO(WORKDIR_A);
    const code = await executeContextEmitCommand(defaultEmit('cc', WORKDIR_A), cap.io);
    assert.strictEqual(code, 0);
    const parsed = JSON.parse(cap.stdout.join('').trim()) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.ok(parsed.hookSpecificOutput.additionalContext.length > 0, 'additionalContext should not be empty');
    assert.match(parsed.hookSpecificOutput.additionalContext, /always run npm test before commit/);
  });

  test('3 memories + target cc → all 3 contents present in additionalContext', async () => {
    const contents = ['lesson one alpha keyword', 'lesson two bravo keyword', 'lesson three charlie keyword'];
    for (const content of contents) {
      handleRemember({ content, memory_type: 'lesson', tags: [], pinned: false, workdir: WORKDIR_A }, 'human');
    }
    const cap = makeIO(WORKDIR_A);
    const code = await executeContextEmitCommand(defaultEmit('cc', WORKDIR_A), cap.io);
    assert.strictEqual(code, 0);
    const parsed = JSON.parse(cap.stdout.join('').trim()) as {
      hookSpecificOutput: { additionalContext: string };
    };
    for (const content of contents) {
      assert.match(parsed.hookSpecificOutput.additionalContext, new RegExp(content));
    }
  });

  test('workdir scoping under RELAY_MEMORY_ALLOWED_WORKDIRS — A returns own; B returns empty', async () => {
    process.env['RELAY_MEMORY_ALLOWED_WORKDIRS'] = `${WORKDIR_A}:${WORKDIR_B}`;
    handleRemember(
      { content: 'memory scoped strictly to workdir A', memory_type: 'lesson', tags: [], pinned: false, workdir: WORKDIR_A },
      'human',
    );

    const capA = makeIO(WORKDIR_A);
    assert.strictEqual(await executeContextEmitCommand(defaultEmit('cc', WORKDIR_A), capA.io), 0);
    const parsedA = JSON.parse(capA.stdout.join('').trim()) as {
      hookSpecificOutput: { additionalContext: string };
    };
    assert.match(parsedA.hookSpecificOutput.additionalContext, /memory scoped strictly to workdir A/);

    const capB = makeIO(WORKDIR_B);
    assert.strictEqual(await executeContextEmitCommand(defaultEmit('cc', WORKDIR_B), capB.io), 0);
    const parsedB = JSON.parse(capB.stdout.join('').trim()) as {
      hookSpecificOutput: { additionalContext: string };
    };
    assert.strictEqual(parsedB.hookSpecificOutput.additionalContext, '', 'workdir B should see no memories from A');
  });

  test('token budget — 10 memories with budget=100 → output respects budget', async () => {
    for (let i = 0; i < 10; i++) {
      handleRemember(
        {
          content: `memory ${i} ${'lorem ipsum dolor sit amet '.repeat(10)}`,
          memory_type: 'lesson',
          tags: [],
          pinned: false,
          workdir: WORKDIR_A,
        },
        'human',
      );
    }
    const cap = makeIO(WORKDIR_A);
    const code = await executeContextEmitCommand(defaultEmit('cc', WORKDIR_A, 100), cap.io);
    assert.strictEqual(code, 0);
    const parsed = JSON.parse(cap.stdout.join('').trim()) as {
      hookSpecificOutput: { additionalContext: string };
    };
    // Token estimator is ~1 token per 4 chars. With budget=100, body should be ≤ ~600 chars
    // including the ~80-char header. Using 1500 as a generous upper bound that still proves
    // the budget enforced (raw 10 entries would exceed 4000 chars).
    assert.ok(
      parsed.hookSpecificOutput.additionalContext.length < 1500,
      `expected budget-bounded output, got ${parsed.hookSpecificOutput.additionalContext.length} chars`,
    );
  });

  test('target codex → plain markdown (no JSON envelope)', async () => {
    handleRemember(
      { content: 'codex target marker text', memory_type: 'lesson', tags: [], pinned: false, workdir: WORKDIR_A },
      'human',
    );
    const cap = makeIO(WORKDIR_A);
    const code = await executeContextEmitCommand(defaultEmit('codex', WORKDIR_A), cap.io);
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');
    assert.ok(!out.startsWith('{'), 'codex output must not be JSON');
    assert.match(out, /codex target marker text/);
    assert.match(out, /Recalled Lessons/, 'codex body should contain markdown heading');
  });

  test('target lmstudio-http → JSON {role:"system",content:"..."} fragment', async () => {
    handleRemember(
      { content: 'lmstudio http marker text', memory_type: 'lesson', tags: [], pinned: false, workdir: WORKDIR_A },
      'human',
    );
    const cap = makeIO(WORKDIR_A);
    const code = await executeContextEmitCommand(defaultEmit('lmstudio-http', WORKDIR_A), cap.io);
    assert.strictEqual(code, 0);
    const parsed = JSON.parse(cap.stdout.join('').trim()) as { role: string; content: string };
    assert.strictEqual(parsed.role, 'system');
    assert.match(parsed.content, /lmstudio http marker text/);
  });

  test('target lmstudio-cli → single-line text with newlines escaped', async () => {
    handleRemember(
      { content: 'lmstudio cli marker text', memory_type: 'lesson', tags: [], pinned: false, workdir: WORKDIR_A },
      'human',
    );
    const cap = makeIO(WORKDIR_A);
    const code = await executeContextEmitCommand(defaultEmit('lmstudio-cli', WORKDIR_A), cap.io);
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');
    assert.ok(out.endsWith('\n'), 'lmstudio-cli output must end with a single trailing newline');
    const body = out.slice(0, -1);
    assert.ok(!body.includes('\n'), 'lmstudio-cli body must not contain raw newlines');
    assert.match(body, /\\n/, 'lmstudio-cli body must escape newlines as \\n');
    assert.match(body, /lmstudio cli marker text/);
  });
});
