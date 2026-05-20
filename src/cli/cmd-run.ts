/**
 * `relay run <task>` — single-task delegation to codex / openrouter / lmstudio.
 *
 * Flow:
 *   1. Validate args (task non-empty, provider known, model required for HTTP providers)
 *   2. Generate run_id, insert pending run row
 *   3. Dispatch to the matching worker
 *   4. Capture WorkerResult, complete/error the run row
 *   5. Emit JSON or human-readable output
 *
 * Supported providers in v0.1.0: codex, openrouter, lmstudio.
 * Anthropic deferred (no tool-loop in slim distro).
 */

import { randomUUID } from 'node:crypto';
import type { CliIO } from './commands.js';

export interface RunCommandArgs {
  task: string;
  provider: 'codex' | 'openrouter' | 'lmstudio' | 'anthropic' | 'lmstudio-agentic';
  model?: string;
  workdir: string;
  timeoutMs: number;
  reasoningEffort?: string;
  json: boolean;
}

const HTTP_PROVIDERS = new Set(['openrouter', 'lmstudio', 'anthropic', 'lmstudio-agentic']);

export async function executeRunCommand(args: RunCommandArgs, io: CliIO): Promise<number> {
  // 1. Validate
  if (!args.task.trim()) {
    io.stderr('relay run requires a non-empty task\n');
    return 2;
  }
  if (HTTP_PROVIDERS.has(args.provider) && !args.model) {
    io.stderr(`relay run requires --model when --provider is ${args.provider}\n`);
    return 2;
  }

  // 2. Build run row
  const run_id = randomUUID();
  const queued_at = Date.now();
  const task_excerpt = args.task.length > 200 ? args.task.slice(0, 200) + '…' : args.task;

  const { RunStore } = await import('../runtime/store/run-store.js');
  const runStore = new RunStore();
  runStore.create({
    run_id,
    provider: args.provider,
    model: args.model ?? null,
    workdir: args.workdir,
    status: 'running',
    queued_at,
    task_excerpt,
    timeout_ms: args.timeoutMs,
  });
  runStore.recordEvent(run_id, 'started', {
    task_excerpt,
    provider: args.provider,
    model: args.model ?? null,
  });

  const started_at = Date.now();

  // 3. Get the worker
  let runner;
  try {
    if (args.provider === 'codex') {
      const { CodexRunner } = await import('../workers/codex.js');
      runner = new CodexRunner();
    } else if (args.provider === 'lmstudio') {
      const { LmStudioRunner } = await import('../workers/lmstudio.js');
      runner = new LmStudioRunner();
    } else if (args.provider === 'openrouter') {
      const { OpenRouterRunner } = await import('../workers/openrouter.js');
      runner = new OpenRouterRunner();
    } else if (args.provider === 'anthropic') {
      const { AnthropicRunner } = await import('../workers/anthropic.js');
      runner = new AnthropicRunner();
    } else if (args.provider === 'lmstudio-agentic') {
      const { LmStudioAgenticRunner } = await import('../workers/lmstudio-agentic.js');
      runner = new LmStudioAgenticRunner();
    } else {
      const exhaustive: never = args.provider;
      void exhaustive;
      io.stderr(`unsupported provider: ${args.provider}\n`);
      runStore.recordError(run_id, {
        error_code: 'INVALID_ARGS',
        error_message: `unsupported provider: ${args.provider}`,
        finished_at: Date.now(),
      });
      return 2;
    }
  } catch (err) {
    const message = (err as Error).message;
    io.stderr(`failed to load ${args.provider} runner: ${message}\n`);
    runStore.recordError(run_id, {
      error_code: 'RUNNER_LOAD_FAILED',
      error_message: message,
      finished_at: Date.now(),
    });
    return 1;
  }

  // 4. Dispatch
  const { buildDelegatedTask } = await import('../context/layers.js');
  const built = await buildDelegatedTask({
    workdir: args.workdir,
    task: args.task,
    run_id,
  });
  // Inject default agentic tools when dispatching to lmstudio-agentic so the
  // runner has a shell_exec tool to offer the model. Worker rejects empty tools[].
  let tools;
  if (args.provider === 'lmstudio-agentic') {
    const { DEFAULT_AGENTIC_TOOLS } = await import('../workers/lmstudio-agentic.js');
    tools = DEFAULT_AGENTIC_TOOLS;
  }
  let result;
  try {
    result = await runner.run({
      task: built.bareTask,
      contextPrefix: built.contextPrefix,
      workdir: args.workdir,
      timeout_ms: args.timeoutMs,
      model: args.model,
      reasoning_effort: args.reasoningEffort,
      run_id,
      provider: args.provider,
      ...(tools ? { tools } : {}),
    });
  } catch (err) {
    const message = (err as Error).message;
    runStore.recordError(run_id, {
      error_code: 'WORKER_THREW',
      error_message: message,
      finished_at: Date.now(),
    });
    if (args.json) {
      io.stdout(JSON.stringify({ run_id, status: 'error', error: message }) + '\n');
    } else {
      io.stderr(`worker threw: ${message}\n`);
    }
    return 1;
  }

  // 5. Record completion
  const finished_at = Date.now();
  if (result.status === 'error' || result.status === 'timeout') {
    runStore.complete(run_id, {
      status: result.status,
      started_at,
      finished_at,
      duration_ms: result.duration_ms,
      exit_code: result.exit_code,
      token_usage: result.token_usage ?? null,
      error_code: result.error?.code ?? 'UNKNOWN',
      error_message: result.error?.message ?? '',
    });
  } else {
    runStore.complete(run_id, {
      status: 'success',
      started_at,
      finished_at,
      duration_ms: result.duration_ms,
      exit_code: result.exit_code,
      token_usage: result.token_usage ?? null,
    });
  }

  // 6. Output
  if (args.json) {
    io.stdout(JSON.stringify({
      run_id,
      status: result.status,
      output: result.output,
      duration_ms: result.duration_ms,
      exit_code: result.exit_code,
      token_usage: result.token_usage ?? null,
      // Agentic-worker metrics — populated when execution_model='tool_loop'.
      ...(result.iterations !== undefined ? { iterations: result.iterations } : {}),
      ...(result.tool_call_count !== undefined ? { tool_call_count: result.tool_call_count } : {}),
      error: result.error ? { code: result.error.code, message: result.error.message } : null,
    }) + '\n');
  } else {
    if (result.status === 'success') {
      io.stdout(result.output);
      if (!result.output.endsWith('\n')) io.stdout('\n');
      io.stderr(`\n[run ${run_id} done in ${result.duration_ms}ms]\n`);
    } else {
      io.stderr(`run ${run_id} ${result.status}: ${result.error?.message ?? 'no error message'}\n`);
      if (result.output) io.stdout(result.output + '\n');
    }
  }

  return result.status === 'success' ? 0 : 1;
}
