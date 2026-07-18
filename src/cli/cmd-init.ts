/**
 * `relay init` — interactive setup wizard for first-time users.
 *
 * Detects providers, offers to wire SessionStart hook (defaults to global so
 * the hook fires in every CC project), optionally wires the SessionEnd
 * auto-extract hook, optionally records a chosen LM Studio model into config
 * for the auto-extract pipeline, and finally verifies the round-trip by
 * running `relay context emit --target cc` and confirming the CC envelope
 * shape.
 *
 * Modes:
 *   relay init             — interactive (default), Y/n prompts with sensible defaults
 *   relay init --auto      — non-interactive, accept all sensible defaults
 *   relay init --quick     — bare minimum (creates ~/.relay/, writes empty config, no prompts)
 *
 * New flags (T36):
 *   --global-hook                 install SessionStart hook to ~/.claude (default true)
 *   --no-global-hook              install to per-project .claude/ instead
 *   --session-end-hook            also install SessionEnd auto-extract hook (default false)
 *   --lm-model <id>               record this LM Studio model into config.auto_extract.model
 *   --no-shell-edit               reserved — currently a no-op marker for shell-rc edits
 *   --enable-auto-extract         write per-workdir consent file for io.cwd
 */

import type { CliIO } from './commands.js';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { probeCodex, probeLmStudio, probeEnvKey } from './probes.js';

