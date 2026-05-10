/**
 * `relay export --safe` — portable, sanitized memory export.
 *
 * Default ("--safe") is the only mode in v0.1.0. It excludes:
 *   - tags containing "auto-extract" (auto-written entries from session transcripts)
 *   - tags containing "private" (caller-marked private)
 *   - rows where trust_level = 'unverified'
 *   - any superseded row
 *
 * Output formats:
 *   --format json (default): { version, exported_at, workdir, memories: [...] }
 *   --format md            : markdown grouped by memory_type
 *   --format html          : self-contained HTML5 report (inline CSS, one
 *                            table per memory, all user content escaped)
 *
 * Output destination:
 *   --out <file>: write to file (utf8). Otherwise write to stdout.
 */
import { writeFile } from 'node:fs/promises';
import type { CliIO } from './commands.js';
import type { MemoryRow, MemoryType, MemorySource } from '../memory/types.js';
import { computeTrustLevel } from '../memory/memory-store.js';

const EXPORT_VERSION = '1.0';

export interface ExportArgs {
  readonly safe: boolean;
  readonly workdir: string | undefined;
  readonly format: 'json' | 'md' | 'html';
  readonly out: string | undefined;
  readonly json: boolean;
}

interface ExportedMemory {
  readonly memory_id: string;
  readonly memory_type: MemoryType;
  readonly content: string;
  readonly tags: readonly string[];
  readonly pinned: boolean;
  readonly trust_level: 'unverified' | 'provisional' | 'trusted';
  readonly created_at: number;
}

interface ExportPayload {
  readonly version: string;
  readonly exported_at: number;
  readonly workdir: string | null;
  readonly memories: readonly ExportedMemory[];
}

