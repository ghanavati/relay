/**
 * `relay pause` / `relay resume` — privacy off-switch (T47).
 *
 * Sentinel file (`~/.relay/paused` for global, `<workdir>/.relay/paused` for scoped)
 * blocks Relay hooks from running. While the sentinel exists and has not expired,
 * `executePauseCheckCommand` (and `isPaused()` helper) returns "paused", which a
 * hook wrapper can use to no-op silently.
 *
 * The hook integration uses the `--check` mode of `relay pause`:
 *   relay pause --check [--workdir <path>] && exit 0 || <existing hook command>
 *
 * `relay pause --check` exits 0 silently when paused, 1 when not paused. This
 * keeps bash logic OUT of the embedded HOOK_SCRIPT string while still making the
 * pause status easy to gate on.
 */

import type { CliIO } from './commands.js';
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export const SENTINEL_FILENAME = 'paused';

interface SentinelPayload {
  paused_at: number;
  expires_at: number | null;
  scope: 'global' | 'workdir';
  workdir?: string;
}

function getGlobalSentinelPath(): string {
  return join(homedir(), '.relay', SENTINEL_FILENAME);
}

function getWorkdirSentinelPath(workdir: string): string {
  return join(workdir, '.relay', SENTINEL_FILENAME);
}

/**
 * Resolve the sentinel path:
 *   workdir provided → `<workdir>/.relay/paused`
 *   else             → `~/.relay/paused`
 */
function resolveSentinelPath(workdir: string | undefined): string {
  return workdir ? getWorkdirSentinelPath(workdir) : getGlobalSentinelPath();
}

async function readSentinel(path: string): Promise<SentinelPayload | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SentinelPayload>;
    if (typeof parsed.paused_at !== 'number') return null;
    return {
      paused_at: parsed.paused_at,
      expires_at: typeof parsed.expires_at === 'number' ? parsed.expires_at : null,
      scope: parsed.scope === 'workdir' ? 'workdir' : 'global',
      ...(parsed.workdir ? { workdir: parsed.workdir } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Returns true if a sentinel exists and (if expires_at is set) has not yet expired.
 *
 * Scope precedence: if `workdir` is provided, check the workdir sentinel first.
 * Always also check the global sentinel — a global pause overrides everywhere.
 */
export async function isPaused(workdir: string | undefined, now: number = Date.now()): Promise<boolean> {
  const candidates = workdir
    ? [getWorkdirSentinelPath(workdir), getGlobalSentinelPath()]
    : [getGlobalSentinelPath()];
  for (const path of candidates) {
    const payload = await readSentinel(path);
    if (!payload) continue;
    if (payload.expires_at !== null && payload.expires_at <= now) continue;
    return true;
  }
  return false;
}

export interface PauseArgs {
  minutes?: number | undefined;
  workdir?: string | undefined;
  json: boolean;
}

export interface ResumeArgs {
  workdir?: string | undefined;
  json: boolean;
}

export interface PauseCheckArgs {
  workdir?: string | undefined;
}

/** `relay pause [--minutes N] [--workdir <path>] [--json]` */
export async function executePauseCommand(args: PauseArgs, io: CliIO): Promise<number> {
  const path = resolveSentinelPath(args.workdir);
  const now = Date.now();
  const expiresAt = args.minutes && args.minutes > 0
    ? now + Math.round(args.minutes * 60_000)
    : null;
  const payload: SentinelPayload = {
    paused_at: now,
    expires_at: expiresAt,
    scope: args.workdir ? 'workdir' : 'global',
    ...(args.workdir ? { workdir: args.workdir } : {}),
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  if (args.json) {
    io.stdout(JSON.stringify({ paused: true, sentinel: path, ...payload }) + '\n');
  } else {
    const expiryNote = expiresAt !== null
      ? ` (expires in ${args.minutes} min, at ${new Date(expiresAt).toISOString()})`
      : ' (no expiry — run `relay resume` to lift)';
    io.stdout(`Relay paused${expiryNote}\n  sentinel: ${path}\n  scope: ${payload.scope}\n`);
  }
  return 0;
}

/** `relay resume [--workdir <path>] [--json]` */
export async function executeResumeCommand(args: ResumeArgs, io: CliIO): Promise<number> {
  const path = resolveSentinelPath(args.workdir);
  let removed = true;
  try {
    await unlink(path);
  } catch {
    removed = false;
  }
  if (args.json) {
    io.stdout(JSON.stringify({ paused: false, sentinel: path, removed }) + '\n');
  } else if (removed) {
    io.stdout(`Relay resumed (removed ${path}).\n`);
  } else {
    io.stdout(`Relay was not paused (no sentinel at ${path}).\n`);
  }
  return 0;
}

/**
 * `relay pause --check [--workdir <path>]` — silent exit code only.
 *
 * Returns 0 when paused (hook wrappers can short-circuit), 1 when not paused.
 * No stdout/stderr output by design so it composes cleanly in shell scripts.
 */
export async function executePauseCheckCommand(args: PauseCheckArgs): Promise<number> {
  const paused = await isPaused(args.workdir);
  return paused ? 0 : 1;
}
