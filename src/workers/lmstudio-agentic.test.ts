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
