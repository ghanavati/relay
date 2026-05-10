/**
 * `relay memory consolidate` — scan the memory store for duplicates,
 * near-duplicates, and chronological supersessions; mark them via the
 * `superseded_by` column. See MemoryStore.consolidate() for algorithm.
 *
 * Flags:
 *   --dry-run                       analyze only, no mutation
 *   --json                          machine-readable output
 *   --similarity-threshold <0..1>   Jaccard threshold (default 0.85)
 *   --workdir <path>                restrict scan to a workdir (else all)
 */

import type { CliIO } from './commands.js';
import type { ConsolidateResult } from '../memory/memory-store.js';

export interface ConsolidateCommand {
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly similarityThreshold: number;
  readonly workdir?: string;
}

export async function executeMemoryConsolidateCommand(
  command: ConsolidateCommand,
  io: CliIO
): Promise<number> {
  if (
    !Number.isFinite(command.similarityThreshold) ||
    command.similarityThreshold < 0 ||
    command.similarityThreshold > 1
  ) {
    const msg = `--similarity-threshold must be a number in [0, 1] (got ${command.similarityThreshold})`;
    if (command.json) io.stdout(JSON.stringify({ error: msg }) + '\n');
    else io.stderr(msg + '\n');
    return 2;
  }

  const { MemoryStore } = await import('../memory/memory-store.js');
  const store = new MemoryStore();

  let result: ConsolidateResult;
  try {
    result = store.consolidate({
      dryRun: command.dryRun,
      similarityThreshold: command.similarityThreshold,
      workdir: command.workdir,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (command.json) io.stdout(JSON.stringify({ error: msg }) + '\n');
    else io.stderr(`consolidate failed: ${msg}\n`);
    return 1;
  }

  if (command.json) {
    io.stdout(JSON.stringify({
      groups_found: result.groups_found,
      duplicates: result.duplicates,
      supersessions: result.supersessions,
      kept: result.kept,
      marked: result.marked,
      dry_run: result.dry_run,
      similarity_threshold: result.similarity_threshold,
      actions: result.actions,
    }) + '\n');
    return 0;
  }

  io.stdout(renderHumanReport(result) + '\n');
  return 0;
}

function renderHumanReport(r: ConsolidateResult): string {
  const lines: string[] = [];
  const verb = r.dry_run ? 'Would consolidate' : 'Consolidated';
  lines.push(`${verb} memory store (threshold=${r.similarity_threshold}).`);
  lines.push(`  groups_found:  ${r.groups_found}`);
  lines.push(`  duplicates:    ${r.duplicates}`);
  lines.push(`  supersessions: ${r.supersessions}`);
  lines.push(`  kept:          ${r.kept}`);
  lines.push(`  marked:        ${r.marked}`);
  if (r.dry_run) lines.push(`  (dry-run — no changes written)`);

  if (r.actions.length > 0) {
    lines.push('');
    lines.push('Planned actions:');
    for (const a of r.actions.slice(0, 25)) {
      const sim = a.similarity.toFixed(2);
      lines.push(`  - [${a.kind}] ${a.memory_id} → ${a.superseded_by} (sim=${sim})`);
    }
    if (r.actions.length > 25) {
      lines.push(`  ... and ${r.actions.length - 25} more (use --json for full list)`);
    }
  }
  return lines.join('\n');
}
