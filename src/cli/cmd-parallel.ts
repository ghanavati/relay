/**
 * `relay parallel <spec.json>` — dispatch N tasks concurrently with bounded concurrency.
 *
 * Spec providers resolve through src/workers/provider-registry.ts (09-01
 * follow-up): the five builtins plus any RELAY_PROVIDER_<NAME>_* env-declared
 * endpoint. Runners come from the shared ./runner-factory.js mapping.
 */

import type { CliIO } from './commands.js';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { RunStore } from '../runtime/store/run-store.js';
import type { WorkerResult } from '../workers/types.js';
import { AGENTIC_SANDBOX_ENV } from '../security/env-sanitize.js';
import { resolveProvider, type ProviderConfig } from '../workers/provider-registry.js';
import { runnerForProvider, type RunnerFactoryOpts } from './runner-factory.js';

export interface ParallelArgs {
  specPath: string;
  maxConcurrency: number;
  json: boolean;
}

interface SpecTask {
  task: string;
  /** Registry-resolved provider name (builtin or RELAY_PROVIDER_* env-declared). */
  provider: string;
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

  // Resolve every spec provider through the registry BEFORE any run row
  // exists (mirrors cmd-run, DISPATCH-02): unknown names fail with the
  // available-provider list; builtin/env collisions error (D-04). The model
  // gate keys on the resolved wire type — only subprocess (codex) is exempt.
  const providerConfigs = new Map<string, ProviderConfig>();
  for (const [idx, t] of spec.tasks.entries()) {
    if (!t.task?.trim()) { io.stderr(`task[${idx}].task is empty\n`); return 2; }
    let config = providerConfigs.get(t.provider);
    if (!config) {
      try {
        config = resolveProvider(t.provider);
      } catch (err) {
        io.stderr(`task[${idx}].provider: ${(err as Error).message}\n`);
        return 2;
      }
      providerConfigs.set(t.provider, config);
    }
    if (config.type !== 'subprocess' && !t.model) { io.stderr(`task[${idx}].model required for provider=${t.provider}\n`); return 2; }
  }

  // 08-fix HIGH — if any task runs the agentic shell loop, mark this process as an
  // agentic sandbox so a model that shells into the `relay` CLI is refused mutating
  // control subcommands (shell_exec children inherit + force-inject the marker).
  if (spec.tasks.some((t) => t.provider === 'lmstudio-agentic')) {
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
        const config = providerConfigs.get(run.provider);
        if (!config) throw new Error(`unresolved provider: ${run.provider}`); // unreachable — validated above
        const factoryOpts: RunnerFactoryOpts = {};
        if (run.provider === 'lmstudio-agentic') {
          // Phase 7 — env-gated Figma REST tools. Null when PAT absent (FIGMA-03 graceful).
          const { registerFigmaTools } = await import('../tools/figma/index.js');
          const { loadPat } = await import('../tools/figma/pat-loader.js');
          const { homedir } = await import('node:os');
          const figmaHandlers = registerFigmaTools(process.env, homedir());
          const figmaPat = loadPat(process.env, homedir()) ?? '';
          if (figmaHandlers) {
            factoryOpts.agenticExtraToolHandlers = figmaHandlers.map((h) => ({
              name: h.def.function.name,
              pat: figmaPat,
              handle: h.handle as (a: unknown, c: { workdir: string; pat: string }) => Promise<unknown>,
            }));
          }
        }
        const runner = await runnerForProvider(config, factoryOpts);
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
        if (run.provider === 'lmstudio-agentic') {
          const { DEFAULT_AGENTIC_TOOLS } = await import('../workers/lmstudio-agentic.js');
          const { registerFigmaTools } = await import('../tools/figma/index.js');
          const { homedir } = await import('node:os');
          const figmaHandlers = registerFigmaTools(process.env, homedir());
          tools = figmaHandlers
            ? [...DEFAULT_AGENTIC_TOOLS, ...figmaHandlers.map((h) => h.def)]
            : DEFAULT_AGENTIC_TOOLS;
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
        const finished_at = Date.now();
        store.complete(run.run_id, {
          status: result.status,
          started_at,
          finished_at,
          duration_ms: result.duration_ms,
          exit_code: result.exit_code,
          token_usage: result.token_usage ?? null,
          // Review fix 3: full uniform usage receipt, matching cmd-run (DISPATCH-04).
          prompt_tokens: result.prompt_tokens ?? null,
          completion_tokens: result.completion_tokens ?? null,
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
