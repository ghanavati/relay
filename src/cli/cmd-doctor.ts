import { execFile } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CliIO } from './commands.js';
import { c, statusBadge } from './colors.js';
import { probeCodex, probeLmStudio, probeEnvKey, type ProviderProbe } from './probes.js';

export interface DoctorArgs { json: boolean; }

/** Hook command we expect to find installed at the global CC settings level. */
const HOOK_COMMAND_FRAGMENT = 'relay memory recall';

/**
 * Check whether the relay SessionStart hook is installed at `~/.claude/settings.json`.
 * Recognises the current schema: each SessionStart entry is `{ hooks: [{ type, command }] }`.
 */
export async function checkCcGlobalHook(): Promise<ProviderProbe> {
  const settingsPath = join(homedir(), '.claude', 'settings.json');
  let raw: string;
  try {
    raw = await readFile(settingsPath, 'utf8');
  } catch {
    return { name: 'cc-global-hook', status: 'missing', detail: `${settingsPath} not found` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { name: 'cc-global-hook', status: 'failed', detail: `${settingsPath} is not valid JSON` };
  }
  const hooks = (parsed as { hooks?: { SessionStart?: unknown } }).hooks;
  const sessionStart = hooks?.SessionStart;
  if (!Array.isArray(sessionStart)) {
    return { name: 'cc-global-hook', status: 'missing', detail: 'no hooks.SessionStart array in settings.json' };
  }
  for (const entry of sessionStart as Array<Record<string, unknown>>) {
    const inner = (Array.isArray(entry['hooks']) ? entry['hooks'] : []) as Array<Record<string, unknown>>;
    for (const cmd of inner) {
      const command = typeof cmd['command'] === 'string' ? cmd['command'] : '';
      if (command.includes(HOOK_COMMAND_FRAGMENT)) {
        return { name: 'cc-global-hook', status: 'ok', detail: `installed in ${settingsPath}` };
      }
    }
  }
  return { name: 'cc-global-hook', status: 'missing', detail: `relay hook not found in ${settingsPath}` };
}

/**
 * Invoke the relay hook command in a subshell and verify the JSON envelope shape.
 * Confirms the hook produces `{ hookSpecificOutput: { hookEventName, additionalContext } }`.
 */
export async function checkHookRoundtrip(): Promise<ProviderProbe> {
  // Use a minimal recall+jq pipeline mirroring the installed hook. We don't depend on the
  // exact installed command — we re-run a known-good shape so the round-trip is independent.
  const cmd = `relay memory recall --token-budget 200 --type lesson --type fact --type decision --type context --json 2>/dev/null | jq -c '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:(if (.memories | length > 0) then "ok" else "" end)}}' 2>/dev/null`;
  return new Promise<ProviderProbe>((resolve) => {
    execFile('bash', ['-c', cmd], { encoding: 'utf-8', timeout: 8000 }, (err, stdoutData) => {
      if (err) {
        resolve({ name: 'hook-roundtrip', status: 'failed', detail: 'hook subprocess failed (relay or jq missing?)' });
        return;
      }
      const out = (stdoutData as string).trim();
      if (!out) {
        resolve({ name: 'hook-roundtrip', status: 'failed', detail: 'hook produced no output' });
        return;
      }
      try {
        const parsed = JSON.parse(out) as { hookSpecificOutput?: { hookEventName?: unknown; additionalContext?: unknown } };
        const ev = parsed.hookSpecificOutput;
        if (ev && typeof ev.hookEventName === 'string' && typeof ev.additionalContext === 'string') {
          resolve({ name: 'hook-roundtrip', status: 'ok', detail: 'JSON envelope shape valid' });
        } else {
          resolve({ name: 'hook-roundtrip', status: 'failed', detail: 'hook output missing hookSpecificOutput.additionalContext' });
        }
      } catch {
        resolve({ name: 'hook-roundtrip', status: 'failed', detail: 'hook output not valid JSON' });
      }
    });
  });
}

/**
 * Compare runtime env vars (RELAY_MEMORY_ALLOWED_WORKDIRS / RELAY_RECALLED_LESSONS / RELAY_DB_PATH)
 * to the values declared in `~/.relay/config.json`. Reports drift between configured and active.
 *
 * If `~/.relay/config.json` is absent or empty, treat as "no expectation declared" → ok.
 */
export async function checkEnvConsistency(): Promise<ProviderProbe> {
  const configPath = join(homedir(), '.relay', 'config.json');
  let configRaw: string;
  try {
    configRaw = await readFile(configPath, 'utf8');
  } catch {
    return { name: 'env-consistency', status: 'ok', detail: 'no ~/.relay/config.json (no expectation declared)' };
  }
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(configRaw) as Record<string, unknown>;
  } catch {
    return { name: 'env-consistency', status: 'failed', detail: '~/.relay/config.json is not valid JSON' };
  }
  const env = (config['env'] ?? config) as Record<string, unknown>;
  const watched = ['RELAY_MEMORY_ALLOWED_WORKDIRS', 'RELAY_RECALLED_LESSONS', 'RELAY_DB_PATH'];
  const drift: string[] = [];
  for (const key of watched) {
    const expected = env[key];
    if (expected === undefined || expected === null) continue;
    const expectedStr = String(expected);
    const actual = process.env[key];
    if (actual !== expectedStr) {
      drift.push(`${key}: expected="${expectedStr}" actual="${actual ?? '<unset>'}"`);
    }
  }
  if (drift.length === 0) {
    return { name: 'env-consistency', status: 'ok', detail: 'env matches ~/.relay/config.json' };
  }
  return { name: 'env-consistency', status: 'failed', detail: `drift: ${drift.join('; ')}` };
}

