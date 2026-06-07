/**
 * `relay setup-llm <target>` — per-LLM init helpers.
 *
 * Targets:
 *   codex      — write/update ~/.codex/AGENTS.md block (delimited by relay-managed markers)
 *                instructing Codex to consume Relay memories. Verifies codex CLI.
 *   lmstudio   — probe localhost:1234/v1/models, list loaded models, print recommended
 *                invocation (`relay-llm <model> "<task>"`). With --write, install
 *                ~/.local/bin/relay-llm wrapper.
 *   openrouter — check OPENROUTER_API_KEY. If set, list available models. If not,
 *                print env-var setup instructions.
 *   anthropic  — check ANTHROPIC_API_KEY. Print setup instructions if missing.
 *
 * Modes:
 *   default    — dry-run; print what would happen.
 *   --write    — actually modify files.
 *   --json     — emit structured JSON output.
 */

import type { CliIO } from './commands.js';
import { readFile, writeFile, mkdir, stat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { probeLmStudio, probeEnvKey } from './probes.js';
import { c, statusBadge } from './colors.js';
import {
  RELAY_MANAGED_START,
  RELAY_MANAGED_END,
  probeCodexControlSetup,
  deriveCodexCapabilities,
} from '../control/adapters/codex.js';

export type SetupLlmTarget = 'codex' | 'lmstudio' | 'openrouter' | 'anthropic';

export interface SetupLlmArgs {
  target: SetupLlmTarget;
  write: boolean;
  json: boolean;
}

export interface SetupLlmResult {
  ok: boolean;
  target: SetupLlmTarget;
  write: boolean;
  actions: string[];
  warnings: string[];
  details: Record<string, unknown>;
}

const CODEX_AGENTS_BLOCK = `${RELAY_MANAGED_START}
## Relay Memory Integration

This Codex environment is integrated with Relay (https://github.com/ghanavati/relay).
Relay maintains a persistent, cross-session memory store of facts, decisions, and lessons.

Before starting work on any task, consume the recalled context:

\`\`\`bash
relay memory recall --token-budget 800 --json 2>/dev/null || true
\`\`\`

Use the returned memories as additional grounding context. They contain
prior decisions, lessons learned, and project-specific facts that should
inform your output.

To save a new memory after completing meaningful work:

\`\`\`bash
relay memory remember "<concise observation>" --type lesson|decision|fact
\`\`\`

Tags help future recall: \`--tag <topic>\` (repeatable).
${RELAY_MANAGED_END}`;

const RELAY_LLM_WRAPPER = `#!/usr/bin/env bash
# relay-llm — thin wrapper around an LM Studio model invocation.
# Usage: relay-llm <model_id> "<task>"
# Reads stdin if no task argument provided.
set -euo pipefail

MODEL="\${1:-}"
TASK="\${2:-}"
ENDPOINT="\${LMSTUDIO_ENDPOINT:-http://localhost:1234}"

if [ -z "$MODEL" ]; then
  echo "Usage: relay-llm <model_id> \\"<task>\\"" >&2
  exit 2
fi

if [ -z "$TASK" ]; then
  TASK="$(cat)"
fi

curl -sS "$ENDPOINT/v1/chat/completions" \\
  -H "Content-Type: application/json" \\
  -d "$(printf '{"model":"%s","messages":[{"role":"user","content":%s}]}' \\
    "$MODEL" \\
    "$(printf '%s' "$TASK" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")" \\
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["choices"][0]["message"]["content"])'
`;

function getCodexAgentsPath(): string {
  return join(homedir(), '.codex', 'AGENTS.md');
}

function getRelayLlmPath(): string {
  return join(homedir(), '.local', 'bin', 'relay-llm');
}

async function pathExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

interface CodexAuthStatus {
  ok: boolean;
  detail: string;
}

async function checkCodexAuth(): Promise<CodexAuthStatus> {
  return new Promise<CodexAuthStatus>((resolve) => {
    execFile('codex', ['auth', 'status'], { encoding: 'utf-8', timeout: 5000 }, (err, stdoutData) => {
      if (err) {
        resolve({ ok: false, detail: 'codex auth status failed (codex not on PATH or not authenticated)' });
      } else {
        const out = (stdoutData as string).trim();
        resolve({ ok: true, detail: out.length > 0 ? out.split('\n')[0]! : 'authenticated' });
      }
    });
  });
}

/** Replace any existing relay-managed block in `text`, or append one. */
function upsertManagedBlock(text: string, block: string): string {
  const start = text.indexOf(RELAY_MANAGED_START);
  const end = text.indexOf(RELAY_MANAGED_END);
  if (start !== -1 && end !== -1 && end > start) {
    const before = text.slice(0, start);
    const after = text.slice(end + RELAY_MANAGED_END.length);
    return before + block + after;
  }
  // Append. Ensure a trailing newline before the block if file is non-empty.
  const sep = text.length > 0 && !text.endsWith('\n') ? '\n\n' : (text.length > 0 ? '\n' : '');
  return text + sep + block + '\n';
}

export async function setupCodex(args: SetupLlmArgs): Promise<SetupLlmResult> {
  const actions: string[] = [];
  const warnings: string[] = [];
  const agentsPath = getCodexAgentsPath();

  // 1. Verify codex CLI on PATH + auth status.
  const auth = await checkCodexAuth();
  if (!auth.ok) {
    warnings.push(auth.detail);
  }

  // 2. Write/update AGENTS.md.
  const exists = await pathExists(agentsPath);
  let existing = '';
  if (exists) {
    try { existing = await readFile(agentsPath, 'utf-8'); } catch (err) {
      warnings.push(`failed to read existing AGENTS.md: ${(err as Error).message}`);
    }
  }
  const updated = upsertManagedBlock(existing, CODEX_AGENTS_BLOCK);
  const wouldChange = updated !== existing;

  if (args.write && wouldChange) {
    await mkdir(join(homedir(), '.codex'), { recursive: true });
    await writeFile(agentsPath, updated, 'utf-8');
    actions.push(`wrote relay-managed block to ${agentsPath}`);
  } else if (wouldChange) {
    actions.push(`would write relay-managed block to ${agentsPath}`);
  } else {
    actions.push(`relay-managed block already present in ${agentsPath}`);
  }

  // 3. Phase 8 / CONTROL-08 — discover the conservative control capability
  // set for codex sessions. Probed AFTER the write step so --write reports
  // the post-install truth. Discovery never claims live control: full-TTY
  // CLIs Relay does not own are out of live_stdin/resume_send scope in v1.
  const controlProbe = await probeCodexControlSetup({ agentsPath });
  const controlCapabilities = deriveCodexCapabilities(controlProbe);
  actions.push(
    `control: conservative capability discovery — context_inject/mailbox require the ` +
      `Relay instructions block, tool_call requires a Relay MCP server entry; ` +
      `live_stdin/resume_send are never claimed for sessions Relay does not own.`
  );
  actions.push(`control capabilities now discoverable: ${controlCapabilities.join(', ')}`);

  return {
    ok: true,
    target: 'codex',
    write: args.write,
    actions,
    warnings,
    details: {
      agents_path: agentsPath,
      codex_auth_ok: auth.ok,
      codex_auth_detail: auth.detail,
      block_changed: wouldChange,
      control_capabilities: [...controlCapabilities],
      control_instructions_present: controlProbe.instructions_present,
      control_mcp_configured: controlProbe.mcp_configured,
    },
  };
}

interface LmStudioModel {
  id: string;
}

export async function setupLmStudio(args: SetupLlmArgs): Promise<SetupLlmResult> {
  const actions: string[] = [];
  const warnings: string[] = [];
  const probe = await probeLmStudio();

  let models: LmStudioModel[] = [];
  if (probe.status === 'ok') {
    const endpoint = process.env['LMSTUDIO_ENDPOINT'] ?? 'http://localhost:1234';
    try {
      const res = await fetch(`${endpoint}/v1/models`);
      if (res.ok) {
        const json = (await res.json()) as { data?: LmStudioModel[] };
        models = Array.isArray(json.data) ? json.data : [];
      }
    } catch (err) {
      warnings.push(`failed to fetch model list: ${(err as Error).message}`);
    }
  } else {
    warnings.push(probe.detail);
  }

  // Recommended invocation
  const exampleModel = models[0]?.id ?? '<model-id>';
  actions.push(`recommended invocation: relay-llm ${exampleModel} "<task>"`);

  // Wrapper installer
  const wrapperPath = getRelayLlmPath();
  const wrapperExists = await pathExists(wrapperPath);

  if (!wrapperExists) {
    if (args.write) {
      await mkdir(join(homedir(), '.local', 'bin'), { recursive: true });
      await writeFile(wrapperPath, RELAY_LLM_WRAPPER, 'utf-8');
      try { await chmod(wrapperPath, 0o755); } catch { /* best-effort */ }
      actions.push(`installed wrapper at ${wrapperPath}`);
    } else {
      actions.push(`would install wrapper at ${wrapperPath} (rerun with --write)`);
    }
  } else {
    actions.push(`wrapper already present at ${wrapperPath}`);
  }

  return {
    ok: probe.status === 'ok',
    target: 'lmstudio',
    write: args.write,
    actions,
    warnings,
    details: {
      probe_status: probe.status,
      probe_detail: probe.detail,
      model_count: models.length,
      models: models.slice(0, 20).map(m => m.id),
      wrapper_path: wrapperPath,
      wrapper_present: wrapperExists,
    },
  };
}

interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
}

