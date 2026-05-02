import type { CliIO } from './commands.js';

interface PerRunProfile {
  run_id: string;
  provider: string | null;
  model: string | null;
  status: string | null;
  files_changed: string[];
  unique_files: string[];
}

interface CompareResult {
  run_ids: string[];
  files_union: string[];
  files_intersection: string[];
  files_diverged: string[];
  per_run: PerRunProfile[];
  divergence_score: number;
  agreement_score: number;
}

export async function executeCompareCommand(
  command: {
    runIds: string[];
    json: boolean;
  },
  io: CliIO
): Promise<number> {
  const { handleCompareRuns } = await import('../tools/compare-runs.js');
  const response = handleCompareRuns({ run_ids: command.runIds }) as { content: Array<{ type: string; text: string }>; isError?: boolean };
  const text = response.content[0]?.text ?? '{}';
  if (command.json) {
    io.stdout(`${text}\n`);
    return response.isError ? 1 : 0;
  }
  if (response.isError) {
    io.stderr(`compare failed: ${text}\n`);
    return 1;
  }
  const result = JSON.parse(text) as CompareResult;
  const pct = Math.round(result.agreement_score * 100);
  io.stdout(`Agreement: ${pct}% | Divergence score: ${result.divergence_score.toFixed(3)}\n`);
  io.stdout(`Files union: ${result.files_union.length} · intersection: ${result.files_intersection.length} · diverged: ${result.files_diverged.length}\n`);
  if (result.files_diverged.length > 0) {
    io.stdout(`\nDiverged files:\n`);
    for (const f of result.files_diverged) io.stdout(`  ${f}\n`);
  }
  io.stdout(`\nPer-run:\n`);
  for (const r of result.per_run) {
    io.stdout(`  ${r.run_id.slice(0, 8)} [${r.provider ?? '?'}/${r.model ?? '?'}] ${r.status ?? '?'} — ${r.files_changed.length} files (${r.unique_files.length} unique)\n`);
  }
  return 0;
}

export function formatCompareTitle(runIdA: string, runIdB: string): string {
  return `Compare: ${runIdA} vs ${runIdB}`;
}