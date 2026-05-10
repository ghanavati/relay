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
  readonly format: 'json' | 'md';
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
    : JSON.stringify(payload, null, 2);

  if (args.out) {
    try {
      await writeFile(args.out, output + (args.format === 'md' ? '' : '\n'), 'utf8');
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

  io.stdout(output + (args.format === 'md' ? '\n' : '\n'));
  return 0;
}
