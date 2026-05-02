import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { CliIO } from './commands.js';

export interface ParallelArgs {
  specPath: string;
  maxConcurrency: number;
  json: boolean;
}

export async function executeParallelCommand(args: ParallelArgs, io: CliIO): Promise<number> {
  const specRaw = await readFile(args.specPath, 'utf-8');
  const spec = JSON.parse(specRaw) as { tasks: Array<{ task: string, provider: string, model?: string, workdir: string, timeout_ms?: number }> };
  if (!Array.isArray(spec.tasks) || spec.tasks.length === 0) {
    io.stderr('Spec must contain non-empty tasks[] array
');
    return 2;
  }

  const store = new RunStore();
  const runs = spec.tasks.map(t => ({
    run_id: randomUUID(),
    provider: t.provider,
    model: t.model ?? null,
    workdir: t.workdir,
    status: 'queued',
    queued_at: Date.now(),
    task_excerpt: t.task.slice(0, 200),
    timeout_ms: t.timeout_ms ?? 300000
  }));

  const results = await runWithLimit(args.maxConcurrency, runs, async (run) => {
    const started_at = Date.now();
    store.recordEvent(run.run_id, 'started', { provider: run.provider, model: run.model });
    try {
      const runner = await getRunner(run.provider);
      const result = await runner.run({ ...run, run_id: run.run_id });
      const finished_at = Date.now();
      store.complete(run.run_id, { status: result.status, started_at, finished_at, duration_ms: result.duration_ms, exit_code: result.exit_code, token_usage: result.token_usage ?? null });
      return { run_id: run.run_id, status: result.status, output: result.output, duration_ms: result.duration_ms };
    } catch (err) {
      store.recordError(run.run_id, { error_code: 'WORKER_THROW', error_message: (err as Error).message, finished_at: Date.now() });
      return { run_id: run.run_id, status: 'error', error: (err as Error).message };
    }
  });

  const summary = results.reduce((acc, r) => {
    if (r.status === 'success') acc.success += 1;
    else if (r.status === 'error') acc.error += 1;
    else if (r.status === 'timeout') acc.timeout += 1;
    acc.total += 1;
    return acc;
  }, { success: 0, error: 0, timeout: 0, total: results.length });

  if (summary.success === results.length) {
    io.stdout(JSON.stringify({ runs: results, summary }));
  } else {
    io.stderr('Summary:', summary);
  }
  return summary.error + (summary.timeout || 0) > 0 ? 1 : (summary.total === 0 ? 0 : 2);
}

async function runWithLimit<T, R>(limit: number, items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function getRunner(provider: string) {
  if (provider === 'codex') { const { CodexRunner } = await import('../workers/codex.js'); return new CodexRunner(); }
  if (provider === 'lmstudio') { const { LmStudioRunner } = await import('../workers/lmstudio.js'); return new LmStudioRunner(); }
  if (provider === 'openrouter') { const { OpenRouterRunner } = await import('../workers/openrouter.js'); return new OpenRouterRunner(); }
  throw new Error(`Unsupported provider: ${provider}`);
}