async function fetchOpenRouterModels(apiKey: string): Promise<OpenRouterModel[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: OpenRouterModel[] };
    return Array.isArray(json.data) ? json.data : [];
  } catch {
    clearTimeout(timer);
    return [];
  }
}

export async function setupOpenRouter(args: SetupLlmArgs): Promise<SetupLlmResult> {
  const actions: string[] = [];
  const warnings: string[] = [];
  const probe = probeEnvKey('OPENROUTER_API_KEY', 'openrouter');

  let models: OpenRouterModel[] = [];
  if (probe.status === 'ok') {
    const apiKey = process.env['OPENROUTER_API_KEY']!;
    models = await fetchOpenRouterModels(apiKey);
    if (models.length === 0) {
      warnings.push('OPENROUTER_API_KEY set but model list empty (network or auth failure)');
    } else {
      const top = models.slice(0, 5).map(m => m.id).join(', ');
      actions.push(`OPENROUTER_API_KEY set; ${models.length} models available. Top: ${top}`);
    }
  } else {
    actions.push('OPENROUTER_API_KEY not set. Setup:');
    actions.push('  1. Create an account at https://openrouter.ai');
    actions.push('  2. Generate an API key at https://openrouter.ai/keys');
    actions.push('  3. export OPENROUTER_API_KEY=<your-key-here>');
    actions.push('  4. Add to your shell rc (~/.bashrc, ~/.zshrc) for persistence');
  }

  return {
    ok: probe.status === 'ok',
    target: 'openrouter',
    write: args.write,
    actions,
    warnings,
    details: {
      probe_status: probe.status,
      probe_detail: probe.detail,
      model_count: models.length,
      top_models: models.slice(0, 10).map(m => m.id),
    },
  };
}

