/**
 * `relay info` — overall status summary.
 *
 * Reports binary version + path, DB stats, workdir-scope env, hook installation,
 * provider reachability, and last-activity timestamps. Designed to give a single
 * "is everything wired?" snapshot for users post-install.
 *
 * Modes:
 *   relay info           — human-readable status block
 *   relay info --json    — structured JSON for scripts/CI
 */

import type { CliIO } from './commands.js';
import { c, statusBadge } from './colors.js';
import { probeCodex, probeLmStudio, probeEnvKey } from './probes.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const execFileAsync = promisify(execFile);

export interface InfoArgs { json: boolean; }

interface DbInfo {
  path: string;
  entries: number;
  sizeBytes: number | null;
  sizeMb: string | null;
}

interface HookInfo {
  installed: boolean;
  path: string | null;
  command: string | null;
}

interface HooksState {
  settingsPath: string;
  sessionStart: HookInfo;
  sessionEnd: HookInfo;
}

interface ProviderInfo {
  name: string;
  status: 'ok' | 'failed' | 'missing';
  detail: string;
}

interface LastActivity {
  lastRecallAgoMs: number | null;
  lastRememberAgoMs: number | null;
  lastExtractAgoMs: number | null;
}

interface InfoReport {
  version: string;
  binary: string | null;
  db: DbInfo;
  workdirScope: string | null;
  autoExtract: { enabledWorkdirs: number };
  hooks: HooksState;
  providers: ProviderInfo[];
  lastActivity: LastActivity;
}

async function probeBinaryPath(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('which', ['relay'], { encoding: 'utf-8', timeout: 3000 });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch { return null; }
}

async function getDbInfo(): Promise<DbInfo> {
  const configuredPath = process.env['RELAY_DB_PATH'] ?? join(homedir(), '.relay', 'relay.db');
  const display = process.env['RELAY_DB_PATH']
    ? configuredPath
    : '~/.relay/relay.db';
  let entries = 0;
  try {
    const { MemoryStore } = await import('../memory/memory-store.js');
    entries = new MemoryStore().count();
  } catch { /* db unreachable — leave entries=0 */ }

  let sizeBytes: number | null = null;
  let sizeMb: string | null = null;
  if (configuredPath !== ':memory:') {
    try {
      const s = await stat(configuredPath);
      sizeBytes = s.size;
      sizeMb = (s.size / (1024 * 1024)).toFixed(1);
    } catch { /* file not yet created */ }
  }
  return { path: display, entries, sizeBytes, sizeMb };
}

/**
 * Read user-global `~/.claude/settings.json` and detect SessionStart / SessionEnd
 * hook entries whose inner `hooks[].command` starts with `relay `. We don't try to
 * match an exact HOOK_SCRIPT string — the goal is "is some relay hook wired here?".
 */
async function readHooksState(): Promise<HooksState> {
  const settingsPath = join(homedir(), '.claude', 'settings.json');
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(await readFile(settingsPath, 'utf-8')) as Record<string, unknown>;
  } catch { /* missing or unreadable — treat as no hooks */ }

  const hooks = (settings['hooks'] ?? {}) as Record<string, unknown>;
  return {
    settingsPath,
    sessionStart: detectRelayHook(hooks['SessionStart'], settingsPath),
    sessionEnd: detectRelayHook(hooks['SessionEnd'], settingsPath),
  };
}

function detectRelayHook(eventList: unknown, settingsPath: string): HookInfo {
  if (!Array.isArray(eventList)) return { installed: false, path: null, command: null };
  for (const entry of eventList as Array<Record<string, unknown>>) {
    const inner = (Array.isArray(entry['hooks']) ? entry['hooks'] : []) as Array<Record<string, unknown>>;
    for (const h of inner) {
      const cmd = h['command'];
      if (typeof cmd === 'string' && /\brelay\b/.test(cmd)) {
        return { installed: true, path: settingsPath, command: cmd };
      }
    }
  }
  return { installed: false, path: null, command: null };
}

/** Best-effort count of allowed workdirs from RELAY_MEMORY_ALLOWED_WORKDIRS. */
function countAutoExtractWorkdirs(): number {
  const raw = process.env['RELAY_MEMORY_ALLOWED_WORKDIRS'];
  if (!raw) return 0;
  return raw.split(':').map((p) => p.trim()).filter(Boolean).length;
}

