/**
 * `relay compare <run_a> <run_b>` — side-by-side run comparison.
 */

import type { CliIO } from './commands.js';
import { RunStore } from '../runtime/store/run-store.js';
import type { RunRow } from '../runtime/store/run-store.js';

export interface CompareArgs { runA: string; runB: string; json: boolean; }

function shortId(id: string): string { return id.slice(0, 8) + '...'; }
function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = ((ms % 60_000) / 1000).toFixed(1);
  return `${m}m ${s}s`;
}

function parseFiles(json: string | null | undefined): string[] {
  if (!json) return [];
  try { return JSON.parse(json) as string[]; } catch { return []; }
}

export async function executeCompareCommand(args: CompareArgs, io: CliIO): Promise<number> {
  const store = new RunStore();
  const a = store.getRun(args.runA);
  const b = store.getRun(args.runB);

  if (!a) { io.stderr(`run ${args.runA} not found\n`); return 1; }
  if (!b) { io.stderr(`run ${args.runB} not found\n`); return 1; }

  const aFiles = parseFiles(a.files_changed_json);
  const bFiles = parseFiles(b.files_changed_json);
  const aSet = new Set(aFiles);
  const bSet = new Set(bFiles);
  const onlyA = aFiles.filter(f => !bSet.has(f));
  const onlyB = bFiles.filter(f => !aSet.has(f));
  const shared = aFiles.filter(f => bSet.has(f));

  if (args.json) {
    const slim = (r: RunRow) => ({
      run_id: r.run_id,
      provider: r.provider,
      model: r.model,
      status: r.status,
      duration_ms: r.duration_ms ?? null,
      token_usage: r.token_usage ?? null,
      exit_code: r.exit_code ?? null,
      files: parseFiles(r.files_changed_json),
    });
    io.stdout(JSON.stringify({
      a: slim(a),
      b: slim(b),
      files_only_in_a: onlyA,
      files_only_in_b: onlyB,
      files_changed_in_both: shared,
    }) + '\n');
    return 0;
  }

  io.stdout(`run ${shortId(a.run_id)} vs ${shortId(b.run_id)}\n\n`);
  const rows: Array<[string, string, string]> = [
    ['', 'A', 'B'],
    ['provider', a.provider, b.provider],
    ['model', a.model ?? '—', b.model ?? '—'],
    ['status', a.status, b.status],
    ['duration', fmtDuration(a.duration_ms), fmtDuration(b.duration_ms)],
    ['tokens', String(a.token_usage ?? '—'), String(b.token_usage ?? '—')],
    ['files', `${aFiles.length} changed`, `${bFiles.length} changed`],
    ['exit_code', String(a.exit_code ?? '—'), String(b.exit_code ?? '—')],
  ];
  for (const [label, av, bv] of rows) {
    io.stdout(`  ${label.padEnd(12)} ${av.padEnd(28)} ${bv}\n`);
  }
  io.stdout('\nFiles only in A:\n');
  if (onlyA.length === 0) io.stdout('  (none)\n');
  else for (const f of onlyA) io.stdout(`  ${f}\n`);
  io.stdout('\nFiles only in B:\n');
  if (onlyB.length === 0) io.stdout('  (none)\n');
  else for (const f of onlyB) io.stdout(`  ${f}\n`);
  io.stdout('\nFiles changed in both:\n');
  if (shared.length === 0) io.stdout('  (none)\n');
  else for (const f of shared) io.stdout(`  ${f}\n`);

  return 0;
}
