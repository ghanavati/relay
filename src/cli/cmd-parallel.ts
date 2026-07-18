/**
 * `relay parallel <spec.json>` — dispatch N tasks concurrently with bounded concurrency.
 */

import type { CliIO } from './commands.js';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { RunStore } from '../runtime/store/run-store.js';
import type { WorkerRunner } from '../workers/runner.js';
import type { WorkerResult } from '../workers/types.js';
import { AGENTIC_SANDBOX_ENV } from '../security/env-sanitize.js';

export interface ParallelArgs {
  specPath: string;
  maxConcurrency: number;
  json: boolean;
}

interface SpecTask {
  task: string;
  provider: 'codex' | 'lmstudio' | 'openrouter' | 'anthropic' | 'lmstudio-agentic' | 'omlx-agentic';
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

interface AgenticRunContext {
  run_id: string;
  workdir: string;
  model?: string;
  label: string;
}

async function getRunner(
  provider: SpecTask['provider'],
  agentic?: AgenticRunContext,
): Promise<WorkerRunner> {
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
  if (provider === 'lmstudio-agentic' || provider === 'omlx-agentic') {
    if (!agentic) throw new Error(`${provider} requires run context`);
    const { LmStudioAgenticRunner } = await import('../workers/lmstudio-agentic.js');
    const { OmlxAgenticRunner } = await import('../workers/omlx-agentic.js');
    // Phase 7 — env-gated Figma REST tools. Null when PAT absent (FIGMA-03 graceful).
    const { registerFigmaTools } = await import('../tools/figma/index.js');
    const { loadPat } = await import('../tools/figma/pat-loader.js');
    const { homedir } = await import('node:os');
    const figmaHandlers = registerFigmaTools(process.env, homedir());
    const figmaPat = loadPat(process.env, homedir()) ?? '';
    const extraToolHandlers = figmaHandlers
      ? figmaHandlers.map((h) => ({
          name: h.def.function.name,
          pat: figmaPat,
          handle: h.handle as (a: unknown, c: { workdir: string; pat: string }) => Promise<unknown>,
        }))
      : undefined;
    const { createControlSessionForRun, registerControlTools, toNamedToolHandlers } =
      await import('../control/tools.js');
    createControlSessionForRun(agentic);
    const controlHandlers = toNamedToolHandlers(registerControlTools(agentic.run_id));
    const opts = {
      extraToolHandlers: [...(extraToolHandlers ?? []), ...controlHandlers],
    };
    return provider === 'omlx-agentic' ? new OmlxAgenticRunner(opts) : new LmStudioAgenticRunner(opts);
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

function sharedAgenticWorkdir(tasks: readonly SpecTask[], cwd: string): string | null {
  const seen = new Set<string>();
  for (const task of tasks) {
    if (task.provider !== 'lmstudio-agentic' && task.provider !== 'omlx-agentic') continue;
    const workdir = resolve(task.workdir ?? cwd);
    if (seen.has(workdir)) return workdir;
    seen.add(workdir);
  }
  return null;
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

  const validProviders = new Set(['codex', 'lmstudio', 'openrouter', 'anthropic', 'lmstudio-agentic', 'omlx-agentic']);
  const httpProviders = new Set(['lmstudio', 'openrouter', 'anthropic', 'lmstudio-agentic', 'omlx-agentic']);
  for (const [idx, t] of spec.tasks.entries()) {
    if (!t.task?.trim()) { io.stderr(`task[${idx}].task is empty\n`); return 2; }
    if (!validProviders.has(t.provider)) { io.stderr(`task[${idx}].provider must be codex|lmstudio|openrouter|anthropic|lmstudio-agentic\n`); return 2; }
    if (httpProviders.has(t.provider) && !t.model) { io.stderr(`task[${idx}].model required for provider=${t.provider}\n`); return 2; }
  }

  const sharedWorkdir = sharedAgenticWorkdir(spec.tasks, io.cwd);
  if (sharedWorkdir) {
    io.stderr(`agentic parallel tasks require a separate workdir per task; duplicate: ${sharedWorkdir}\n`);
    return 2;
  }

  // 08-fix HIGH — if any task runs the agentic shell loop, mark this process as an
  // agentic sandbox so a model that shells into the `relay` CLI is refused mutating
  // control subcommands (shell_exec children inherit + force-inject the marker).
  if (spec.tasks.some((t) => t.provider === 'lmstudio-agentic' || t.provider === 'omlx-agentic')) {
    process.env[AGENTIC_SANDBOX_ENV] = '1';
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
    return { ...t, run_id, workdir, timeout_ms, task_excerpt };
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
        const runner = await getRunner(run.provider, {
          run_id: run.run_id,
          workdir: run.workdir,
          model: run.model,
          label: run.task_excerpt,
        });
        const { buildDelegatedTask } = await import('../context/layers.js');
        const built = await buildDelegatedTask({
          workdir: run.workdir,
          task: run.task,
          run_id: run.run_id,
        });
        // Inject default agentic tools when dispatching to lmstudio-agentic so the
        // runner has a shell_exec tool to offer the model. Worker rejects empty tools[].
        // Phase 7: when registerFigmaTools returned handlers, merge their ToolDefs.
        let tools;
        if (run.provider === 'lmstudio-agentic' || run.provider === 'omlx-agentic') {
          const { DEFAULT_AGENTIC_TOOLS } = await import('../workers/lmstudio-agentic.js');
          const { registerFigmaTools } = await import('../tools/figma/index.js');
          const { CONTROL_TOOL_DEFS } = await import('../control/tools.js');
          const { homedir } = await import('node:os');
          const figmaHandlers = registerFigmaTools(process.env, homedir());
          tools = figmaHandlers
            ? [...DEFAULT_AGENTIC_TOOLS, ...figmaHandlers.map((h) => h.def), ...CONTROL_TOOL_DEFS]
            : [...DEFAULT_AGENTIC_TOOLS, ...CONTROL_TOOL_DEFS];
        }
        const result = await runner.run({
          task: built.bareTask,
          contextPrefix: built.contextPrefix,
          workdir: run.workdir,
          timeout_ms: run.timeout_ms,
          model: run.model,
          reasoning_effort: run.reasoning_effort,
          run_id: run.run_id,
          provider: run.provider,
          ...(tools ? { tools } : {}),
        });
        if (run.provider === 'lmstudio-agentic' || run.provider === 'omlx-agentic') {
          const { endControlSessionForRun } = await import('../control/tools.js');
          endControlSessionForRun(run.run_id);
        }
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
          ...(result.error ? { error: result.error.message } : {}),
          provider: run.provider,
          model: run.model ?? null,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (run.provider === 'lmstudio-agentic' || run.provider === 'omlx-agentic') {
          const { endControlSessionForRun } = await import('../control/tools.js');
          endControlSessionForRun(run.run_id);
        }
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
