/**
 * `relay memory tail` — inspect the relay activity log (~/.relay/relay.ndjson).
 *
 * Append-only ndjson written by the centralized logger (T27). Each line is a
 * JSON object: { ts: number, event: string, cwd: string, ok: boolean, meta?: ... }.
 *
 * Flags:
 *   --filter <event>       only show lines whose `event` field contains the value
 *                          (substring match; repeatable for OR-of-substrings)
 *   --since <duration>     parse `1h`, `30m`, `7d` etc. → unix-ms threshold;
 *                          only show lines with ts >= now - duration
 *   --json                 emit raw ndjson lines as-is (filtered)
 *   (default)              pretty `[ts] event cwd ok=... meta=...` table
 *
 * If the log file is missing, prints "no activity logged yet" to stderr and
 * exits 0 (this is normal on a fresh install).
 *
 * Log path resolution (in order):
 *   1. `args.logPath` (test override)
 *   2. process.env.RELAY_LOG_PATH
 *   3. ~/.relay/relay.ndjson
 */

import type { CliIO } from './commands.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { c } from './colors.js';

export interface MemoryTailArgs {
  filters: readonly string[];
  since?: string | undefined;
  json: boolean;
  logPath?: string | undefined;
}

interface LogEntry {
  ts: number;
  event: string;
  cwd?: string;
  ok?: boolean;
  meta?: unknown;
  [k: string]: unknown;
}

/** Resolve the ndjson log path. */
function resolveLogPath(override?: string): string {
  if (override) return override;
  const env = process.env['RELAY_LOG_PATH'];
  if (env) return env;
  return join(homedir(), '.relay', 'relay.ndjson');
}

/**
 * Parse a duration like `1h`, `30m`, `7d`, `45s`, `500ms` to milliseconds.
 * Throws on invalid input. Exported for tests.
 */
export function parseDuration(input: string): number {
  const trimmed = input.trim();
  // Order matters: ms before m (regex anchored with $).
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i.exec(trimmed);
  if (!match) {
    throw new Error(`invalid --since duration: ${input}. Use forms like 30m, 2h, 7d, 500ms.`);
  }
  const value = Number.parseFloat(match[1]!);
  const unit = match[2]!.toLowerCase();
  const factors: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return Math.round(value * factors[unit]!);
}

/**
 * Parse ndjson text into typed entries. Skips blank lines and silently drops
 * malformed lines (logger should never emit those, but tail must be robust).
 * Exported for tests.
 */
export function parseLogLines(text: string): LogEntry[] {
  const out: LogEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === 'object' && 'ts' in parsed && 'event' in parsed) {
        out.push(parsed as LogEntry);
      }
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

/** Apply --filter and --since predicates. Exported for tests. */
export function filterEntries(
  entries: readonly LogEntry[],
  opts: { filters: readonly string[]; sinceMs?: number | undefined }
): LogEntry[] {
  const { filters, sinceMs } = opts;
  return entries.filter((entry) => {
    if (sinceMs !== undefined && entry.ts < sinceMs) return false;
    if (filters.length > 0) {
      const event = String(entry.event ?? '');
      const matches = filters.some((f) => event.includes(f));
      if (!matches) return false;
    }
    return true;
  });
}

/** Format one entry for the human-readable table. */
function formatHumanLine(entry: LogEntry): string {
  const iso = new Date(entry.ts).toISOString();
  const event = c.cyan(String(entry.event));
  const cwd = entry.cwd ? c.dim(String(entry.cwd)) : c.dim('-');
  const okPart = entry.ok === undefined
    ? ''
    : ` ok=${entry.ok ? c.green('true') : c.red('false')}`;
  const metaPart = entry.meta !== undefined
    ? ` meta=${JSON.stringify(entry.meta)}`
    : '';
  return `[${iso}] ${event} ${cwd}${okPart}${metaPart}\n`;
}

export async function executeMemoryTailCommand(
  args: MemoryTailArgs,
  io: CliIO
): Promise<number> {
  const path = resolveLogPath(args.logPath);

  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      io.stderr('no activity logged yet\n');
      return 0;
    }
    io.stderr(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  let sinceMs: number | undefined;
  if (args.since) {
    try {
      const deltaMs = parseDuration(args.since);
      sinceMs = Date.now() - deltaMs;
    } catch (err) {
      io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
  }

  const entries = parseLogLines(raw);
  const filtered = filterEntries(entries, { filters: args.filters, sinceMs });

  if (args.json) {
    for (const entry of filtered) io.stdout(JSON.stringify(entry) + '\n');
  } else if (filtered.length === 0) {
    io.stdout('no matching log entries\n');
  } else {
    for (const entry of filtered) io.stdout(formatHumanLine(entry));
  }

  return 0;
}