export async function setupAnthropic(args: SetupLlmArgs): Promise<SetupLlmResult> {
  const actions: string[] = [];
  const warnings: string[] = [];
  const probe = probeEnvKey('ANTHROPIC_API_KEY', 'anthropic');

  if (probe.status === 'ok') {
    actions.push('ANTHROPIC_API_KEY set. Recommended models: claude-sonnet-4, claude-opus-4');
  } else {
    actions.push('ANTHROPIC_API_KEY not set. Setup:');
    actions.push('  1. Create an account at https://console.anthropic.com');
    actions.push('  2. Generate an API key at https://console.anthropic.com/settings/keys');
    actions.push('  3. export ANTHROPIC_API_KEY=<your-key-here>');
    actions.push('  4. Add to your shell rc (~/.bashrc, ~/.zshrc) for persistence');
  }

  return {
    ok: probe.status === 'ok',
    target: 'anthropic',
    write: args.write,
    actions,
    warnings,
    details: {
      probe_status: probe.status,
      probe_detail: probe.detail,
    },
  };
}

export async function executeSetupLlmCommand(args: SetupLlmArgs, io: CliIO): Promise<number> {
  let result: SetupLlmResult;

  switch (args.target) {
    case 'codex':
      result = await setupCodex(args);
      break;
    case 'lmstudio':
      result = await setupLmStudio(args);
      break;
    case 'openrouter':
      result = await setupOpenRouter(args);
      break;
    case 'anthropic':
      result = await setupAnthropic(args);
      break;
    default: {
      const valid: SetupLlmTarget[] = ['codex', 'lmstudio', 'openrouter', 'anthropic'];
      io.stderr(`unsupported --target: ${String(args.target)}. Try ${valid.join(' / ')}.\n`);
      return 2;
    }
  }

  if (args.json) {
    io.stdout(JSON.stringify(result) + '\n');
  } else {
    io.stdout(c.bold(`relay setup-llm ${args.target}`) + (args.write ? '' : c.dim(' (dry-run; pass --write to apply)')) + '\n\n');
    io.stdout(`status: ${statusBadge(result.ok ? 'ok' : 'failed')}\n`);
    if (result.actions.length > 0) {
      io.stdout('\nactions:\n');
      for (const a of result.actions) io.stdout(`  ${a}\n`);
    }
    if (result.warnings.length > 0) {
      io.stdout('\nwarnings:\n');
      for (const w of result.warnings) io.stdout(`  ${c.yellow('!')} ${w}\n`);
    }
    io.stdout('\n');
  }

  return result.ok ? 0 : 1;
}
