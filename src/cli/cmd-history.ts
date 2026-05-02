import type { CliIO } from './commands.js';

export interface HistoryArgs {
  limit: number;
  provider?: string;
  status?: string;
  json: boolean;
}

export async function executeHistoryCommand(args: HistoryArgs, io: CliIO): Promise<number> {
  try {
    const { getDb } = await import('../runtime/store/db.js');
    const db = getDb();

    let limit = args.limit;
    if (limit === 0) {
      limit = 10;
    }

    const rows = db.prepare(`
      SELECT run_id, provider, model, status, queued_at, finished_at, duration_ms, task_excerpt, token_usage
      FROM runs
      WHERE (? IS NULL OR provider = ?)
        AND (? IS NULL OR status = ?)
      ORDER BY queued_at DESC
      LIMIT ?
    `).all(args.provider ?? null, args.provider ?? null, args.status ?? null, args.status ?? null, limit) as any[];

    if (args.json) {
      io.stdout(JSON.stringify({ runs: rows, count: rows.length }, null, 2));
    } else {
      if (rows.length === 0) {
        io.stdout('No runs yet. Try: relay run \'task\'');
      } else {
        io.stdout(`relay history (showing ${rows.length} most recent)\n`);

        io.stdout('RUN_ID     STATUS    PROVIDER   MODEL                       DURATION  TASK\n');
        io.stdout('────────────────────────────────────────────────────────────────────────\n');

        for (const row of rows) {
          const runId = (row.run_id as string).slice(0, 8);
          const status = (row.status as string).padEnd(9);
          const provider = (row.provider as string).padEnd(10);
          const model = (row.model as string || '').padEnd(28).slice(0, 28);
          const duration = formatDuration(row.duration_ms as number | null);
          const task = row.task_excerpt as string || '';

          io.stdout(`${runId}   ${status}   ${provider}   ${model.padEnd(28).slice(0, 28).padEnd(28)}  ${duration}  ${task}\n`);
        }
      }
    }

    return 0;
  } catch (error) {
    io.stderr(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function formatDuration(durationMs: number | null): string {
  if (durationMs == null) {
    return '-';
  }

  const ms = durationMs % 1000;
  const seconds = Math.floor(durationMs / 1000) % 60;
  const minutes = Math.floor(durationMs / 60000);

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${durationMs / 1000}s`;
}