export interface InitArgs {
  auto: boolean;
  quick: boolean;
  json: boolean;
  globalHook?: boolean;
  sessionEndHook?: boolean;
  lmModel?: string;
  noShellEdit?: boolean;
  enableAutoExtract?: boolean;
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
  auto_extract?: {
    model?: string;
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

interface LoadedLmModel { id: string }

/**
 * Fetch loaded model IDs from LM Studio's HTTP API. Returns [] if unreachable
 * or response is malformed — never throws. 3s timeout matches probeLmStudio.
 */
async function fetchLmStudioModels(): Promise<LoadedLmModel[]> {
  const endpoint = process.env['LMSTUDIO_ENDPOINT'] ?? 'http://localhost:1234';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${endpoint}/v1/models`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(json.data)) return [];
    return json.data
      .map((m) => (typeof m?.id === 'string' ? { id: m.id } : null))
      .filter((m): m is LoadedLmModel => m !== null);
  } catch {
    clearTimeout(timer);
    return [];
  }
}

/** Pick a model interactively from a numbered list; returns the chosen id or null. */
async function pickLmModel(
  rl: ReturnType<typeof createInterface>,
  models: LoadedLmModel[],
  io: CliIO
): Promise<string | null> {
  if (models.length === 0) return null;
  io.stdout('\nLM Studio models loaded:\n');
  models.forEach((m, i) => io.stdout(`  ${i + 1}) ${m.id}\n`));
  io.stdout('  0) skip\n');
  const ans = (await rl.question('Pick a model for auto-extract [1]: ')).trim();
  if (ans === '0') return null;
  const idx = ans === '' ? 0 : Number.parseInt(ans, 10) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx >= models.length) return null;
  return models[idx]!.id;
}

/**
 * Round-trip verification — runs `relay context emit --target cc` for the
 * current workdir and validates the JSON envelope shape CC expects. Returns
 * `{ ok, detail }` so the caller can report PASS/FAIL without re-parsing.
 */
async function verifyContextEmitRoundTrip(
  cwd: string
): Promise<{ ok: boolean; detail: string }> {
  const captured: string[] = [];
  const verifyIo: CliIO = {
    cwd,
    stdout: (m) => captured.push(m),
    stderr: () => {},
  };
  try {
    const { executeContextEmitCommand } = await import('./cmd-context-emit.js');
    const code = await executeContextEmitCommand(
      { target: 'cc', workdir: cwd, tokenBudget: 800, types: ['lesson', 'fact', 'decision', 'context'] },
      verifyIo
    );
    if (code !== 0) return { ok: false, detail: `exit code ${code}` };
    const out = captured.join('').trim();
    if (!out) return { ok: false, detail: 'empty output' };
    const parsed = JSON.parse(out) as { hookSpecificOutput?: { hookEventName?: unknown; additionalContext?: unknown } };
    const hso = parsed.hookSpecificOutput;
    if (!hso || hso.hookEventName !== 'SessionStart' || typeof hso.additionalContext !== 'string') {
      return { ok: false, detail: 'missing hookSpecificOutput.{hookEventName,additionalContext}' };
    }
    return { ok: true, detail: 'hookSpecificOutput shape valid' };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
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
      const badge = p.status === 'ok' ? '[OK]' : '[--]';
      io.stdout(`  ${p.name.padEnd(12)} ${badge} ${p.detail}\n`);
    }
    io.stdout(`  cc-memory    ${ccMemory ? '[OK]' : '[--]'} ${ccMemory ? ccMemoryPath : `not found at ${ccMemoryPath}`}\n\n`);
  }

  const isInteractive = !args.auto && !args.json && stdin.isTTY;
  const rl = isInteractive ? createInterface({ input: stdin, output: stdout }) : null;

  // Pick default provider
  const availableProviders: string[] = [];
  if (codex.status === 'ok') availableProviders.push('codex');
  if (lmstudio.status === 'ok') availableProviders.push('lmstudio');
  if (openrouter.status === 'ok') availableProviders.push('openrouter');
  if (anthropic.status === 'ok') availableProviders.push('anthropic');

  if (availableProviders.length === 0) {
    if (rl) rl.close();
    io.stderr('No providers detected. Install codex CLI (`npm i -g @openai/codex`) OR set OPENROUTER_API_KEY OR start LM Studio. Then run `relay init` again.\n');
    return 1;
  }

  const preferredDefault = availableProviders.includes('codex') ? 'codex' : availableProviders[0]!;
  providers.default = providers.default ?? preferredDefault;

  // Step 4 — SessionStart hook (defaults to global)
  // CLI flag overrides everything; prompt only when interactive AND flag absent.
  const wantGlobal = args.globalHook !== false; // default true
  let installHook = false;
  if (rl) {
    installHook = await ask(
      rl,
      `\nInstall Claude Code SessionStart hook (${wantGlobal ? 'global ~/.claude' : 'per-project .claude'}) so memory recall auto-injects?`
    );
  } else if (args.auto) {
    installHook = true;
  }

  let hookGlobal = wantGlobal;
  if (installHook) {
    const { executeMemoryHookCommand } = await import('./cmd-memory-ops.js');
    const hookIo: CliIO = args.json ? { cwd: io.cwd, stdout: () => {}, stderr: io.stderr } : io;
    try {
      await executeMemoryHookCommand(
        { install: true, json: false, global: hookGlobal },
        hookIo,
        io.cwd
      );
    } catch (err) {
      installHook = false;
      if (!args.json) io.stderr(`(skipped hook install: ${(err as Error).message})\n`);
    }
  }

  // Step 5 — SessionEnd auto-extract hook (defaults to off)
  const wantSessionEnd = args.sessionEndHook === true;
  let installSessionEnd = false;
  if (rl) {
    installSessionEnd = await ask(rl, 'Install SessionEnd auto-extract hook?', false);
  } else if (args.auto) {
    installSessionEnd = wantSessionEnd;
  }

  if (installSessionEnd) {
    const { executeMemoryHookCommand } = await import('./cmd-memory-ops.js');
    const hookIo: CliIO = args.json ? { cwd: io.cwd, stdout: () => {}, stderr: io.stderr } : io;
    try {
      await executeMemoryHookCommand(
        { install: true, json: false, global: hookGlobal, sessionEnd: true },
        hookIo,
        io.cwd
      );
    } catch (err) {
      installSessionEnd = false;
      if (!args.json) io.stderr(`(skipped session-end hook: ${(err as Error).message})\n`);
    }
  }

  // Step 6 — LM Studio model picker (only when LM Studio is reachable)
  let chosenLmModel: string | null = null;
  if (args.lmModel) {
    chosenLmModel = args.lmModel;
  } else if (lmstudio.status === 'ok') {
    const models = await fetchLmStudioModels();
    if (models.length > 0) {
      if (rl) {
        chosenLmModel = await pickLmModel(rl, models, io);
      } else if (args.auto && models[0]) {
        chosenLmModel = models[0].id;
      }
    }
  }
  if (chosenLmModel) {
    config.auto_extract = { ...(config.auto_extract ?? {}), model: chosenLmModel };
  }

  // Step 6b — Wire detected LLM CLIs (T17)
  // For each provider whose probe succeeded, optionally call the per-LLM setup
  // helper from cmd-setup-llm.ts. Interactive: Y/n confirm with default Y.
  // --auto / --yes: wire without prompting. Errors per provider are warned but
  // do not abort init.
  const llmWiringResults: Array<{
    provider: string;
    wired: boolean;
    skipped?: 'declined' | 'not-detected' | 'error';
    detail?: string;
  }> = [];
  const llmTargets = [
    { name: 'codex', detected: codex.status === 'ok' },
    { name: 'lmstudio', detected: lmstudio.status === 'ok' },
    { name: 'openrouter', detected: openrouter.status === 'ok' },
    { name: 'anthropic', detected: anthropic.status === 'ok' },
  ] as const;

  for (const t of llmTargets) {
    if (!t.detected) {
      llmWiringResults.push({ provider: t.name, wired: false, skipped: 'not-detected' });
      continue;
    }
    let wantWire = false;
    if (rl) {
      wantWire = await ask(rl, `\nWire Relay context-emit into ${t.name}?`);
    } else if (args.auto) {
      wantWire = true;
    }
    if (!wantWire) {
      llmWiringResults.push({ provider: t.name, wired: false, skipped: 'declined' });
      continue;
    }
    try {
      const { setupCodex, setupLmStudio, setupOpenRouter, setupAnthropic } =
        await import('./cmd-setup-llm.js');
      const setupArgs = { target: t.name, write: true, json: true } as const;
      const result =
        t.name === 'codex' ? await setupCodex(setupArgs as never) :
        t.name === 'lmstudio' ? await setupLmStudio(setupArgs as never) :
        t.name === 'openrouter' ? await setupOpenRouter(setupArgs as never) :
        await setupAnthropic(setupArgs as never);
      llmWiringResults.push({
        provider: t.name,
        wired: result.ok,
        detail: result.ok ? result.actions[0] : (result.warnings[0] ?? 'setup returned not-ok'),
        ...(result.ok ? {} : { skipped: 'error' as const }),
      });
      if (!args.json) {
        const badge = result.ok ? '✓' : '!';
        io.stdout(`${badge} setup-llm ${t.name}: ${result.ok ? 'wired' : (result.warnings[0] ?? 'failed')}\n`);
      }
    } catch (err) {
      llmWiringResults.push({
        provider: t.name,
        wired: false,
        skipped: 'error',
        detail: (err as Error).message,
      });
      if (!args.json) {
        io.stderr(`(skipped setup-llm ${t.name}: ${(err as Error).message})\n`);
      }
    }
  }

  // Step 6c — Register the Relay MCP server with detected MCP clients
  // (Claude Code via its CLI, Claude Desktop, Cursor, Codex). Idempotent;
  // per-client failures are reported, never abort init.
  let mcpClientResults: import('./mcp-clients.js').McpWireResult[] = [];
  {
    let wantMcpWire = false;
    if (rl) {
      wantMcpWire = await ask(rl, '\nRegister the Relay memory MCP server with detected clients (Claude Code/Desktop, Cursor, Codex)?');
    } else {
      wantMcpWire = true;
    }
    if (wantMcpWire) {
      try {
        const { wireMcpClients } = await import('./mcp-clients.js');
        mcpClientResults = wireMcpClients();
      } catch (err) {
        if (!args.json) io.stderr(`(mcp client wiring failed: ${(err as Error).message})\n`);
      }
      if (!args.json) {
        for (const r of mcpClientResults) {
          const badge = r.status === 'wired' || r.status === 'already' ? '✓' : r.status === 'not-detected' ? '—' : '!';
          io.stdout(`${badge} mcp ${r.client}: ${r.status}${r.status === 'not-detected' ? '' : ` (${r.detail})`}\n`);
        }
      }
    }
  }

  // Per-workdir auto-extract consent (--enable-auto-extract)
  let enabledAutoExtract = false;
  if (args.enableAutoExtract) {
    try {
      const { executeMemoryAutoExtractEnableCommand } = await import('./cmd-memory-auto-extract-enable.js');
      const enableIo: CliIO = args.json ? { cwd: io.cwd, stdout: () => {}, stderr: io.stderr } : io;
      const code = await executeMemoryAutoExtractEnableCommand(
        { allowRemote: false, workdir: io.cwd, json: false },
        enableIo
      );
      enabledAutoExtract = code === 0;
    } catch (err) {
      if (!args.json) io.stderr(`(skipped auto-extract enable: ${(err as Error).message})\n`);
    }
  }

  // Persist config (providers + auto_extract.model if chosen)
  config.providers = providers;
  await writeConfig(config);

  // Step 7 — Verify round-trip
  const verify = await verifyContextEmitRoundTrip(io.cwd);

  if (rl) rl.close();

  if (args.json) {
    io.stdout(
      JSON.stringify({
        ok: true,
        config_path: configPath,
        providers: { default: providers.default, available: availableProviders },
        hook_installed: installHook,
        hook_global: installHook ? hookGlobal : false,
        session_end_hook_installed: installSessionEnd,
        cc_memory_found: ccMemory,
        lm_model: chosenLmModel,
        auto_extract_enabled: enabledAutoExtract,
        llm_wiring: llmWiringResults,
        mcp_clients: mcpClientResults,
        verify: { ok: verify.ok, detail: verify.detail },
      }) + '\n'
    );
  } else {
    io.stdout(`\n✓ Wrote ${configPath}\n`);
    io.stdout(`✓ Default provider: ${providers.default}\n`);
    if (chosenLmModel) io.stdout(`✓ LM model for auto-extract: ${chosenLmModel}\n`);
    if (enabledAutoExtract) io.stdout(`✓ Auto-extract consent enabled for ${io.cwd}\n`);
    io.stdout(`${verify.ok ? '✓' : '✗'} Verify (context emit cc): ${verify.ok ? 'PASS' : 'FAIL'} — ${verify.detail}\n`);
    io.stdout(`\nTry: relay run "what is 2+2? answer in one word" --provider ${providers.default}${providers.default !== 'codex' ? ' --model <id>' : ''}\n`);
    io.stdout(`     relay history\n`);
    io.stdout(`     relay doctor\n`);
  }

  return 0;
}
