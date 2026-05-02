/**
 * `relay init` — interactive setup wizard for first-time users.
 *
 * Detects providers, offers to wire SessionStart hook, optionally migrates
 * Claude Code auto-memory, writes ~/.relay/config.json.
 *
 * Modes:
 *   relay init             — interactive (default), Y/n prompts with sensible defaults
 *   relay init --auto      — non-interactive, accept all sensible defaults
 *   relay init --quick     — bare minimum (creates ~/.relay/, writes empty config, no prompts)
 */

import type { CliIO } from './commands.js';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

export interface InitArgs {
  auto: boolean;
  quick: boolean;
  json: boolean;
}

interface ProviderProbe {
  name: string;
  available: boolean;
  detail: string;
}

/**
 * Resolve `~/.relay` lazily so tests can override `HOME` after module load.
 * Without this, `const HOME = homedir()` at import-time freezes the path.
 */
function getRelayDir(): string { return join(homedir(), '.relay'); }
function getConfigPath(): string { return join(getRelayDir(), 'config.json'); }

/**
 * Claude Code stores per-project memory at `~/.claude/projects/<hash>/memory/`
 * where `<hash>` is the absolute project path with `/` replaced by `-` and a
 * leading `-`. Example: `/Users/jo/repos/api` → `-Users-jo-repos-api`.
 *
 * Exported for unit testing — also called internally by `executeInitCommand`.
 */
