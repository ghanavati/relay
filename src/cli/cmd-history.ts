import type { CliIO } from './commands.js';
import { c, statusBadge } from './colors.js';

export interface HistoryArgs {
  limit: number;
  provider?: string;
  status?: string;
  json: boolean;
}

interface RunRow {
  run_id: string;
  provider: string;
  model: string | null;
  status: string;
  queued_at: number;
  finished_at: number | null;
  duration_ms: number | null;
  task_excerpt: string | null;
  token_usage: number | null;
}

export async function executeHistoryCommand(args: HistoryArgs, io: CliIO): Promise<number> {
  try {
    const { getDb } = await import('../runtime/store/db.js');
    const db = getDb();

    const limit = args.limit > 0 ? args.limit : 10;

    const rows = db.prepare(`
      SELECT run_id, provider, model, status, queued_at, finished_at, duration_ms, task_excerpt, token_usage
      FROM runs
      WHERE (? IS NULL OR provider = ?)
        AND (? IS NULL OR status = ?)
      ORDER BY queued_at DESC
      LIMIT ?
    `).all(args.provider ?? null, args.provider ?? null, args.status ?? null, args.status ?? null, limit) as RunRow[];

    if (args.json) {
      for (const row of rows) io.stdout(JSON.stringify(row) + '\n');
    } else if (rows.length === 0) {
      io.stdout("No runs yet. Try: relay run 'task'\n");
    } else {
      io.stdout(c.dim(`relay history (showing ${rows.length} most recent)\n`));
      io.stdout(c.bold('RUN_ID    STATUS    PROVIDER    MODEL                         DURATION  TASK\n'));
      io.stdout(c.dim('────────────────────────────────────────────────────────────────────────────────\n'));

      for (const row of rows) {
        const runId = c.cyan(row.run_id.slice(0, 8));
        const status = statusBadge(row.status).padEnd(17);
        const provider = row.provider.padEnd(11);
        const model = (row.model ?? '').padEnd(28).slice(0, 28);
        const duration = formatDuration(row.duration_ms);
        const task = row.task_excerpt ?? '';
        io.stdout(`${runId}  ${status} ${provider} ${model}  ${duration.padEnd(8)}  ${task}\n`);
      }
    }

    return 0;
  } catch (error) {
    io.stderr(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function formatDuration(durationMs: number | null): string {
  if (durationMs == null) return '-';
  if (durationMs < 1000) return `${durationMs}ms`;
  const seconds = Math.floor(durationMs / 1000) % 60;
  const minutes = Math.floor(durationMs / 60000);
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}