/**
 * lmstudio-agentic worker — TDD test suite.
 *
 * Pattern (mirrors codex.test.ts):
 *   - node:test + assert/strict
 *   - Pure-function injection seams: `fetchImpl`, `shellExec`, `maxIterations`
 *   - No real HTTP, no real /bin/sh execution (use the seams)
 *
 * Coverage map (PLAN.md tasks T1-T8):
 *   T1 — preconditions
 *   T2 — pure helpers + constructor + missing-tools guard
 *   T3 — executeToolCall sandbox (shell_exec/bash, cwd clamp, 32KB truncation, id echo)
 *   T4 — tool loop + iteration cap + timeout + capability probe + usage sum
 *   T5 — hash-based loop detector (3 consecutive identical)
 *   T6 — LFM2 nudge integration
 *   T7 — dispatch wiring smoke (cmd-run + cmd-parallel)
 *   T8 — integration against ephemeral in-process http server
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';

import type { ExecutionModel } from './runner.js';
import type {
  ToolDef,
  ToolCall,
  ToolCallMessage,
  WorkerResult,
  WorkerTask,
} from './types.js';

// ─── Helper — read a .ts source file from the worktree root ──────────────
// dist/workers/lmstudio-agentic.test.js → repo root is ../../  (dist/workers/ → dist/ → root)
async function readSourceFile(relpath: string): Promise<string> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const here = new URL('.', import.meta.url).pathname;       // .../dist/workers/
  const root = path.resolve(here, '..', '..');                // .../repo-root
  return fs.readFile(path.join(root, relpath), 'utf-8');
}

// ─── T1: PRECONDITIONS ────────────────────────────────────────────────────

describe('T1 — preconditions', () => {
  test('ExecutionModel union includes "tool_loop"', () => {
    // Compile-time: this assignment must type-check.
    const m: ExecutionModel = 'tool_loop';
    assert.equal(m, 'tool_loop');
  });

  test('ToolDef/ToolCall/ToolCallMessage shapes are usable', () => {
    const toolDef: ToolDef = {
      type: 'function',
      function: {
        name: 'shell_exec',
        description: 'Execute a shell command.',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
          additionalProperties: false,
        },
      },
    };
    const call: ToolCall = {
      id: '365174485',
      type: 'function',
      function: { name: 'shell_exec', arguments: '{"command":"echo hi"}' },
    };
    const msg: ToolCallMessage = {
      role: 'tool',
      tool_call_id: '365174485',
      content: 'STDOUT:\nhi\n\nSTDERR:\n\nEXIT: 0',
    };
    assert.equal(toolDef.type, 'function');
    assert.equal(call.id, '365174485');
    assert.equal(msg.tool_call_id, call.id, 'byte-exact echo preserved');
  });

  test('WorkerTask.tools accepts an array of ToolDef', () => {
    const task: Pick<WorkerTask, 'tools'> = {
      tools: [
        { type: 'function', function: { name: 'noop' } },
      ],
    };
    assert.equal(task.tools?.length, 1);
  });

  test('WorkerResult accepts iterations + tool_call_count', () => {
    const r: WorkerResult = {
      status: 'success',
      output: 'done',
      duration_ms: 12,
      exit_code: 0,
      iterations: 3,
      tool_call_count: 2,
    };
    assert.equal(r.iterations, 3);
    assert.equal(r.tool_call_count, 2);
  });

  test('cmd-run.ts provider union includes "lmstudio-agentic"', async () => {
    // Runtime check against the .ts source — type unions are erased in compiled JS.
    // From the worktree root: src/cli/cmd-run.ts is the source of truth.
    const src = await readSourceFile('src/cli/cmd-run.ts');
    assert.ok(
      /'codex'\s*\|\s*'openrouter'\s*\|\s*'lmstudio'\s*\|\s*'anthropic'\s*\|\s*'lmstudio-agentic'/.test(src),
      'RunCommandArgs.provider union must include lmstudio-agentic'
    );
    assert.ok(
      /HTTP_PROVIDERS\s*=\s*new\s+Set\(\[[^\]]*'lmstudio-agentic'/.test(src),
      'HTTP_PROVIDERS set must include lmstudio-agentic'
    );
  });

  test('cmd-parallel.ts SpecTask provider union and validProviders include "lmstudio-agentic"', async () => {
    const src = await readSourceFile('src/cli/cmd-parallel.ts');
    assert.ok(
      /'codex'\s*\|\s*'lmstudio'\s*\|\s*'openrouter'\s*\|\s*'anthropic'\s*\|\s*'lmstudio-agentic'/.test(src),
      'SpecTask.provider union must include lmstudio-agentic'
    );
    assert.ok(
      /validProviders\s*=\s*new\s+Set\(\[[^\]]*'lmstudio-agentic'/.test(src),
      'validProviders set must include lmstudio-agentic'
    );
    assert.ok(
      /httpProviders\s*=\s*new\s+Set\(\[[^\]]*'lmstudio-agentic'/.test(src),
      'httpProviders set must include lmstudio-agentic'
    );
  });
});

// ─── T2: SKELETON + PURE HELPERS ─────────────────────────────────────────

import {
  LmStudioAgenticRunner,
  buildInitialMessages,
  buildLfm2Nudge,
} from './lmstudio-agentic.js';

const shellExecToolDef: ToolDef = {
  type: 'function',
  function: {
    name: 'shell_exec',
    description: 'Execute a shell command in the task workdir.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
      additionalProperties: false,
    },
  },
};

function baseTask(overrides: Partial<WorkerTask> = {}): WorkerTask {
  return {
    task: 'do thing',
    workdir: '/tmp/work',
    timeout_ms: 5_000,
    model: 'qwen/qwen3-coder-next',
    run_id: 'test-run-1',
    provider: 'lmstudio-agentic',
    tools: [shellExecToolDef],
    ...overrides,
  };
}

describe('T2 — skeleton + pure helpers', () => {
  test('LmStudioAgenticRunner.capabilities = agentic + tool_loop', () => {
    const runner = new LmStudioAgenticRunner();
    assert.equal(runner.capabilities?.agentic, true);
    assert.equal(runner.capabilities?.execution_model, 'tool_loop');
  });

  test('buildInitialMessages — user message only when no contextPrefix', () => {
    const msgs = buildInitialMessages(baseTask({ contextPrefix: undefined }));
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0]?.role, 'user');
    assert.equal(msgs[0]?.content, 'do thing');
  });

  test('buildInitialMessages — system + user when contextPrefix present', () => {
    const msgs = buildInitialMessages(baseTask({ contextPrefix: 'You are a coding agent.' }));
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0]?.role, 'system');
    assert.equal(msgs[0]?.content, 'You are a coding agent.');
    assert.equal(msgs[1]?.role, 'user');
    assert.equal(msgs[1]?.content, 'do thing');
  });

  test('buildLfm2Nudge — non-LFM2 model returns null', () => {
    assert.equal(buildLfm2Nudge('qwen/qwen3-coder-next'), null);
    assert.equal(buildLfm2Nudge('openai/gpt-oss-20b'), null);
    assert.equal(buildLfm2Nudge(undefined), null);
    assert.equal(buildLfm2Nudge(''), null);
  });

  test('buildLfm2Nudge — LFM2 model returns JSON-format nudge', () => {
    const nudge = buildLfm2Nudge('liquid/lfm2-24b-a2b');
    assert.notEqual(nudge, null);
    // PLAN T2 RED — exact string per pitfall 1.1
    assert.equal(
      nudge,
      'Output function calls strictly as JSON in the tool_calls field, never as Python literals.'
    );
  });

  test('buildLfm2Nudge — case-insensitive on prefix', () => {
    assert.notEqual(buildLfm2Nudge('LIQUID/LFM2-foo'), null);
    assert.notEqual(buildLfm2Nudge('Liquid/Lfm2-Bar'), null);
  });

  test('run() returns INVALID_ARGS when task.tools missing', async () => {
    const runner = new LmStudioAgenticRunner();
    const result = await runner.run(baseTask({ tools: undefined }));
    assert.equal(result.status, 'error');
    assert.equal(result.error?.code, 'INVALID_ARGS');
    assert.match(result.error?.message ?? '', /tools/i);
  });

  test('run() returns INVALID_ARGS when task.tools empty', async () => {
    const runner = new LmStudioAgenticRunner();
    const result = await runner.run(baseTask({ tools: [] }));
    assert.equal(result.status, 'error');
    assert.equal(result.error?.code, 'INVALID_ARGS');
  });
});
