/**
 * `relay parallel <spec.json>` — dispatch N tasks concurrently with bounded concurrency.
 */

import type { CliIO } from './commands.js';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { RunStore } from '../runtime/store/run-store.js';
import type { WorkerRunner } from '../workers/runner.js';
import type { WorkerResult } from '../workers/types.js';

export interface ParallelArgs {
  specPath: string;
  maxConcurrency: number;
  json: boolean;
}

interface SpecTask {
  task: string;
  provider: 'codex' | 'lmstudio' | 'openrouter' | 'anthropic';
  model?: string;
  workdir?: string;
  timeout_ms?: number;
  reasoning_effort?: string;
}

interface RunOutcome {
  run_id: string;
  status: WorkerResult['status'] | 'error';
  duration_ms?: number;
  output?: string;
  error?: string;
  provider: string;
  model: string | null;
}

async function getRunner(provider: SpecTask['provider']): Promise<WorkerRunner> {
  if (provider === 'codex') {
    const { CodexRunner } = await import('../workers/codex.js');
    return new CodexRunner();
  }
  if (provider === 'lmstudio') {
    const { LmStudioRunner } = await import('../workers/lmstudio.js');
    return new LmStudioRunner();
  }
  if (provider === 'openrouter') {
    const { OpenRouterRunner } = await import('../workers/openrouter.js');
    return new OpenRouterRunner();
  }
  if (provider === 'anthropic') {
    const { AnthropicRunner } = await import('../workers/anthropic.js');
    return new AnthropicRunner();
  }
  throw new Error(`unsupported provider: ${provider as string}`);
}

async function runWithLimit<T, R>(
  limit: number,
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const lanes = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) break;
        results[i] = await fn(items[i] as T, i);
      }
    })
  );
  return results;
}

function fmtDuration(ms: number | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export async function executeParallelCommand(args: ParallelArgs, io: CliIO): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(args.specPath, 'utf-8');
  } catch (err) {
    io.stderr(`could not read spec file ${args.specPath}: ${(err as Error).message}\n`);
    return 2;
  }

  let spec: { tasks: SpecTask[] };
  try {
    spec = JSON.parse(raw) as { tasks: SpecTask[] };
  } catch (err) {
    io.stderr(`spec file is not valid JSON: ${(err as Error).message}\n`);
    return 2;
  }

  if (!Array.isArray(spec.tasks) || spec.tasks.length === 0) {
    io.stderr('spec must contain non-empty tasks[] array\n');
    return 2;
  }

  const validProviders = new Set(['codex', 'lmstudio', 'openrouter', 'anthropic']);
  const httpProviders = new Set(['lmstudio', 'openrouter', 'anthropic']);
  for (const [idx, t] of spec.tasks.entries()) {
    if (!t.task?.trim()) { io.stderr(`task[${idx}].task is empty\n`); return 2; }
    if (!validProviders.has(t.provider)) { io.stderr(`task[${idx}].provider must be codex|lmstudio|openrouter|anthropic\n`); return 2; }
    if (httpProviders.has(t.provider) && !t.model) { io.stderr(`task[${idx}].model required for provider=${t.provider}\n`); return 2; }
  }

  const store = new RunStore();
  const runs = spec.tasks.map(t => {
    const run_id = randomUUID();
    const workdir = t.workdir ?? io.cwd;
    const timeout_ms = t.timeout_ms ?? 300_000;
    const task_excerpt = t.task.length > 200 ? t.task.slice(0, 200) + '…' : t.task;
    store.create({
      run_id,
      provider: t.provider,
      model: t.model ?? null,
      workdir,
      status: 'queued',
      queued_at: Date.now(),
      task_excerpt,
      timeout_ms,
    });
    return { ...t, run_id, workdir, timeout_ms };
  });

  if (!args.json) {
    io.stdout(`relay parallel: dispatching ${runs.length} tasks (max-concurrency ${args.maxConcurrency})\n\n`);
  }

  const outcomes = await runWithLimit<typeof runs[number], RunOutcome>(
    args.maxConcurrency,
    runs,
    async (run, idx) => {
      const started_at = Date.now();
      store.recordEvent(run.run_id, 'started', { provider: run.provider, model: run.model ?? null });

      try {
        const runner = await getRunner(run.provider);
        const result = await runner.run({
          task: run.task,
          workdir: run.workdir,
          timeout_ms: run.timeout_ms,
          model: run.model,
          reasoning_effort: run.reasoning_effort,
          run_id: run.run_id,
          provider: run.provider,
        });
        const finished_at = Date.now();
        store.complete(run.run_id, {
          status: result.status,
          started_at,
          finished_at,
          duration_ms: result.duration_ms,
          exit_code: result.exit_code,
          token_usage: result.token_usage ?? null,
          ...(result.error ? { error_code: result.error.code, error_message: result.error.message } : {}),
        });
        if (!args.json) {
          const shortId = run.run_id.slice(0, 8);
          const tag = `${run.provider}/${run.model ?? '(default)'}`;
          io.stdout(`[${idx + 1}/${runs.length}] ${shortId}... ${tag.padEnd(34)} ${result.status.padEnd(8)} ${fmtDuration(result.duration_ms)}\n`);
        }
        return {
          run_id: run.run_id,
          status: result.status,
          duration_ms: result.duration_ms,
          output: result.output,
          provider: run.provider,
          model: run.model ?? null,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        store.recordError(run.run_id, { error_code: 'WORKER_THREW', error_message: message, finished_at: Date.now() });
        if (!args.json) {
          const shortId = run.run_id.slice(0, 8);
          io.stdout(`[${idx + 1}/${runs.length}] ${shortId}... ERROR ${message}\n`);
        }
        return { run_id: run.run_id, status: 'error', error: message, provider: run.provider, model: run.model ?? null };
      }
    }
  );

  const summary = {
    success: outcomes.filter(o => o.status === 'success').length,
    error: outcomes.filter(o => o.status === 'error').length,
    timeout: outcomes.filter(o => o.status === 'timeout').length,
    total: outcomes.length,
  };

  if (args.json) {
    io.stdout(JSON.stringify({ runs: outcomes, summary }) + '\n');
  } else {
    io.stdout(`\nSummary: ${summary.success} success, ${summary.timeout} timeout, ${summary.error} error\n`);
  }

  return summary.success === summary.total ? 0 : 1;
}