/** Format a millisecond duration as `Xs` / `Xm` / `Xh` / `Xd` (largest fitting unit, integer). */
function formatAgo(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Report the most recent recall timestamp from the `memory_reads` audit table. */
export async function checkLastRecall(): Promise<ProviderProbe> {
  try {
    const { getDb } = await import('../runtime/store/db.js');
    const db = getDb();
    const row = db.prepare('SELECT MAX(created_at) AS ts FROM memory_reads').get() as { ts: number | null } | undefined;
    const ts = row?.ts;
    if (!ts) {
      return { name: 'last-recall', status: 'missing', detail: 'no recent activity' };
    }
    const ageMs = Date.now() - ts;
    return { name: 'last-recall', status: 'ok', detail: formatAgo(ageMs) };
  } catch {
    return { name: 'last-recall', status: 'failed', detail: 'memory_reads query failed' };
  }
}

/**
 * Check auto-extract activity over the last 24h.
 *
 * Reads the unified relay log (`~/.relay/relay.ndjson`) and filters to
 * entries whose `event` starts with `extract.` — written by the auto-extract
 * pipeline via `appendLog`. Each entry's wrapped shape is
 * `{ ts: number, event: 'extract.write'|'extract.skip'|'extract.error',
 *    ok: boolean, cwd?: string, meta: { ts: ISO, status, ... } }`.
 *
 * The detailed `meta.status` field (e.g. "ok", "skipped:no-consent",
 * "error:bad-payload") is what's bucketed for the ok / skipped / error
 * counts shown in the probe detail string.
 *
 * Path resolution (in order):
 *   1. `RELAY_AUTO_EXTRACT_LOG` — legacy back-compat for users still
 *      pointing at the pre-T2 `auto-extract.log` path. Treated as the same
 *      ndjson format (auto-extract has always written ndjson).
 *   2. `RELAY_LOG_PATH` — explicit unified-log override (mirrors `relay
 *      memory tail`'s resolution).
 *   3. `RELAY_HOME` — sandbox redirect for tests.
 *   4. `~/.relay/relay.ndjson` — production default.
 *
 * Returned probe statuses (mapped to existing ProviderProbe values):
 *   - log missing / unreadable / 0 entries / parse-failed → 'missing' ("never ran" warning)
 *   - any error:* entries                                 → 'missing' (warn — informational, not a hard failure)
 *   - only ok / skipped entries (no errors)               → 'ok'
 */
export function checkAutoExtractStatus(now: Date = new Date()): ProviderProbe {
  const logPath =
    process.env['RELAY_AUTO_EXTRACT_LOG'] ??
    process.env['RELAY_LOG_PATH'] ??
    join(process.env['RELAY_HOME'] ?? join(homedir(), '.relay'), 'relay.ndjson');
  let raw: string;
  try {
    raw = readFileSync(logPath, 'utf-8');
  } catch {
    return { name: 'auto-extract (24h)', status: 'missing', detail: 'log missing — auto-extract has never run' };
  }

  const cutoff = now.getTime() - 24 * 60 * 60 * 1000;
  let okCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: { ts?: unknown; event?: unknown; status?: unknown; meta?: { status?: unknown; ts?: unknown } };
    try {
      parsed = JSON.parse(trimmed) as typeof parsed;
    } catch {
      continue;
    }
    // Unified log entries: {ts: number, event: 'extract.*', meta: {status, ...}}
    // Legacy entries (pre-T2): {ts: ISO string, status, ...}
    // Distinguish on the wrapper's event tag.
    const isUnified =
      typeof parsed.event === 'string' && (parsed.event as string).startsWith('extract.');
    if (!isUnified && parsed.event !== undefined) continue; // unrelated unified event (hook.fire, recall, …)

    let status: string | undefined;
    let tsMs: number;
    if (isUnified) {
      const metaStatus = parsed.meta?.status;
      if (typeof metaStatus !== 'string') continue;
      status = metaStatus;
      const tsField = parsed.ts;
      if (typeof tsField !== 'number') continue;
      tsMs = tsField;
    } else {
      // legacy schema fallback
      if (typeof parsed.ts !== 'string' || typeof parsed.status !== 'string') continue;
      tsMs = Date.parse(parsed.ts);
      status = parsed.status;
    }
    if (Number.isNaN(tsMs) || tsMs < cutoff) continue;
    if (status === 'ok' || status === 'partial:berry-flag') okCount++;
    else if (status.startsWith('skipped:')) skippedCount++;
    else if (status.startsWith('error:')) errorCount++;
  }

  const total = okCount + skippedCount + errorCount;
  const detail = `${okCount} ok, ${skippedCount} skipped, ${errorCount} error`;

  if (total === 0) {
    return { name: 'auto-extract (24h)', status: 'missing', detail: '0 entries — auto-extract has not run in last 24h' };
  }
  if (errorCount > 0) {
    return { name: 'auto-extract (24h)', status: 'missing', detail };
  }
  return { name: 'auto-extract (24h)', status: 'ok', detail };
}