export function ccMemoryPathFor(workdir: string): string {
  const hash = workdir.replace(/\//g, '-');
  return join(homedir(), '.claude', 'projects', hash, 'memory');
}

async function pathExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function probeCodex(): Promise<ProviderProbe> {
  return new Promise<ProviderProbe>((resolve) => {
    execFile('codex', ['--version'], { encoding: 'utf-8', timeout: 5000 }, (err, stdoutData) => {
      if (err) {
        resolve({ name: 'codex', available: false, detail: 'codex CLI not found on PATH' });
      } else {
        resolve({ name: 'codex', available: true, detail: (stdoutData as string).trim() });
      }
    });
  });
}

function probeEnvKey(name: string, label: string): ProviderProbe {
  const v = process.env[name];
  return v
    ? { name: label, available: true, detail: `${name} set` }
    : { name: label, available: false, detail: `${name} not set` };
}

async function probeLmStudio(): Promise<ProviderProbe> {
  const endpoint = process.env['LMSTUDIO_ENDPOINT'] ?? 'http://localhost:1234';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${endpoint}/v1/models`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { name: 'lmstudio', available: false, detail: `${endpoint} returned ${res.status}` };
    const json = (await res.json()) as { data?: unknown[] };
    const count = Array.isArray(json.data) ? json.data.length : 0;
    return { name: 'lmstudio', available: true, detail: `${endpoint} (${count} models)` };
  } catch {
    clearTimeout(timer);
    return { name: 'lmstudio', available: false, detail: `${endpoint} unreachable` };
  }
}

async function ask(rl: ReturnType<typeof createInterface>, question: string, defaultYes = true): Promise<boolean> {
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  const answer = (await rl.question(question + suffix)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

interface RelayConfig {
  providers?: {
    default?: string;
    codex?: { model?: string; reasoning_effort?: string };
    lmstudio?: { model?: string };
    openrouter?: { model?: string };
  };
  memory?: {
    default_workdir?: string | null;
  };
}

async function readExistingConfig(): Promise<RelayConfig> {
  try {
    return JSON.parse(await readFile(getConfigPath(), 'utf-8')) as RelayConfig;
  } catch {
    return {};
  }
}

async function writeConfig(config: RelayConfig): Promise<void> {
  await mkdir(getRelayDir(), { recursive: true });
  await writeFile(getConfigPath(), JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

export async function executeInitCommand(args: InitArgs, io: CliIO): Promise<number> {
  const relayDir = getRelayDir();
  const configPath = getConfigPath();
  await mkdir(relayDir, { recursive: true });

  if (args.quick) {
    await writeConfig({});
    if (args.json) {
      io.stdout(JSON.stringify({ ok: true, mode: 'quick', config_path: configPath }) + '\n');
    } else {
      io.stdout(`Created ${relayDir}/ with empty config. Done.\n`);
    }
    return 0;
  }

  // Probe providers
  const [codex, lmstudio] = await Promise.all([probeCodex(), probeLmStudio()]);
  const openrouter = probeEnvKey('OPENROUTER_API_KEY', 'openrouter');
  const anthropic = probeEnvKey('ANTHROPIC_API_KEY', 'anthropic');
  const ccMemoryPath = ccMemoryPathFor(io.cwd);
  const ccMemory = await pathExists(ccMemoryPath);

  const config = await readExistingConfig();
  const providers: NonNullable<RelayConfig['providers']> = config.providers ?? {};

  if (!args.json) {
    io.stdout('relay init — first-run setup\n\n');
    io.stdout('Detected providers:\n');
    for (const p of [codex, openrouter, lmstudio, anthropic]) {
      const status = p.available ? '[OK]' : '[--]';
      io.stdout(`  ${p.name.padEnd(12)} ${status} ${p.detail}\n`);
    }
    io.stdout(`  cc-memory    ${ccMemory ? '[OK]' : '[--]'} ${ccMemory ? ccMemoryPath : `not found at ${ccMemoryPath}`}\n\n`);
  }

  const isInteractive = !args.auto && !args.json && stdin.isTTY;
  const rl = isInteractive ? createInterface({ input: stdin, output: stdout }) : null;

  // Pick default provider
  const availableProviders: string[] = [];
  if (codex.available) availableProviders.push('codex');
  if (lmstudio.available) availableProviders.push('lmstudio');
  if (openrouter.available) availableProviders.push('openrouter');
  if (anthropic.available) availableProviders.push('anthropic');

  if (availableProviders.length === 0) {
    if (rl) rl.close();
    io.stderr('No providers detected. Install codex CLI (`npm i -g @openai/codex`) OR set OPENROUTER_API_KEY OR start LM Studio. Then run `relay init` again.\n');
    return 1;
  }

  const preferredDefault = availableProviders.includes('codex') ? 'codex' : availableProviders[0]!;
  providers.default = providers.default ?? preferredDefault;

  // Hook install
  let installHook = false;
  if (rl) {
    installHook = await ask(rl, '\nInstall Claude Code SessionStart hook so memory recall auto-injects on every CC session?');
  } else if (args.auto) {
    installHook = true;
  }

  if (installHook) {
    const { executeMemoryHookCommand } = await import('./cmd-memory-ops.js');
    // In --json mode, route the hook's stdout to a discard sink so init's final
    // JSON object is the only thing on stdout (single parseable object).
    // In human mode, init prints its own confirmation lines and the hook's
    // human stdout is fine to interleave.
    const hookIo: CliIO = args.json
      ? { cwd: io.cwd, stdout: () => {}, stderr: io.stderr }
      : io;
    // Wrap in try/catch — a read-only or non-existent .claude/ path should not
    // crash init. Init's primary job is config; the hook is best-effort.
    try {
      await executeMemoryHookCommand({ install: true, json: false }, hookIo, io.cwd);
    } catch (err) {
      installHook = false;
      if (!args.json) {
        io.stderr(`(skipped hook install: ${(err as Error).message})\n`);
      }
    }
  }

  // CC memory migration offer
  let migrateMemory = false;
  if (rl && ccMemory) {
    migrateMemory = await ask(rl, `\nFound Claude Code auto-memory at ${ccMemoryPath}. Migrate to Relay's memory store?`);
  }

  if (migrateMemory) {
    io.stdout('\nRun: node dist/scripts/migrate-cc-memory.js --apply\n');
    io.stdout('(Run --inventory + --dry-run first to inspect.)\n');
  }

  // Write config
  config.providers = providers;
  await writeConfig(config);

  if (rl) rl.close();

  if (args.json) {
    io.stdout(
      JSON.stringify({
        ok: true,
        config_path: configPath,
        providers: { default: providers.default, available: availableProviders },
        hook_installed: installHook,
        cc_memory_found: ccMemory,
      }) + '\n'
    );
  } else {
    io.stdout(`\n✓ Wrote ${configPath}\n`);
    io.stdout(`✓ Default provider: ${providers.default}\n`);
    io.stdout(`\nTry: relay run "what is 2+2? answer in one word" --provider ${providers.default}${providers.default !== 'codex' ? ' --model <id>' : ''}\n`);
    io.stdout(`     relay history\n`);
    io.stdout(`     relay doctor\n`);
  }

  return 0;
}
