#!/usr/bin/env node
/**
 * Relay solo CLI v0.1.0 — entry point.
 *
 * Surface (v0.1.0):
 *   relay memory remember <content> [--type ...] [--tag ...] [--pinned] [--json]
 *   relay memory recall [<query>] [--type ...] [--tag ...] [--token-budget N] [--json]
 *   relay memory show-context <query> [--type ...] [--token-budget N] [--json]
 *   relay memory get <memory_id> [--json]
 *   relay memory hook --install | --uninstall [--json]
 *   relay memory to-rules <memory_id> [--rules-file path]
 *   relay --help
 *   relay --version
 *
 * Future (v0.2+): relay run, relay parallel, relay history, relay diff,
 * relay compare, relay init, relay doctor, relay budget.
 */

import { argv, exit, cwd, env } from 'node:process';
import type { CliIO } from './cli/commands.js';

const VERSION = '0.1.0';

const io: CliIO = {
  cwd: cwd(),
  stdout: (m) => process.stdout.write(m),
  stderr: (m) => process.stderr.write(m),
};

interface ParsedFlags {
  positionals: string[];
  options: Map<string, string[]>;
  booleans: Set<string>;
}

function parseFlags(args: readonly string[]): ParsedFlags {
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  const booleans = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        const k = arg.slice(2, eq);
        const v = arg.slice(eq + 1);
        const list = options.get(k) ?? [];
        list.push(v);
        options.set(k, list);
      } else {
        const k = arg.slice(2);
        const next = args[i + 1];
        if (next && !next.startsWith('--')) {
          const list = options.get(k) ?? [];
          list.push(next);
          options.set(k, list);
          i++;
        } else {
          booleans.add(k);
        }
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, options, booleans };
}

const lastOption = (f: ParsedFlags, k: string): string | undefined => f.options.get(k)?.at(-1);
const allOptions = (f: ParsedFlags, k: string): string[] => f.options.get(k) ?? [];
const isBool = (f: ParsedFlags, k: string): boolean => f.booleans.has(k);

function printHelp(): void {
  io.stdout(`relay v${VERSION} — solo CLI for AI delegation + memory

USAGE
  relay <command> [args] [--flags]

MEMORY COMMANDS
  relay memory remember <content>          Save a memory entry
    [--type fact|decision|lesson|context|state|handoff]   (default: fact)
    [--tag <tag>] (repeatable)
    [--pinned]
    [--workdir <path>]
    [--expires-in <hours>]
    [--json]

  relay memory recall [<query>]            Recall memories matching a query
    [--type <t>] (repeatable)
    [--tag <t>] (repeatable)
    [--token-budget <N>]                   (default: 4000)
    [--workdir <path>]
    [--include-expired]
    [--json]

  relay memory show-context <query>        Preview the recalled_lessons context layer
    [--type <t>] (repeatable, default: lesson + decision)
    [--token-budget <N>]                   (default: 800)
    [--workdir <path>]
    [--json]

  relay memory get <memory_id> [--json]    Inspect one memory entry

  relay memory hook --install              Install a CC SessionStart hook
  relay memory hook --uninstall            Remove the CC SessionStart hook

  relay memory to-rules <memory_id>        Promote a memory to .claude/CLAUDE.md
    [--rules-file <path>]

GENERAL
  relay --help, -h                         Show this help
  relay --version, -V                      Show version

NOT YET IMPLEMENTED IN v0.1.0
  relay run, relay parallel, relay history, relay diff, relay compare,
  relay init, relay doctor, relay budget — see ROADMAP.md.

DOCS
  https://github.com/ghanavati/relay/tree/main/docs
`);
}

async function dispatchRun(rest: readonly string[]): Promise<number> {
  const flags = parseFlags(rest);
  const task = flags.positionals.join(' ').trim();
  if (!task) {
    io.stderr('relay run requires a task. Try: relay run "fix the failing test"\n');
    return 2;
  }
  const provider = (lastOption(flags, 'provider') ?? 'codex') as 'codex' | 'openrouter' | 'lmstudio';
  if (!['codex', 'openrouter', 'lmstudio'].includes(provider)) {
    io.stderr(`unsupported --provider: ${provider}. Try codex / openrouter / lmstudio.\n`);
    return 2;
  }
  const timeoutMsRaw = lastOption(flags, 'timeout-ms');
  const timeoutMs = timeoutMsRaw ? Number.parseInt(timeoutMsRaw, 10) : 300_000;

  const { executeRunCommand } = await import('./cli/cmd-run.js');
  return executeRunCommand({
    task,
    provider,
    model: lastOption(flags, 'model'),
    workdir: lastOption(flags, 'workdir') ?? io.cwd,
    timeoutMs,
    reasoningEffort: lastOption(flags, 'reasoning-effort'),
    json: isBool(flags, 'json'),
  }, io);
}