/**
 * Check whether Berry is reachable.
 *
 * Reads `RELAY_BERRY_CMD` env. If unset → status 'ok' detail 'not configured (Berry checks disabled)'.
 * If set → run command with empty stdin and 5s timeout.
 *   - exit 0       → 'ok'      detail 'reachable'
 *   - non-zero/timeout → 'missing' detail 'configured but not reachable'
 */
export async function checkBerryReachability(): Promise<ProviderProbe> {
  const cmd = process.env['RELAY_BERRY_CMD'];
  if (!cmd || cmd.trim().length === 0) {
    return { name: 'berry', status: 'ok', detail: 'not configured (Berry checks disabled)' };
  }
  return new Promise<ProviderProbe>((resolve) => {
    const child = execFile('bash', ['-c', cmd], { encoding: 'utf-8', timeout: 5000 }, (err) => {
      if (err) {
        resolve({ name: 'berry', status: 'missing', detail: 'configured but not reachable' });
        return;
      }
      resolve({ name: 'berry', status: 'ok', detail: 'reachable' });
    });
    // Close stdin immediately so the command sees EOF and can exit.
    if (child.stdin) child.stdin.end();
  });
}

/**
 * Check whether LM Studio has at least one model loaded via `lms ps --json`.
 *
 *   - lms not in PATH        → 'missing' detail 'lms not in PATH'
 *   - JSON parse + ≥1 model  → 'ok'      detail '<count> model(s) loaded: <names>'
 *   - empty list             → 'missing' detail 'no models loaded'
 *   - other failure          → 'missing' detail 'lms ps failed'
 */
export async function checkLmStudioModelLoaded(): Promise<ProviderProbe> {
  return new Promise<ProviderProbe>((resolve) => {
    execFile('lms', ['ps', '--json'], { encoding: 'utf-8', timeout: 5000 }, (err, stdoutData) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          resolve({ name: 'lmstudio-loaded', status: 'missing', detail: 'lms not in PATH' });
          return;
        }
        resolve({ name: 'lmstudio-loaded', status: 'missing', detail: 'lms ps failed' });
        return;
      }
      const out = (stdoutData as string).trim();
      let parsed: unknown;
      try {
        parsed = JSON.parse(out);
      } catch {
        resolve({ name: 'lmstudio-loaded', status: 'missing', detail: 'lms ps output not JSON' });
        return;
      }
      const list = Array.isArray(parsed)
        ? (parsed as Array<Record<string, unknown>>)
        : Array.isArray((parsed as { data?: unknown }).data)
          ? ((parsed as { data: unknown[] }).data as Array<Record<string, unknown>>)
          : Array.isArray((parsed as { models?: unknown }).models)
            ? ((parsed as { models: unknown[] }).models as Array<Record<string, unknown>>)
            : [];
      if (list.length === 0) {
        resolve({ name: 'lmstudio-loaded', status: 'missing', detail: 'no models loaded' });
        return;
      }
      const names = list
        .map((m) => {
          const v = m['identifier'] ?? m['id'] ?? m['name'] ?? m['path'];
          return typeof v === 'string' ? v : '';
        })
        .filter((v) => v.length > 0);
      const summary = names.length > 0 ? names.join(', ') : '<unnamed>';
      resolve({ name: 'lmstudio-loaded', status: 'ok', detail: `${list.length} model(s) loaded: ${summary}` });
    });
  });
}

