/**
 * `relay memory tag-stats` — per-tag analytics across the memory store.
 *
 * For every unique tag attached to an active (non-superseded) memory, reports:
 *   - memory_count        number of memories carrying the tag
 *   - total_recall_count  SUM(recall_count) for those memories
 *   - last_used_at        MAX(accessed_at) for those memories (null if none)
 *
 * Sorted by memory_count DESC; default cap of 20 rows (override with --limit).
 *
 * Flags:
 *   --workdir <path>   restrict scan to memories in that workdir
 *                      (workdir = path OR workdir IS NULL)
 *   --limit <N>        cap output rows (default 20; 0 / negative ⇒ no cap)
 *   --json             machine-readable output (full row schema)
 */

import type { CliIO } from './commands.js';
import type { TagStatEntry } from '../memory/memory-store.js';

export interface MemoryTagStatsCommand {
  readonly workdir: string | undefined;
  readonly limit: number;
  readonly json: boolean;
}

export const DEFAULT_TAG_STATS_LIMIT = 20;

export async function executeMemoryTagStatsCommand(
  command: MemoryTagStatsCommand,
  io: CliIO
): Promise<number> {
  if (!Number.isFinite(command.limit)) {
    const msg = `--limit must be a finite number (got ${command.limit})`;
    if (command.json) io.stdout(JSON.stringify({ error: msg }) + '\n');
    else io.stderr(msg + '\n');
    return 2;
  }

  const { MemoryStore } = await import('../memory/memory-store.js');
  const store = new MemoryStore();

  let rows: TagStatEntry[];
  try {
    const opts = command.workdir !== undefined ? { workdir: command.workdir } : {};
    rows = store.tagStats(opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (command.json) io.stdout(JSON.stringify({ error: msg }) + '\n');
    else io.stderr(`tag-stats failed: ${msg}\n`);
    return 1;
  }

  const limited = command.limit > 0 ? rows.slice(0, command.limit) : rows;

  if (command.json) {
    io.stdout(JSON.stringify({
      total_tags: rows.length,
      returned: limited.length,
      limit: command.limit,
      workdir: command.workdir ?? null,
      tags: limited,
    }) + '\n');
    return 0;
  }

  if (rows.length === 0) {
    io.stdout('No tagged memories found.\n');
    return 0;
  }

  io.stdout(renderHumanReport(limited, { totalTags: rows.length, workdir: command.workdir }) + '\n');
  return 0;
}

function renderHumanReport(
  rows: readonly TagStatEntry[],
  meta: { totalTags: number; workdir: string | undefined }
): string {
  const lines: string[] = [];
  const scope = meta.workdir ? ` (workdir=${meta.workdir})` : '';
  lines.push(`Tag analytics${scope}: showing ${rows.length} of ${meta.totalTags} tag${meta.totalTags === 1 ? '' : 's'}`);
  lines.push('');
  lines.push(formatRow('TAG', 'MEMORIES', 'RECALLS', 'LAST USED'));
  lines.push(formatRow('---', '--------', '-------', '---------'));
  for (const row of rows) {
    lines.push(formatRow(
      row.tag,
      String(row.memory_count),
      String(row.total_recall_count),
      formatTimestamp(row.last_used_at),
    ));
  }
  return lines.join('\n');
}

function formatRow(tag: string, memories: string, recalls: string, lastUsed: string): string {
  // Truncate over-long tags so the table stays readable in a typical terminal.
  const tagCol = tag.length > 36 ? tag.slice(0, 33) + '...' : tag;
  return `  ${tagCol.padEnd(38)}${memories.padStart(8)}  ${recalls.padStart(7)}  ${lastUsed}`;
}

function formatTimestamp(ms: number | null): string {
  if (ms === null) return '-';
  try {
    return new Date(ms).toISOString();
  } catch {
    return '-';
  }
}
