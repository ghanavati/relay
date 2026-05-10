/**
 * `relay memory search <regex>` — exact regex content search.
 *
 * Companion to `relay memory recall <query>` (FTS-scored). This command runs a
 * literal JavaScript RegExp against `memories.content`, so callers can grep for
 * exact phrasing, anchors, character classes, etc. better-sqlite3 has no native
 * regex function, so matching happens in JS after a workdir/superseded prefilter.
 *
 * Flags:
 *   --workdir <path>  restrict to a workdir (NULL workdir always included)
 *   --limit <N>       cap output rows (default 50, hard ceiling 1000)
 *   --json            structured array output
 *
 * Exit codes:
 *   0 — search completed (zero hits is still success)
 *   1 — runtime failure (DB error, etc.)
 *   2 — invalid arguments (missing pattern, bad regex, bad --limit)
 */

import type { CliIO } from './commands.js';
import { c } from './colors.js';

export interface MemorySearchCommand {
  readonly pattern: string;
  readonly workdir?: string;
  readonly limit: number;
  readonly json: boolean;
}

const DEFAULT_LIMIT = 50;
const HARD_LIMIT = 1000;

interface SearchHit {
  readonly memory_id: string;
  readonly created_at: number;
  readonly memory_type: string;
  readonly workdir: string | null;
  readonly content: string;
  readonly match: { start: number; end: number };
}

export async function executeMemorySearchCommand(
  command: MemorySearchCommand,
  io: CliIO
): Promise<number> {
  if (!command.pattern || command.pattern.trim().length === 0) {
    return fail(io, command.json, 'relay memory search requires a <regex> pattern', 2);
  }
  if (!Number.isFinite(command.limit) || command.limit < 1) {
    return fail(io, command.json, `--limit must be a positive integer (got ${command.limit})`, 2);
  }
  const limit = Math.min(Math.floor(command.limit), HARD_LIMIT);

  let regex: RegExp;
  try {
    regex = new RegExp(command.pattern);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(io, command.json, `invalid regex: ${msg}`, 2);
  }

  let rows: Array<{ memory_id: string; created_at: number; memory_type: string; workdir: string | null; content: string }>;
  try {
    const { getDb } = await import('../runtime/store/db.js');
    const db = getDb();
    const sql = command.workdir
      ? `SELECT memory_id, created_at, memory_type, workdir, content
         FROM memories
         WHERE superseded_by IS NULL AND (workdir = ? OR workdir IS NULL)
         ORDER BY created_at DESC`
      : `SELECT memory_id, created_at, memory_type, workdir, content
         FROM memories
         WHERE superseded_by IS NULL
         ORDER BY created_at DESC`;
    rows = command.workdir
      ? (db.prepare(sql).all(command.workdir) as typeof rows)
      : (db.prepare(sql).all() as typeof rows);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(io, command.json, `search failed: ${msg}`, 1);
  }

  const hits: SearchHit[] = [];
  for (const row of rows) {
    const m = regex.exec(row.content);
    if (!m) continue;
    hits.push({
      memory_id: row.memory_id,
      created_at: row.created_at,
      memory_type: row.memory_type,
      workdir: row.workdir,
      content: row.content,
      match: { start: m.index, end: m.index + m[0].length },
    });
    if (hits.length >= limit) break;
  }

  if (command.json) {
    io.stdout(JSON.stringify({
      pattern: command.pattern,
      workdir: command.workdir ?? null,
      limit,
      hit_count: hits.length,
      hits: hits.map(h => ({
        memory_id: h.memory_id,
        created_at: h.created_at,
        memory_type: h.memory_type,
        workdir: h.workdir,
        content: h.content,
        match: h.match,
      })),
    }) + '\n');
    return 0;
  }

  io.stdout(renderHumanReport(hits, command.pattern, limit) + '\n');
  return 0;
}

function fail(io: CliIO, json: boolean, msg: string, code: number): number {
  if (json) io.stdout(JSON.stringify({ error: msg }) + '\n');
  else io.stderr(msg + '\n');
  return code;
}

function renderHumanReport(hits: readonly SearchHit[], pattern: string, limit: number): string {
  if (hits.length === 0) {
    return `No memories matched /${pattern}/.`;
  }
  const lines: string[] = [];
  lines.push(`Found ${hits.length} match${hits.length === 1 ? '' : 'es'} for /${pattern}/${hits.length === limit ? ` (capped at ${limit})` : ''}:`);
  lines.push('');
  for (const h of hits) {
    const ts = new Date(h.created_at).toISOString();
    const snippet = highlightSnippet(h.content, h.match);
    lines.push(`${c.dim(h.memory_id.slice(0, 8))}  ${c.gray(ts)}  ${c.cyan(h.memory_type)}`);
    lines.push(`  ${snippet}`);
  }
  return lines.join('\n');
}

/** Trim long content around the match and color-highlight the matched span. */
function highlightSnippet(content: string, match: { start: number; end: number }): string {
  const CONTEXT = 60;
  const start = Math.max(0, match.start - CONTEXT);
  const end = Math.min(content.length, match.end + CONTEXT);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < content.length ? '...' : '';
  const before = content.slice(start, match.start);
  const matched = content.slice(match.start, match.end);
  const after = content.slice(match.end, end);
  // Strip newlines so a single hit fits on one line in the human report.
  const flatten = (s: string): string => s.replace(/\s+/g, ' ');
  return `${prefix}${flatten(before)}${c.yellow(c.bold(flatten(matched)))}${flatten(after)}${suffix}`;
}