async function readLastActivity(): Promise<LastActivity> {
  const now = Date.now();
  let lastRecallAgoMs: number | null = null;
  let lastRememberAgoMs: number | null = null;
  let lastExtractAgoMs: number | null = null;

  try {
    const { getDb } = await import('../runtime/store/db.js');
    const db = getDb();
    const recallRow = db
      .prepare('SELECT MAX(created_at) AS ts FROM memory_reads')
      .get() as { ts: number | null } | undefined;
    if (recallRow?.ts) lastRecallAgoMs = now - recallRow.ts;
    const memRow = db
      .prepare('SELECT MAX(created_at) AS ts FROM memories WHERE superseded_by IS NULL')
      .get() as { ts: number | null } | undefined;
    if (memRow?.ts) lastRememberAgoMs = now - memRow.ts;
  } catch { /* db unreachable — leave nulls */ }

  try {
    const logPath = join(homedir(), '.relay', 'auto-extract.log');
    const s = await stat(logPath);
    lastExtractAgoMs = now - s.mtimeMs;
  } catch { /* log doesn't exist yet — never extracted */ }

  return { lastRecallAgoMs, lastRememberAgoMs, lastExtractAgoMs };
}

function formatAgo(ms: number | null): string {
  if (ms === null) return 'never';
  const abs = Math.abs(ms);
  if (abs < 60_000) return `${Math.max(1, Math.round(abs / 1000))}s ago`;
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m ago`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h ago`;
  return `${Math.round(abs / 86_400_000)}d ago`;
}

function badge(installed: boolean): string {
  return installed ? statusBadge('ok') : statusBadge('missing');
}

function providerBadge(p: ProviderInfo): string { return statusBadge(p.status); }

export async function executeInfoCommand(args: InfoArgs, io: CliIO, version: string): Promise<number> {
  const [binary, db, hooks, codex, lmstudio] = await Promise.all([
    probeBinaryPath(),
    getDbInfo(),
    readHooksState(),
    probeCodex(),
    probeLmStudio(),
  ]);
  const openrouter = probeEnvKey('OPENROUTER_API_KEY', 'openrouter');
  const anthropic = probeEnvKey('ANTHROPIC_API_KEY', 'anthropic');
  const lastActivity = await readLastActivity();

  const providers: ProviderInfo[] = [
    { name: 'codex', status: codex.status, detail: codex.detail },
    { name: 'lm-studio', status: lmstudio.status, detail: lmstudio.detail },
    { name: 'openrouter', status: openrouter.status, detail: openrouter.detail },
    { name: 'anthropic', status: anthropic.status, detail: anthropic.detail },
  ];

  const report: InfoReport = {
    version,
    binary,
    db,
    workdirScope: process.env['RELAY_MEMORY_ALLOWED_WORKDIRS'] ?? null,
    autoExtract: { enabledWorkdirs: countAutoExtractWorkdirs() },
    hooks,
    providers,
    lastActivity,
  };

  if (args.json) {
    io.stdout(JSON.stringify(report) + '\n');
    return 0;
  }

  // Human-readable
  io.stdout(`${c.bold(`relay v${version}`)}\n`);
  io.stdout(`  Binary:           ${binary ?? c.dim('not on PATH')}\n`);
  const dbSize = db.sizeMb !== null ? `, ${db.sizeMb} MB` : '';
  io.stdout(`  DB:               ${db.path} (${db.entries} entries${dbSize})\n`);
  io.stdout(`  Workdir scope:    ${report.workdirScope ?? c.dim('not set')}  ${c.dim('(RELAY_MEMORY_ALLOWED_WORKDIRS)')}\n`);
  io.stdout(`  Auto-extract:     enabled in ${report.autoExtract.enabledWorkdirs} workdirs\n`);
  io.stdout(`  Hooks installed:\n`);
  io.stdout(`    SessionStart    ${badge(hooks.sessionStart.installed)} ${c.dim(hooks.sessionStart.path ?? 'missing')}\n`);
  io.stdout(`    SessionEnd      ${badge(hooks.sessionEnd.installed)} ${c.dim(hooks.sessionEnd.path ?? 'missing')}\n`);
  io.stdout(`  Providers:\n`);
  for (const p of providers) {
    io.stdout(`    ${p.name.padEnd(12)}${providerBadge(p)} ${c.dim(p.detail)}\n`);
  }
  io.stdout(`  Last activity:\n`);
  io.stdout(`    last recall     ${formatAgo(lastActivity.lastRecallAgoMs)}\n`);
  io.stdout(`    last remember   ${formatAgo(lastActivity.lastRememberAgoMs)}\n`);
  io.stdout(`    last extract    ${formatAgo(lastActivity.lastExtractAgoMs)}\n`);

  return 0;
}
