/**
 * `relay memory why <memory_id> [--json]` — explain why a memory ranks the way it does.
 *
 * Prints a per-component breakdown of the relevance score using
 * `scoreMemoryDetailed` (against an empty-query baseline) plus the last 5
 * surfacings from the `memory_reads` audit log. Useful when triaging unexpected
 * recall results or auditing trust-tier promotions.
 */

import type { CliIO } from './commands.js';
import { MemoryStore } from '../memory/memory-store.js';
import { scoreMemoryDetailed, type ScoreComponents } from '../memory/memory-engine.js';
import { getDb } from '../runtime/store/db.js';
import type { Memory, RecallQuery } from '../memory/types.js';

interface MemoryReadRow {
  readonly memory_id: string;
  readonly run_id: string | null;
  readonly read_source: string;
  readonly workdir: string | null;
  readonly created_at: number;
}

function getRecentReads(memoryId: string, limit: number = 5): MemoryReadRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT memory_id, run_id, read_source, workdir, created_at
       FROM memory_reads
       WHERE memory_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(memoryId, limit) as MemoryReadRow[];
}

function formatTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function renderComponentLine(label: string, value: number, width: number): string {
  // Bar length proportional to absolute contribution. Cap at 30 chars.
  const bars = Math.max(0, Math.min(30, Math.round(Math.abs(value) * 30)));
  const bar = '#'.repeat(bars);
  const padded = label.padEnd(width, ' ');
  return `  ${padded} ${value.toFixed(4).padStart(8, ' ')}  ${bar}`;
}

function renderTextOutput(memory: Memory, breakdown: { total: number; components: ScoreComponents }, reads: MemoryReadRow[]): string {
  const lines: string[] = [];
  lines.push(`Memory ${memory.memory_id}`);
  lines.push('');
  lines.push('METADATA');
  lines.push(`  type:           ${memory.memory_type}`);
  lines.push(`  workdir:        ${memory.workdir ?? '(global)'}`);
  lines.push(`  pinned:         ${memory.pinned ? 'yes' : 'no'}`);
  lines.push(`  trust_level:    ${memory.trust_level}`);
  lines.push(`  memory_source:  ${memory.memory_source}`);
  lines.push(`  recall_count:   ${memory.recall_count}`);
  lines.push(`  success_count:  ${memory.success_recall_count}`);
  lines.push(`  tags:           ${memory.tags.length > 0 ? memory.tags.join(', ') : '(none)'}`);
  lines.push(`  token_count:    ${memory.token_count}`);
  lines.push(`  created:        ${formatTimestamp(memory.created_at)}`);
  lines.push(`  last_accessed:  ${formatTimestamp(memory.accessed_at)}`);
  lines.push(`  expires_at:     ${memory.expires_at ? formatTimestamp(memory.expires_at) : '(never)'}`);
  lines.push('');
  lines.push('CONTENT');
  const preview = memory.content.length > 200 ? memory.content.slice(0, 200) + '…' : memory.content;
  for (const line of preview.split('\n')) lines.push(`  ${line}`);
  lines.push('');
  lines.push('SCORE BREAKDOWN (empty-query baseline)');
  const width = 9; // longest component label
  lines.push(renderComponentLine('tag', breakdown.components.tag, width));
  lines.push(renderComponentLine('content', breakdown.components.content, width));
  lines.push(renderComponentLine('recency', breakdown.components.recency, width));
  lines.push(renderComponentLine('type', breakdown.components.type, width));
  lines.push(renderComponentLine('pin', breakdown.components.pin, width));
  lines.push(renderComponentLine('trust', breakdown.components.trust, width));
  lines.push(renderComponentLine('success', breakdown.components.success, width));
  lines.push(`  ${'TOTAL'.padEnd(width, ' ')} ${breakdown.total.toFixed(4).padStart(8, ' ')}`);
  lines.push('');
  lines.push(`RECENT SURFACINGS (last ${Math.min(5, reads.length)} of ${reads.length})`);
  if (reads.length === 0) {
    lines.push('  (no recorded reads — this memory has not been surfaced yet)');
  } else {
    for (const r of reads) {
      const ts = formatTimestamp(r.created_at);
      const run = r.run_id ?? '(no run)';
      const wd = r.workdir ?? '(global)';
      lines.push(`  ${ts}  source=${r.read_source}  run=${run}  workdir=${wd}`);
    }
  }
  return lines.join('\n') + '\n';
}

export function executeMemoryWhyCommand(
  command: { memoryId: string; json: boolean },
  io: CliIO
): number {
  const store = new MemoryStore();
  const memory = store.getMemory(command.memoryId);
  if (!memory) {
    if (command.json) {
      io.stdout(JSON.stringify({ error: 'not_found', memory_id: command.memoryId }) + '\n');
    } else {
      io.stderr(`Memory ${command.memoryId} not found\n`);
    }
    return 1;
  }

  // Empty-query baseline — surfaces the structural score (recency + type + pin + trust + success).
  // Tag and content components evaluate to 0 because the query has neither.
  const query: RecallQuery = { token_budget: 0 };
  const breakdown = scoreMemoryDetailed(memory, query, Date.now());
  const reads = getRecentReads(command.memoryId, 5);

  if (command.json) {
    io.stdout(JSON.stringify({
      memory_id: memory.memory_id,
      memory_type: memory.memory_type,
      workdir: memory.workdir,
      pinned: memory.pinned,
      trust_level: memory.trust_level,
      memory_source: memory.memory_source,
      recall_count: memory.recall_count,
      success_recall_count: memory.success_recall_count,
      tags: memory.tags,
      token_count: memory.token_count,
      created_at: memory.created_at,
      accessed_at: memory.accessed_at,
      expires_at: memory.expires_at,
      content: memory.content,
      score: {
        total: breakdown.total,
        components: breakdown.components,
        baseline: 'empty-query',
      },
      recent_reads: reads.map(r => ({
        run_id: r.run_id,
        read_source: r.read_source,
        workdir: r.workdir,
        created_at: r.created_at,
      })),
    }) + '\n');
    return 0;
  }

  io.stdout(renderTextOutput(memory, breakdown, reads));
  return 0;
}