async function dispatchMemory(rest: readonly string[]): Promise<number> {
  const flags = parseFlags(rest);
  const action = flags.positionals[0];

  if (!action) {
    io.stderr('relay memory requires an action: remember | recall | show-context | get | hook | to-rules\n');
    return 2;
  }

  if (action === 'remember') {
    const content = flags.positionals.slice(1).join(' ').trim();
    if (!content) {
      io.stderr('relay memory remember requires <content>\n');
      return 2;
    }
    const memoryType = (lastOption(flags, 'type') ?? 'fact') as
      | 'fact' | 'decision' | 'lesson' | 'context' | 'state' | 'handoff';
    const valid = ['fact', 'decision', 'lesson', 'context', 'state', 'handoff'];
    if (!valid.includes(memoryType)) {
      io.stderr(`--type must be one of: ${valid.join(', ')}\n`);
      return 2;
    }
    const expiresInRaw = lastOption(flags, 'expires-in');
    const { executeRememberCommand } = await import('./cli/cmd-memory-ops.js');
    return executeRememberCommand({
      content,
      memoryType,
      tags: allOptions(flags, 'tag'),
      pinned: isBool(flags, 'pinned'),
      workdir: lastOption(flags, 'workdir'),
      expiresInHours: expiresInRaw ? Number.parseFloat(expiresInRaw) : undefined,
      json: isBool(flags, 'json'),
    }, io);
  }

  if (action === 'recall') {
    const query = flags.positionals.slice(1).join(' ').trim() || undefined;
    const tokenBudgetRaw = lastOption(flags, 'token-budget');
    const createdAfter = lastOption(flags, 'created-after');
    const createdBefore = lastOption(flags, 'created-before');
    const { executeRecallCommand } = await import('./cli/cmd-memory-ops.js');
    return executeRecallCommand({
      query,
      tags: allOptions(flags, 'tag'),
      types: allOptions(flags, 'type').length > 0 ? allOptions(flags, 'type') : undefined,
      tokenBudget: tokenBudgetRaw ? Number.parseInt(tokenBudgetRaw, 10) : 4000,
      workdir: lastOption(flags, 'workdir'),
      includeExpired: isBool(flags, 'include-expired'),
      createdAfter: createdAfter ? Number.parseInt(createdAfter, 10) : undefined,
      createdBefore: createdBefore ? Number.parseInt(createdBefore, 10) : undefined,
      file: lastOption(flags, 'file'),
      json: isBool(flags, 'json'),
    }, io);
  }

  if (action === 'get' || action === 'get-memory') {
    const memoryId = flags.positionals[1];
    if (!memoryId) {
      io.stderr('relay memory get requires <memory_id>\n');
      return 2;
    }
    const { executeGetMemoryCommand } = await import('./cli/cmd-memory-ops.js');
    return executeGetMemoryCommand({ memoryId, json: isBool(flags, 'json') }, io);
  }

  if (action === 'hook') {
    const install = isBool(flags, 'install') || !isBool(flags, 'uninstall');
    const { executeMemoryHookCommand } = await import('./cli/cmd-memory-ops.js');
    return executeMemoryHookCommand({ install, json: isBool(flags, 'json') }, io, io.cwd);
  }

  if (action === 'to-rules') {
    const memoryId = flags.positionals[1];
    if (!memoryId) {
      io.stderr('relay memory to-rules requires <memory_id>\n');
      return 2;
    }
    const rulesFile = lastOption(flags, 'rules-file') ?? '.claude/CLAUDE.md';
    const { executeMemoryToRulesCommand } = await import('./cli/cmd-memory-ops.js');
    return executeMemoryToRulesCommand({ memoryId, rulesFile, json: isBool(flags, 'json') }, io, io.cwd);
  }

  io.stderr(`relay memory: unknown action '${action}'. Try: remember, recall, show-context, get, hook, to-rules\n`);
  return 2;
}

async function main(): Promise<number> {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    printHelp();
    return 0;
  }
  if (args[0] === '--version' || args[0] === '-V' || args[0] === 'version') {
    io.stdout(`relay v${VERSION}\n`);
    return 0;
  }

  const cmd = args[0];
  const rest = args.slice(1);

  if (cmd === 'memory') {
    return dispatchMemory(rest);
  }

  if (cmd === 'run') {
    return dispatchRun(rest);
  }

  // v0.2+ stubs
  const futureCmds = ['parallel', 'history', 'diff', 'compare', 'init', 'doctor', 'budget', 'corpus'];
  if (cmd && futureCmds.includes(cmd)) {
    io.stderr(`relay ${cmd}: not implemented in v0.1.0. See ROADMAP.md.\n`);
    return 64;
  }

  io.stderr(`relay: unknown command '${cmd}'. Run 'relay --help'.\n`);
  return 2;
}

void env; // shut up unused-import warning if env trims later

main().then(
  code => exit(code),
  err => {
    io.stderr(`FATAL: ${(err as Error).message}\n`);
    if ((err as Error).stack) io.stderr(`${(err as Error).stack}\n`);
    exit(2);
  }
);
