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

// ─── T3: TOOL EXECUTION SANDBOX ───────────────────────────────────────────

import { executeToolCall, executeShellExec, type ShellExecFn, type ShellExecArgs } from './lmstudio-agentic.js';

function makeShellExecRecorder(stubResult?: Partial<{ stdout: string; stderr: string; exitCode: number }>): {
  shellExec: ShellExecFn;
  calls: ShellExecArgs[];
} {
  const calls: ShellExecArgs[] = [];
  const shellExec: ShellExecFn = async (args) => {
    calls.push(args);
    return {
      stdout: stubResult?.stdout ?? '',
      stderr: stubResult?.stderr ?? '',
      exitCode: stubResult?.exitCode ?? 0,
    };
  };
  return { shellExec, calls };
}

describe('T3 — tool execution sandbox', () => {
  test('unknown tool → returns ERROR message, never throws', async () => {
    const { shellExec } = makeShellExecRecorder();
    const call: ToolCall = {
      id: 'call_xyz',
      type: 'function',
      function: { name: 'figma_unknown', arguments: '{}' },
    };
    const result = await executeToolCall(call, '/tmp/work', shellExec);
    assert.equal(result.role, 'tool');
    assert.equal(result.tool_call_id, 'call_xyz');
    assert.match(result.content, /ERROR: unknown tool figma_unknown/);
  });

  test('arguments not valid JSON → returns ERROR message', async () => {
    const { shellExec } = makeShellExecRecorder();
    const call: ToolCall = {
      id: 'call_1',
      type: 'function',
      function: { name: 'shell_exec', arguments: '{ not valid }' },
    };
    const result = await executeToolCall(call, '/tmp/work', shellExec);
    assert.equal(result.tool_call_id, 'call_1');
    assert.match(result.content, /ERROR: arguments not valid JSON/);
  });

  test('shell_exec → invokes shellExec with workdir cwd + maxBytes=32768 and returns stringified result', async () => {
    const { shellExec, calls } = makeShellExecRecorder({ stdout: 'hi\n', exitCode: 0 });
    const call: ToolCall = {
      id: 'call_2',
      type: 'function',
      function: { name: 'shell_exec', arguments: JSON.stringify({ command: 'echo hi' }) },
    };
    const result = await executeToolCall(call, '/tmp/work', shellExec);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, 'echo hi');
    assert.equal(calls[0]?.cwd, '/tmp/work');
    assert.equal(calls[0]?.maxBytes, 32768);
    assert.equal(result.tool_call_id, 'call_2');
    // Note: stdout 'hi\n' → STDOUT:\nhi\n followed by \n\nSTDERR: separator → triple-newline
    assert.match(result.content, /STDOUT:\nhi\n\n\nSTDERR:\n\n\nEXIT: 0/);
  });

  test('alias "bash" resolves to the same handler as shell_exec', async () => {
    const { shellExec, calls } = makeShellExecRecorder({ stdout: 'ok\n', exitCode: 0 });
    const call: ToolCall = {
      id: 'call_bash',
      type: 'function',
      function: { name: 'bash', arguments: JSON.stringify({ command: 'echo ok' }) },
    };
    const result = await executeToolCall(call, '/tmp/work', shellExec);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, 'echo ok');
    assert.equal(calls[0]?.cwd, '/tmp/work');
    assert.match(result.content, /STDOUT:\nok\n/);
  });

  test('cwd-clamp: model-emitted {cwd:"/etc"} is silently dropped — task.workdir wins', async () => {
    const { shellExec, calls } = makeShellExecRecorder({ stdout: 'denied\n' });
    const call: ToolCall = {
      id: 'call_3',
      type: 'function',
      function: { name: 'shell_exec', arguments: JSON.stringify({ command: 'ls', cwd: '/etc' }) },
    };
    await executeToolCall(call, '/tmp/work', shellExec);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.cwd, '/tmp/work', 'task.workdir must override model-emitted cwd');
  });

  test('stdout >32KB → truncated with marker; content length bounded', async () => {
    const big = 'A'.repeat(50_000); // 50KB
    const { shellExec } = makeShellExecRecorder({ stdout: big, exitCode: 0 });
    const call: ToolCall = {
      id: 'call_trunc',
      type: 'function',
      function: { name: 'shell_exec', arguments: JSON.stringify({ command: 'cat big' }) },
    };
    const result = await executeToolCall(call, '/tmp/work', shellExec);
    // Truncated stdout block should NOT contain the full 50K, but should contain the marker.
    assert.match(result.content, /…\[TRUNCATED: original 50000 bytes\]/);
    // The reported stdout segment (before STDERR) must be ≤ 32768 + marker length.
    const stdoutMatch = result.content.match(/STDOUT:\n([\s\S]*?)\n\nSTDERR:/);
    assert.ok(stdoutMatch, 'STDOUT segment must be present');
    const stdoutSegment = stdoutMatch[1] ?? '';
    const stdoutBytes = Buffer.byteLength(stdoutSegment, 'utf-8');
    // 32768 bytes of payload + marker (~36 bytes) — bound is "≤ 32768 + 100" generous
    assert.ok(stdoutBytes <= 32768 + 200, `stdout segment ${stdoutBytes} bytes must be near-bounded`);
  });

  test('tool_call_id byte-exact echo: numeric "365174485"', async () => {
    const { shellExec } = makeShellExecRecorder();
    const call: ToolCall = {
      id: '365174485',
      type: 'function',
      function: { name: 'shell_exec', arguments: JSON.stringify({ command: 'echo' }) },
    };
    const result = await executeToolCall(call, '/tmp/work', shellExec);
    assert.equal(result.tool_call_id, '365174485', 'numeric id preserved byte-exact');
  });

  test('tool_call_id byte-exact echo: UUID-style "call_abc-123-XYZ"', async () => {
    const { shellExec } = makeShellExecRecorder();
    const call: ToolCall = {
      id: 'call_abc-123-XYZ',
      type: 'function',
      function: { name: 'shell_exec', arguments: JSON.stringify({ command: 'pwd' }) },
    };
    const result = await executeToolCall(call, '/tmp/work', shellExec);
    assert.equal(result.tool_call_id, 'call_abc-123-XYZ', 'UUID-style id preserved byte-exact');
  });

  test('executeShellExec — empty command rejected by zod schema', async () => {
    const { shellExec } = makeShellExecRecorder();
    await assert.rejects(
      executeShellExec({ command: '' }, '/tmp/work', shellExec),
      /String must contain at least 1 character|Required|too_small/
    );
  });
});

