import type { CliIO } from './commands.js';

export interface DoctorArgs { json: boolean; }

export async function executeDoctorCommand(args: DoctorArgs, io: CliIO): Promise<number> {
  const checks = [];
  let summary = { ok: 0, missing: 0, failed: 0 };

  // 1. codex CLI check
  try {
    const { execFile } = await import('node:child_process');
    const { stdout } = await new Promise((resolve, reject) => {
      execFile('codex', ['--version'], { encoding: 'utf-8' }, (err, stdout) => {
        if (err) reject(err);
        else resolve({ stdout });
      });
    });
    const version = stdout.trim();
    checks.push({ name: 'codex', status: 'ok', detail: `codex-cli ${version}` });
    summary.ok++;
  } catch {
    checks.push({ name: 'codex', status: 'failed', detail: 'codex not found or not accessible' });
    summary.failed++;
  }

  // 2. OPENROUTER_API_KEY check
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (openrouterKey) {
    checks.push({ name: 'openrouter', status: 'ok', detail: 'OPENROUTER_API_KEY set' });
    summary.ok++;
  } else {
    checks.push({ name: 'openrouter', status: 'missing', detail: 'OPENROUTER_API_KEY not set' });
    summary.missing++;
  }

  // 3. LM Studio check with 3-second timeout
  try {
    const lmstudioEndpoint = process.env.LMSTUDIO_ENDPOINT ?? 'http://localhost:1234';
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    const response = await fetch(`${lmstudioEndpoint}/v1/models`, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json();
      const modelCount = data?.length ?? 0;
      checks.push({ name: 'lmstudio', status: 'ok', detail: `${lmstudioEndpoint} (${modelCount} models)` });
      summary.ok++;
    } else {
      checks.push({ name: 'lmstudio', status: 'failed', detail: 'LM Studio endpoint not reachable' });
      summary.failed++;
    }
  } catch {
    checks.push({ name: 'lmstudio', status: 'failed', detail: 'LM Studio endpoint not reachable' });
    summary.failed++;
  }

  // 4. Anthropic API key check
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    checks.push({ name: 'anthropic', status: 'ok', detail: 'ANTHROPIC_API_KEY set' });
    summary.ok++;
  } else {
    checks.push({ name: 'anthropic', status: 'missing', detail: 'ANTHROPIC_API_KEY not set' });
    summary.missing++;
  }

  // 5. DB check
  try {
    const { getDb } = await import('../runtime/store/db.js');
    const db = getDb();
    const result = db.prepare('SELECT COUNT(*) FROM runs').get();
    const runCount = result?.['COUNT(*)'] ?? 0;
    checks.push({ name: 'db', status: 'ok', detail: `${db.path} (${runCount} runs)` });
    summary.ok++;
  } catch {
    checks.push({ name: 'db', status: 'failed', detail: 'Database check failed' });
    summary.failed++;
  }

  // Output
  if (args.json) {
    io.stdout(JSON.stringify({ checks, summary }, null, 2));
  } else {
    io.stdout('relay doctor\n\n');
    checks.forEach(check => {
      const status = check.status === 'ok' ? '[OK]' : check.status === 'failed' ? '[!!]' : '[--]';
      io.stdout(`${check.name.padEnd(12)} ${status} ${check.detail}\n`);
    });
    io.stdout(`\nAll checks passed.\n`);
  }

  return summary.failed > 0 ? 1 : 0;
}