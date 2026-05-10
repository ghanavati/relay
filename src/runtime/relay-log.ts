/**
 * Centralized ndjson logger for Relay activity inspection.
 *
 * One append-only log at `~/.relay/relay.ndjson`, written from every event
 * source (hooks, recall, remember, doctor, context emit, pause/resume, …)
 * so observability tools (`relay memory tail`, dashboards) read a single
 * stream instead of stitching together per-feature log files.
 *
 * Append uses Node's `{flag: 'a'}`, which maps to POSIX `O_APPEND` — multi
 * process safe for line-sized writes on local disks.
 *
 * Rotation triggers at 10MB or 30 days since the file's `birthtime`. Archive
 * format: `relay.ndjson.<timestamp>`.
 *
 * IMPORTANT: callers are intentionally NOT wired in this task. Other tasks
 * integrate this module into hooks, doctor, etc. (see wave-3 spec).
 */

import { appendFile, readFile, stat, rename, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type LogEvent =
  | 'hook.fire' | 'hook.skip'
  | 'recall' | 'recall.empty'
  | 'remember' | 'memory.wipe' | 'memory.forget'
  | 'extract.fire' | 'extract.skip' | 'extract.write' | 'extract.error'
  | 'doctor.run' | 'context.emit'
  | 'pause' | 'resume';

export interface LogEntry {
  ts: number;
  event: LogEvent;
  cwd?: string;
  workdir?: string;
  ok: boolean;
  meta?: Record<string, unknown>;
}

export interface ReadOpts {
  /** Only include entries with `ts >= since` (epoch ms). */
  since?: number;
  /** Only include entries whose `event` is in this set. */
  filter?: string[];
  /** Cap the number of entries returned (most-recent first). */
  limit?: number;
}

export interface RotateResult {
  rotated: boolean;
  archivePath?: string;
}

export const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Pure rotation decision — exported for testing without filesystem mocking.
 * Returns true when the log should be rotated based on size or age.
 *
 * Age is measured from the file's `birthtimeMs` when reported (>0); some
 * filesystems return 0 there, in which case `mtimeMs` is the fallback.
 */
export function shouldRotate(
  info: { size: number; birthtimeMs: number; mtimeMs: number },
  nowMs: number = Date.now()
): boolean {
  if (info.size >= MAX_BYTES) return true;
  const ageRefMs = info.birthtimeMs && info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs;
  return nowMs - ageRefMs >= MAX_AGE_MS;
}

/**
 * Resolve `~/.relay` lazily so tests can override `HOME` (or `RELAY_HOME`)
 * after module load. Without this, capturing at import-time would freeze
 * the path before any test setup runs.
 */
function getRelayDir(): string {
  return process.env['RELAY_HOME'] ?? join(homedir(), '.relay');
}

function getLogPath(): string {
  return join(getRelayDir(), 'relay.ndjson');
}

async function ensureRelayDir(): Promise<void> {
  await mkdir(getRelayDir(), { recursive: true });
}

/**
 * Append a single log entry. Stamps `ts` at write time; caller supplies
 * everything else. Errors are NOT swallowed — the caller decides whether
 * a logging failure should be fatal (typically: no, but we don't hide it).
 */
export async function appendLog(entry: Omit<LogEntry, 'ts'>): Promise<void> {
  await ensureRelayDir();
  const stamped: LogEntry = { ts: Date.now(), ...entry };
  // JSON.stringify never produces an embedded newline for primitive keys
  // and string values containing newlines are escaped to `\n`, so a single
  // `\n` terminator is safe and ndjson-correct.
  await appendFile(getLogPath(), JSON.stringify(stamped) + '\n', { flag: 'a', encoding: 'utf-8' });
}

/**
 * Read entries from the log. Returns most-recent-first when `limit` is set,
 * otherwise insertion order (oldest first). Malformed lines are skipped.
 */
export async function readLog(opts: ReadOpts = {}): Promise<LogEntry[]> {
  let raw: string;
  try {
    raw = await readFile(getLogPath(), 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw err;
  }

  const filterSet = opts.filter && opts.filter.length > 0 ? new Set(opts.filter) : null;
  const lines = raw.split('\n');
  const entries: LogEntry[] = [];

  for (const line of lines) {
    if (!line) continue;
    let parsed: LogEntry;
    try {
      parsed = JSON.parse(line) as LogEntry;
    } catch {
      continue; // skip malformed
    }
    if (typeof parsed.ts !== 'number' || typeof parsed.event !== 'string') continue;
    if (opts.since !== undefined && parsed.ts < opts.since) continue;
    if (filterSet && !filterSet.has(parsed.event)) continue;
    entries.push(parsed);
  }

  if (opts.limit !== undefined && opts.limit >= 0) {
    // Most-recent first when limited.
    return entries.slice(-opts.limit).reverse();
  }
  return entries;
}

/**
 * Rotate the log if it exceeds 10 MB OR is older than 30 days
 * (measured from the file's birthtime; mtime fallback when birthtime
 * is unreliable, e.g., older Linux kernels).
 *
 * Archive name: `relay.ndjson.<unix_ms>`. After rotation, subsequent
 * `appendLog` calls create a fresh `relay.ndjson`.
 */
export async function rotateIfNeeded(): Promise<RotateResult> {
  const path = getLogPath();
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { rotated: false };
    throw err;
  }

  if (!shouldRotate(info)) return { rotated: false };

  const archivePath = `${path}.${Date.now()}`;
  await rename(path, archivePath);
  return { rotated: true, archivePath };
}