/**
 * Check presence of `.relay/auto-extract.json` consent files across known workdirs.
 *
 * Workdirs come from `RELAY_MEMORY_ALLOWED_WORKDIRS` (comma-separated). If unset, the
 * single workdir is `process.cwd()`.
 *
 *   - N/M workdirs have file → 'ok' if N>0, otherwise 'missing'
 */
export async function checkConsentFiles(): Promise<ProviderProbe> {
  const raw = process.env['RELAY_MEMORY_ALLOWED_WORKDIRS'];
  const workdirs = raw && raw.trim().length > 0
    ? raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    : [process.cwd()];
  let present = 0;
  for (const dir of workdirs) {
    const file = join(dir, '.relay', 'auto-extract.json');
    try {
      await access(file);
      present++;
    } catch {
      // missing — counted by absence
    }
  }
  const total = workdirs.length;
  if (present === 0) {
    return { name: 'consent-files', status: 'missing', detail: `no workdirs have consent (0/${total})` };
  }
  return { name: 'consent-files', status: 'ok', detail: `${present}/${total} workdirs have consent` };
}

export async function executeDoctorCommand(args: DoctorArgs, io: CliIO): Promise<number> {
  const checks: ProviderProbe[] = [];
  let summary = { ok: 0, missing: 0, failed: 0 };

  function record(probe: ProviderProbe): void {
    checks.push(probe);
    summary[probe.status]++;
  }

  // 1. codex CLI check
  record(await probeCodex());

  // 2. OPENROUTER_API_KEY check
  record(probeEnvKey('OPENROUTER_API_KEY', 'openrouter'));

  // 3. LM Studio check with 3-second timeout
  record(await probeLmStudio());

  // 4. Anthropic API key check
  record(probeEnvKey('ANTHROPIC_API_KEY', 'anthropic'));

  // 5. DB check (doctor-specific — not extracted to probes.ts)
  try {
    const { getDb } = await import('../runtime/store/db.js');
    const db = getDb();
    const result = db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number } | undefined;
    const runCount = result?.n ?? 0;
    const dbPath = process.env['RELAY_DB_PATH'] ?? '~/.relay/relay.db';
    record({ name: 'db', status: 'ok', detail: `${dbPath} (${runCount} runs)` });
  } catch {
    record({ name: 'db', status: 'failed', detail: 'Database check failed' });
  }

  // 6. CC global SessionStart hook installation
  record(await checkCcGlobalHook());

  // 7. Hook round-trip — invoke and verify JSON envelope shape
  record(await checkHookRoundtrip());

  // 8. Env var consistency vs ~/.relay/config.json
  record(await checkEnvConsistency());

  // 9. Last successful recall timestamp from memory_reads
  record(await checkLastRecall());

  // 10. Auto-extract activity (last 24h)
  record(checkAutoExtractStatus());

  // 11. Berry reachability (additive — opt-in via RELAY_BERRY_CMD)
  record(await checkBerryReachability());

  // 12. LM Studio model loaded (additive — separate from HTTP probe)
  record(await checkLmStudioModelLoaded());

  // 13. Consent files presence in known workdirs (additive)
  record(await checkConsentFiles());

  // Output
  if (args.json) {
    io.stdout(JSON.stringify({ checks, summary }) + '\n');
  } else {
    io.stdout(c.bold('relay doctor') + '\n\n');
    checks.forEach(check => {
      io.stdout(`${check.name.padEnd(18)} ${statusBadge(check.status)} ${c.dim(check.detail)}\n`);
    });
    if (summary.failed === 0 && summary.missing === 0) {
      io.stdout(`\n${c.green('All checks passed.')}\n`);
    } else if (summary.failed > 0) {
      io.stdout(`\n${c.red(`${summary.failed} check${summary.failed === 1 ? '' : 's'} failed`)}, ${summary.missing} missing, ${summary.ok} ok.\n`);
    } else {
      io.stdout(`\n${c.green(`${summary.ok} ok`)}, ${c.gray(`${summary.missing} missing (informational)`)}.\n`);
    }
  }

  return summary.failed > 0 ? 1 : 0;
}
