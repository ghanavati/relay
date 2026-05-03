import type { CliIO } from './commands.js';
import { c, statusBadge } from './colors.js';
import { probeCodex, probeLmStudio, probeEnvKey, type ProviderProbe } from './probes.js';

export interface DoctorArgs { json: boolean; }

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

  // Output
  if (args.json) {
    io.stdout(JSON.stringify({ checks, summary }) + '\n');
  } else {
    io.stdout(c.bold('relay doctor') + '\n\n');
    checks.forEach(check => {
      io.stdout(`${check.name.padEnd(12)} ${statusBadge(check.status)} ${c.dim(check.detail)}\n`);
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