// ─── T4: TOOL LOOP + ITERATION CAP + TIMEOUT + CAPABILITY PROBE ──────────

import type { FetchFn } from './lmstudio-agentic.js';

interface RecordedRequest {
  url: string;
  init: RequestInit;
}

/**
 * Build a scripted fetch that handles probe + chat. The script is a queue of
 * chat-completion responses; each chat POST consumes one element. The capability
 * probe (GET /api/v0/models) always returns `qwen3-coder-next` with `tool_use`.
 */
interface ChatScript {
  // Either a body to return, or a function for advanced cases (status, throws, etc.).
  responses: Array<
    | { kind: 'ok'; body: unknown }
    | { kind: 'status'; status: number; body?: string }
    | { kind: 'reject'; error: unknown }
    | { kind: 'never' } // never resolves until aborted
  >;
  capability?: { id: string; capabilities: string[] }[];
}

function makeScriptedFetch(script: ChatScript): { fetchImpl: FetchFn; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const chatQueue = [...script.responses];
  const fetchImpl: FetchFn = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
    requests.push({ url, init: init ?? {} });
    if (/\/api\/v0\/models$/.test(url)) {
      const data = script.capability ?? [{ id: 'qwen/qwen3-coder-next', capabilities: ['tool_use'] }];
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // chat completion
    const step = chatQueue.shift();
    if (!step) throw new Error('scripted fetch exhausted — no more chat-completion responses');
    if (step.kind === 'ok') {
      return new Response(JSON.stringify(step.body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (step.kind === 'status') {
      return new Response(step.body ?? '', {
        status: step.status,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
    if (step.kind === 'reject') {
      throw step.error;
    }
    // 'never' — honor abort
    return new Promise<Response>((_resolve, reject) => {
      const signal = (init as RequestInit & { signal?: AbortSignal })?.signal;
      if (signal) {
        if (signal.aborted) reject(new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }
    });
  };
  return { fetchImpl, requests };
}

/** Helper: build an assistant message with N tool_calls (round-robin command args). */
function asstWithToolCalls(calls: Array<{ id: string; command: string }>) {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: 'shell_exec', arguments: JSON.stringify({ command: c.command }) },
          })),
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

/** Helper: final assistant message with content and finish_reason 'stop'. */
function asstFinal(content: string, usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) {
  return {
    choices: [
      {
        message: { role: 'assistant', content, tool_calls: undefined },
        finish_reason: 'stop',
      },
    ],
    usage,
  };
}

describe('T4 — tool loop, iteration cap, timeout, capability probe', () => {
  test('zero tool calls → 1 POST, iterations=1, tool_call_count=0, status=success', async () => {
    const { fetchImpl, requests } = makeScriptedFetch({
      responses: [{ kind: 'ok', body: asstFinal('done!') }],
    });
    const runner = new LmStudioAgenticRunner({ fetchImpl, shellExec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) });
    const result = await runner.run(baseTask());
    assert.equal(result.status, 'success');
    assert.equal(result.iterations, 1);
    assert.equal(result.tool_call_count, 0);
    assert.equal(result.output, 'done!');
    const chatPosts = requests.filter((r) => r.url.endsWith('/v1/chat/completions'));
    assert.equal(chatPosts.length, 1);
  });

  test('one tool call then final → 2 POSTs, tool message appended with byte-exact id', async () => {
    const { fetchImpl, requests } = makeScriptedFetch({
      responses: [
        { kind: 'ok', body: asstWithToolCalls([{ id: 'call_1', command: 'ls' }]) },
        { kind: 'ok', body: asstFinal('listed') },
      ],
    });
    const stub: ShellExecFn = async () => ({ stdout: 'file1\nfile2\n', stderr: '', exitCode: 0 });
    const runner = new LmStudioAgenticRunner({ fetchImpl, shellExec: stub });
    const result = await runner.run(baseTask());
    assert.equal(result.status, 'success');
    assert.equal(result.iterations, 2);
    assert.equal(result.tool_call_count, 1);
    assert.equal(result.output, 'listed');
    // Inspect 2nd POST body — tool message must be present with byte-exact id.
    const chatPosts = requests.filter((r) => r.url.endsWith('/v1/chat/completions'));
    assert.equal(chatPosts.length, 2);
    const body2 = JSON.parse(chatPosts[1]?.init.body as string);
    const toolMsg = body2.messages.find((m: { role: string }) => m.role === 'tool');
    assert.ok(toolMsg, 'tool message must be in iteration 2 body');
    assert.equal(toolMsg.tool_call_id, 'call_1', 'byte-exact id echo');
    assert.match(toolMsg.content, /STDOUT:\nfile1/);
  });

  test('iteration cap (20) — loop returns UNSUPPORTED "iteration cap" without firing detector', async () => {
    // Each iteration emits a UNIQUE tool call (vary args) so detector never fires.
    const responses = Array.from({ length: 20 }, (_, i) => ({
      kind: 'ok' as const,
      body: asstWithToolCalls([{ id: `call_${i}`, command: `echo ${i}` }]),
    }));
    const { fetchImpl, requests } = makeScriptedFetch({ responses });
    const stub: ShellExecFn = async () => ({ stdout: 'ok', stderr: '', exitCode: 0 });
    const runner = new LmStudioAgenticRunner({ fetchImpl, shellExec: stub, maxIterations: 20 });
    const result = await runner.run(baseTask());
    assert.equal(result.status, 'error');
    assert.equal(result.error?.code, 'UNSUPPORTED');
    assert.match(result.error?.message ?? '', /iteration cap/i);
    assert.equal(result.iterations, 20);
    const chatPosts = requests.filter((r) => r.url.endsWith('/v1/chat/completions'));
    assert.equal(chatPosts.length, 20);
  });

  test('wall-clock timeout via AbortController → status=timeout, TIMEOUT retryable=true', async () => {
    const { fetchImpl } = makeScriptedFetch({ responses: [{ kind: 'never' }] });
    const stub: ShellExecFn = async () => ({ stdout: '', stderr: '', exitCode: 0 });
    const runner = new LmStudioAgenticRunner({ fetchImpl, shellExec: stub });
    const result = await runner.run(baseTask({ timeout_ms: 80 }));
    assert.equal(result.status, 'timeout');
    assert.equal(result.error?.code, 'TIMEOUT');
    assert.equal(result.error?.retryable, true);
  });

  test('HTTP 500 → status=error, PROVIDER_ERROR retryable=true, no further iterations', async () => {
    const { fetchImpl, requests } = makeScriptedFetch({
      responses: [{ kind: 'status', status: 500, body: 'internal error' }],
    });
    const stub: ShellExecFn = async () => ({ stdout: '', stderr: '', exitCode: 0 });
    const runner = new LmStudioAgenticRunner({ fetchImpl, shellExec: stub });
    const result = await runner.run(baseTask());
    assert.equal(result.status, 'error');
    assert.equal(result.error?.code, 'PROVIDER_ERROR');
    assert.equal(result.error?.retryable, true);
    assert.equal(result.iterations, 1, 'must NOT iterate past the 500');
    const chatPosts = requests.filter((r) => r.url.endsWith('/v1/chat/completions'));
    assert.equal(chatPosts.length, 1);
  });

  test('usage summed across iterations: 3 turns × 100 total_tokens = 300', async () => {
    const tc = (id: string) => asstWithToolCalls([{ id, command: `echo ${id}` }]);
    const sub = (n: number) => ({ prompt_tokens: 50, completion_tokens: 50, total_tokens: 100 });
    const { fetchImpl } = makeScriptedFetch({
      responses: [
        { kind: 'ok', body: { ...tc('a'), usage: sub(1) } },
        { kind: 'ok', body: { ...tc('b'), usage: sub(2) } },
        { kind: 'ok', body: asstFinal('done', sub(3)) },
      ],
    });
    const stub: ShellExecFn = async () => ({ stdout: 'x', stderr: '', exitCode: 0 });
    const runner = new LmStudioAgenticRunner({ fetchImpl, shellExec: stub });
    const result = await runner.run(baseTask());
    assert.equal(result.status, 'success');
    assert.equal(result.token_usage, 300);
    assert.equal(result.prompt_tokens, 150);
    assert.equal(result.completion_tokens, 150);
  });

  test('capability probe rejects → INVALID_ARGS non-retryable; zero POSTs to /v1/chat/completions', async () => {
    const { fetchImpl, requests } = makeScriptedFetch({
      responses: [], // chat completion should NEVER be called
      capability: [{ id: 'qwen/qwen3-coder-next', capabilities: ['vision'] }], // missing tool_use
    });
    const stub: ShellExecFn = async () => ({ stdout: '', stderr: '', exitCode: 0 });
    const runner = new LmStudioAgenticRunner({ fetchImpl, shellExec: stub });
    const result = await runner.run(baseTask());
    assert.equal(result.status, 'error');
    assert.equal(result.error?.code, 'INVALID_ARGS');
    assert.equal(result.error?.retryable, false);
    const chatPosts = requests.filter((r) => r.url.endsWith('/v1/chat/completions'));
    assert.equal(chatPosts.length, 0, 'capability gate must short-circuit before any chat POST');
  });

  test('capability probe — model not loaded → INVALID_ARGS with "lms load" hint', async () => {
    const { fetchImpl } = makeScriptedFetch({
      responses: [],
      capability: [{ id: 'other/model', capabilities: ['tool_use'] }], // wrong id
    });
    const stub: ShellExecFn = async () => ({ stdout: '', stderr: '', exitCode: 0 });
    const runner = new LmStudioAgenticRunner({ fetchImpl, shellExec: stub });
    const result = await runner.run(baseTask());
    assert.equal(result.status, 'error');
    assert.equal(result.error?.code, 'INVALID_ARGS');
    assert.match(result.error?.message ?? '', /not loaded|lms load/i);
  });

  test('tools[] re-sent every iteration (LMSTUDIO-TOOL-API.md §Follow-up Turn)', async () => {
    const { fetchImpl, requests } = makeScriptedFetch({
      responses: [
        { kind: 'ok', body: asstWithToolCalls([{ id: 'c1', command: 'ls' }]) },
        { kind: 'ok', body: asstFinal('ok') },
      ],
    });
    const stub: ShellExecFn = async () => ({ stdout: 'x', stderr: '', exitCode: 0 });
    const runner = new LmStudioAgenticRunner({ fetchImpl, shellExec: stub });
    const result = await runner.run(baseTask());
    assert.equal(result.status, 'success');
    const chatPosts = requests.filter((r) => r.url.endsWith('/v1/chat/completions'));
    assert.equal(chatPosts.length, 2);
    for (let i = 0; i < chatPosts.length; i++) {
      const body = JSON.parse(chatPosts[i]?.init.body as string);
      assert.ok(Array.isArray(body.tools), `iteration ${i + 1} must include tools[]`);
      assert.equal(body.tools.length, 1);
      assert.equal(body.tools[0]?.function?.name, 'shell_exec');
      assert.equal(body.tool_choice, 'auto');
      assert.equal(body.stream, false, 'stream must be hard-coded false');
    }
  });
});