async function selectRows(workdir: string | undefined, safe: boolean): Promise<MemoryRow[]> {
  // Lazy-load via dynamic import — matches sibling commands and avoids opening
  // the DB just to import this module.
  const { getDb } = await import('../runtime/store/db.js');
  const db = getDb();

  // SQL filters: cheap exclusions that don't depend on derived state.
  // The trust_level COLUMN in the DB is rarely upgraded to its derived value, so
  // we cannot use it for filtering — we apply the trust filter in TS on the
  // derived (computed) trust level instead. See rowPassesSafeFilter below.
  const conditions: string[] = ['superseded_by IS NULL'];
  const params: unknown[] = [];

  if (workdir !== undefined && workdir !== '*') {
    conditions.push('(workdir = ? OR workdir IS NULL)');
    params.push(workdir);
  }

  if (safe) {
    conditions.push("tags_json NOT LIKE '%\"auto-extract\"%'");
    conditions.push("tags_json NOT LIKE '%\"private\"%'");
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  type AllParams = Parameters<ReturnType<typeof db.prepare>['all']>;
  return db
    .prepare(`SELECT * FROM memories ${where} ORDER BY created_at ASC`)
    .all(...(params as AllParams)) as MemoryRow[];
}

function rowToExported(row: MemoryRow): ExportedMemory {
  const tags = JSON.parse(row.tags_json) as string[];
  const trust = computeTrustLevel(
    (row.memory_source ?? 'unknown') as MemorySource,
    row.success_recall_count ?? 0,
    row.pinned === 1
  );
  return {
    memory_id: row.memory_id,
    memory_type: row.memory_type as MemoryType,
    content: row.content,
    tags,
    pinned: row.pinned === 1,
    trust_level: trust,
    created_at: row.created_at,
  };
}

/**
 * HTML-escape user-controlled text. Covers the five XML metacharacters that
 * matter inside element content and double-quoted attribute values. Single
 * quotes are also escaped because the inline style block uses double quotes,
 * but downstream callers may switch to single-quoted attributes later.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderHtml(payload: ExportPayload): string {
  const generated = new Date(payload.exported_at).toISOString();
  const workdir = payload.workdir ?? '(all)';
  const count = payload.memories.length;
  const css = [
    'body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;margin:2rem;color:#222;background:#fafafa}',
    'header{border-bottom:1px solid #ddd;padding-bottom:1rem;margin-bottom:2rem}',
    'h1{margin:0 0 .5rem 0;font-size:1.5rem}',
    'header dl{margin:0;display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem;font-size:.9rem}',
    'header dt{font-weight:600;color:#555}',
    'header dd{margin:0}',
    'table{border-collapse:collapse;width:100%;margin:0 0 1.5rem 0;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.05)}',
    'th,td{padding:.5rem .75rem;text-align:left;vertical-align:top;border-bottom:1px solid #eee;font-size:.9rem}',
    'th{width:8rem;background:#f4f4f4;font-weight:600;color:#444}',
    'td.content{white-space:pre-wrap;word-break:break-word}',
    '.tag{display:inline-block;background:#eef;border-radius:3px;padding:0 .4rem;margin-right:.25rem;font-size:.8rem}',
    '.trust-trusted{color:#0a7a2f;font-weight:600}',
    '.trust-provisional{color:#8a6d00}',
    '.trust-unverified{color:#a33}',
    '.empty{color:#888;font-style:italic}',
  ].join('');

  const parts: string[] = [];
  parts.push('<!DOCTYPE html>');
  parts.push('<html lang="en">');
  parts.push('<head><meta charset="utf-8"><title>Relay memory export</title>');
  parts.push(`<style>${css}</style></head>`);
  parts.push('<body>');
  parts.push('<header>');
  parts.push('<h1>Relay memory export</h1>');
  parts.push('<dl>');
  parts.push(`<dt>workdir</dt><dd>${escapeHtml(workdir)}</dd>`);
  parts.push(`<dt>count</dt><dd>${count}</dd>`);
  parts.push(`<dt>generated</dt><dd>${escapeHtml(generated)}</dd>`);
  parts.push(`<dt>version</dt><dd>${escapeHtml(payload.version)}</dd>`);
  parts.push('</dl>');
  parts.push('</header>');

  if (count === 0) {
    // Always include at least one table so the document remains
    // structurally consistent and trivially testable.
    parts.push('<table><tbody><tr><td class="empty">No memories matched the export filter.</td></tr></tbody></table>');
  } else {
    for (const m of payload.memories) {
      const tagsHtml = m.tags.length > 0
        ? m.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')
        : '<span class="empty">none</span>';
      const created = new Date(m.created_at).toISOString();
      parts.push('<table>');
      parts.push('<tbody>');
      parts.push(`<tr><th>id</th><td>${escapeHtml(m.memory_id)}</td></tr>`);
      parts.push(`<tr><th>type</th><td>${escapeHtml(m.memory_type)}</td></tr>`);
      parts.push(`<tr><th>tags</th><td>${tagsHtml}</td></tr>`);
      parts.push(`<tr><th>trust</th><td><span class="trust-${escapeHtml(m.trust_level)}">${escapeHtml(m.trust_level)}</span>${m.pinned ? ' (pinned)' : ''}</td></tr>`);
      parts.push(`<tr><th>created_at</th><td>${escapeHtml(created)}</td></tr>`);
      parts.push(`<tr><th>content</th><td class="content">${escapeHtml(m.content)}</td></tr>`);
      parts.push('</tbody>');
      parts.push('</table>');
    }
  }

  parts.push('</body></html>');
  return parts.join('\n');
}

function renderMarkdown(payload: ExportPayload): string {
  const lines: string[] = [];
  lines.push(`# Relay memory export`);
  lines.push('');
  lines.push(`- exported_at: ${new Date(payload.exported_at).toISOString()}`);
  lines.push(`- workdir: ${payload.workdir ?? '(all)'}`);
  lines.push(`- count: ${payload.memories.length}`);
  lines.push(`- version: ${payload.version}`);
  lines.push('');

  // Group by memory_type, preserving deterministic order.
  const groups = new Map<MemoryType, ExportedMemory[]>();
  for (const m of payload.memories) {
    const list = groups.get(m.memory_type) ?? [];
    list.push(m);
    groups.set(m.memory_type, list);
  }

  const orderedTypes: MemoryType[] = ['fact', 'decision', 'lesson', 'context', 'state', 'handoff', 'session'];
  for (const t of orderedTypes) {
    const list = groups.get(t);
    if (!list || list.length === 0) continue;
    lines.push(`## ${t}`);
    lines.push('');
    for (const m of list) {
      const tagPart = m.tags.length > 0 ? ` _[${m.tags.join(', ')}]_` : '';
      const pinPart = m.pinned ? ' (pinned)' : '';
      // Single-line bullet: collapse content newlines to keep markdown grep-friendly.
      const safeContent = m.content.replace(/\r?\n/g, ' ').trim();
      lines.push(`- ${safeContent}${tagPart}${pinPart}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export async function executeExportCommand(args: ExportArgs, io: CliIO): Promise<number> {
  const workdir = args.workdir ?? io.cwd;
  let rows: MemoryRow[];
  try {
    rows = await selectRows(workdir, args.safe);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (args.json) {
      io.stdout(JSON.stringify({ ok: false, error: 'export_failed', detail: msg }) + '\n');
    } else {
      io.stderr(`relay export failed: ${msg}\n`);
    }
    return 1;
  }

  // Drop unverified entries based on the DERIVED trust level. The DB column
  // `trust_level` is updated lazily (only by demoteMemory / upgradeTrust), so
  // we cannot rely on it in the SQL WHERE — see selectRows().
  const memories = rows
    .map(rowToExported)
    .filter(m => !args.safe || m.trust_level !== 'unverified');
  const payload: ExportPayload = {
    version: EXPORT_VERSION,
    exported_at: Date.now(),
    workdir,
    memories,
  };

  const output = args.format === 'md'
    ? renderMarkdown(payload)
    : args.format === 'html'
      ? renderHtml(payload)
      : JSON.stringify(payload, null, 2);

  // Markdown and HTML are already terminated; JSON gets a trailing newline.
  const trailingNewline = args.format === 'json' ? '\n' : '';

  if (args.out) {
    try {
      await writeFile(args.out, output + trailingNewline, 'utf8');
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (args.json) {
        io.stdout(JSON.stringify({ ok: false, error: 'write_failed', detail: msg, out: args.out }) + '\n');
      } else {
        io.stderr(`relay export: failed to write ${args.out}: ${msg}\n`);
      }
      return 1;
    }
    if (args.json) {
      io.stdout(JSON.stringify({ ok: true, count: memories.length, out: args.out, format: args.format }) + '\n');
    } else {
      io.stdout(`Exported ${memories.length} memories to ${args.out} (${args.format}).\n`);
    }
    return 0;
  }

  // Always end stdout with a single newline so terminals don't trail content.
  io.stdout(output + '\n');
  return 0;
}
