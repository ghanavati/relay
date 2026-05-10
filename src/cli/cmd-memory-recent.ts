/**
 * `relay memory recent` — list the most recently created memories.
 *
 * Default limit: 10. Capped at 1000 by the underlying store query.
 * Optional --workdir filter narrows to a single project; global (workdir
 * IS NULL) entries are always included alongside project-scoped ones.
 *
 * Output:
 *   Default — fixed-width columns:
 *     created_at | type | trust | content (truncated to 80 chars) | tags
 *   --json    — structured array with full content + every Memory field
 *               required by integrations.
 *
 * Exit codes: 0 on success, 2 on bad --limit value.
 */

import type { CliIO } from './commands.js';
import type { Memory } from '../memory/types.js';
import { c } from './colors.js';

const DEFAULT_LIMIT = 10;
const CONTENT_PREVIEW = 80;

export interface MemoryRecentOptions {
  readonly limit: number;
  readonly workdir: string | undefined;
  readonly json: boolean;
}

/** One row in the JSON output — flat shape for downstream consumers. */
export interface MemoryRecentJsonEntry {
  readonly memory_id: string;
  readonly created_at: number;
  readonly created_at_iso: string;
  readonly memory_type: string;
  readonly trust_level: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly workdir: string | null;
  readonly pinned: boolean;
}

/** Truncate `content` to `max` chars, replacing newlines with spaces and adding an ellipsis if cut. */
export function truncateContent(content: string, max: number = CONTENT_PREVIEW): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

/** Map a Memory to its JSON-output shape. */
function toJsonEntry(m: Memory): MemoryRecentJsonEntry {
  return {
    memory_id: m.memory_id,
    created_at: m.created_at,
    created_at_iso: new Date(m.created_at).toISOString(),
    memory_type: m.memory_type,
    trust_level: m.trust_level,
    content: m.content,
    tags: m.tags,
    workdir: m.workdir,
    pinned: m.pinned,
  };
}

/** Format one row as a fixed-width line. */
function formatRow(m: Memory): string {
  const iso = new Date(m.created_at).toISOString();
  const type = m.memory_type.padEnd(8);
  const trust = m.trust_level.padEnd(11);
  const content = truncateContent(m.content).padEnd(CONTENT_PREVIEW);
  const tags = m.tags.length > 0 ? m.tags.join(',') : '-';
  return `${c.dim(iso)}  ${c.cyan(type)}  ${c.yellow(trust)}  ${content}  ${c.gray(tags)}\n`;
}

export async function executeMemoryRecentCommand(
  command: MemoryRecentOptions,
  io: CliIO
): Promise<number> {
  if (!Number.isFinite(command.limit) || command.limit <= 0) {
    io.stderr(`--limit must be a positive integer (got: ${command.limit})\n`);
    return 2;
  }

  const { MemoryStore } = await import('../memory/memory-store.js');
  const store = new MemoryStore();
  const memories = store.getRecent(command.limit, command.workdir);

  if (command.json) {
    io.stdout(JSON.stringify(memories.map(toJsonEntry)) + '\n');
    return 0;
  }

  if (memories.length === 0) {
    io.stdout('No memories found.\n');
    return 0;
  }

  const header = `${c.bold('created_at'.padEnd(24))}  ${c.bold('type'.padEnd(8))}  ${c.bold('trust'.padEnd(11))}  ${c.bold('content'.padEnd(CONTENT_PREVIEW))}  ${c.bold('tags')}\n`;
  io.stdout(header);
  for (const m of memories) io.stdout(formatRow(m));
  return 0;
}
