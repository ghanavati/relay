#!/usr/bin/env node
/**
 * Relay solo CLI — entry point.
 *
 * v0.1.1 surface: memory + run + parallel + history + diff + compare + doctor +
 * init + completion. See `relay --help` for the full menu, or the README for
 * commands and flags.
 */

import { argv, exit, cwd } from 'node:process';
import type { CliIO } from './cli/commands.js';
import { c, setColorMode, type ColorMode } from './cli/colors.js';
// T50: env-driven cwd default for `relay memory recall` / `show-context`.
import { resolveMemoryWorkdir } from './cli/resolve-memory-workdir.js';

const VERSION = '0.1.2';

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
  io.stdout(`${c.bold(`relay v${VERSION} — solo CLI for AI delegation + memory`)}

${c.bold('USAGE')}
  relay <command> [args] [--flags]

${c.cyan('MEMORY COMMANDS')}
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
    [--min-trust unverified|provisional|trusted]   (default: unverified — no filter)
    [--json]

  relay memory search <regex>              Regex content search (exact match,
                                           companion to FTS-scored recall)
    [--workdir <path>]                     restrict to a workdir
    [--limit <N>]                          (default: 50, max: 1000)
    [--json]

  relay memory show-context <query>        Preview the recalled_lessons context layer
    [--type <t>] (repeatable, default: lesson + decision)
    [--token-budget <N>]                   (default: 800)
    [--workdir <path>]
    [--json]

  relay memory get <memory_id> [--json]    Inspect one memory entry

  relay memory why <memory_id> [--json]    Explain a memory's score breakdown
                                           (per-component contributions + last 5 surfacings)

  relay memory hook --install              Install a CC SessionStart hook
    [--global]                             Install into ~/.claude/settings.json
                                           (default: project-local .claude/settings.json)
  relay memory hook --uninstall            Remove the CC SessionStart hook
    [--global]                             Remove from ~/.claude/settings.json

  relay memory to-rules <memory_id>        Promote a memory to .claude/CLAUDE.md
    [--rules-file <path>]

  relay memory auto-extract --enable       Opt IN to auto-extraction (writes
    [--allow-remote]                          .relay/auto-extract.json in workdir)
    [--workdir <path>] [--json]
  relay memory auto-extract --from-stdin   CC SessionEnd hook entry point
    [--max-bytes <N>]                      (default: 32768)
    [--json]

  relay memory recent                      List the most recently created memories
    [--limit <N>]                          (default: 10)
    [--workdir <path>]                     filter to a single project
    [--json]                               structured array

  relay memory tail                        Tail the relay activity log
    [--filter <event>] (repeatable, substring match)
    [--since <duration>]                   e.g. 30m, 2h, 7d
    [--json]

  relay memory wipe --workdir <path>       GDPR-style per-project memory wipe
    [--hard]                                  hard-delete (default: soft)
    [--tag <name>]                            narrow to memories carrying tag
    --confirm "WIPE <path>"                   required confirmation phrase
    [--json]                                  ("WIPE HARD <path>" with --hard)

  relay memory forget <memory_id>          Forget a single memory entry
    [--hard]                               Hard-delete row (default: soft, superseded_by='forget')
    [--json]

  relay memory rollback <run-id>           Remove auto-extracted memories from a run
  relay memory rollback --since <iso>      Remove auto-extracts created since timestamp
    [--dry-run]                            Preview without deleting
    [--hard]                               Permanent delete (default: soft-delete)
    [--json]

  relay memory consolidate                 Dedup + supersede stale entries
    [--dry-run]                            (analyze without mutating)
    [--similarity-threshold <0..1>]        (default: 0.85)
    [--workdir <path>]
    [--json]

  relay memory chain <memory_id>           Walk the superseded_by provenance chain
    [--depth <N>]                          (default: 5; both directions)
    [--json]                               structured tree

  relay memory diff <id1> <id2>            Unified line-diff of two memories' content
    [--json]                               (red/green hunks; structured payload with --json)

  relay memory tag-stats                   Per-tag analytics (count, recalls, last used)
    [--workdir <path>]                     restrict to a workdir
    [--limit <N>]                          (default: 20; <=0 ⇒ no cap)
    [--json]

${c.cyan('CONTEXT COMMANDS')}
  relay context emit --target <t>          Emit recalled memories in a per-LLM
                                           wrapper format (replaces hook jq pipeline)
    --target cc|codex|lmstudio-http|lmstudio-cli   (required)
    [--workdir <path>]                     (default: PWD)
    [--token-budget <N>]                   (default: 800)
    [--types <list>]                       (default: lesson,fact,decision,context)
    [--min-trust any|unverified|provisional|trusted]  (default: provisional —
                                           T1: blocks unverified auto-extracted
                                           memories from leaking into LLM context.
                                           Use 'any' to disable filter.)

${c.cyan('DELEGATION COMMANDS')}
  relay run <task>                         Delegate a task to a worker
    [--provider codex|lmstudio|openrouter|anthropic] (default: codex)
    [--model <id>] (required for HTTP providers)
    [--workdir <path>]
    [--timeout-ms <N>]                     (default: 300000)
    [--json]

  relay parallel <spec.json>               Dispatch N tasks concurrently
    [--max-concurrency <N>]                (default: 4)
    [--json]

${c.cyan('SESSION COMMANDS')} (universal control layer)
  relay session list                       List registered control sessions
    [--provider claude-code|codex|lmstudio|openrouter|anthropic|fake]
    [--state active|idle|ended]
    [--json]

  relay session inspect <session_id>       Session record + queued count + recent events
    [--json]

  relay session tail <session_id>          Tail a session's audit events
    [--after <event_id>]                   cursor: only events with id > N
    [--limit <N>]                          (default: 100, max: 1000)
    [--json]

  relay session send <session_id> <text>   Send a brokered message to a session
    [--from <source_id>]                   (default: human:cli)
    [--expires-in <duration>]              e.g. 30s, 10m, 2h
    [--no-deliver]                         queue only; skip adapter delivery
    [--json]

  relay session grant <source> <target>    Allow LLM source -> target sends (D-04)
    [--ttl <duration>]                     (default: 15m)
    [--max-messages <N>]                   (default: 10)
    [--json]

  relay session revoke <grant_id>          Revoke a grant
    [--json]

  relay doctor [--json]                    Probe provider + DB health
  relay doctor --figma                     Phase 7: Probe FIGMA_API_TOKEN + Figma REST + deferred-tools (v0.3)
  relay verify [--json]                    End-to-end smoke (memory + context + hook + db)
  relay history [--limit N] [--provider P] [--status S] [--json]
  relay diff <run_id> [--json]             Show files_changed + diffs for a run
  relay compare <run_a> <run_b> [--json]   Side-by-side diff of two runs

${c.cyan('PROJECT')} (per-project privacy controls)
  relay project disable [--yes] [--json]   Write .relayignore, opt out of extract/recall/hook/share
  relay project enable [--yes] [--json]    Remove .relayignore (re-enable defaults)
  relay project audit [--json]             Read-only scan of committed hooks + workdir memories

${c.cyan('SETUP')}
  relay init [--auto|--quick] [--json]     Interactive setup wizard
    [--no-global-hook]                     Install SessionStart hook to project .claude/ (default ~/.claude)
    [--session-end-hook]                   Also install SessionEnd auto-extract hook
    [--lm-model <id>]                      Record LM Studio model id into config.auto_extract.model
    [--enable-auto-extract]                Write per-workdir auto-extract consent file
  relay setup --everything [--workdir P] [--lm-model M] [--yes] [--json]
                                           One-command installer (init + hooks + auto-extract)
    [--interactive]                        Re-enable init's Y/n prompts (default: non-interactive)
    [--clean]                              Strip stale Relay-managed hooks (global + project) before re-installing
  relay setup --clean [--json]             Idempotent: remove Relay-managed CC hooks from ~/.claude AND project .claude (no install)
  relay update [--check|--apply] [--json]  Self-update Relay (default: --check)
    [--force]                              Bypass signed-tag-ahead requirement
  relay setup-llm <target> [--write] [--json]
                                           Per-LLM init helper
                                           targets: codex | lmstudio | openrouter | anthropic
  relay info [--json]                      Overall status summary (binary, DB, hooks, providers)
  relay tui [--json]                       Interactive Ink dashboard
                                           (--json prints one snapshot then exits)
  relay completion <bash|zsh|fish>         Emit shell completion script

${c.cyan('EXPORT')}
  relay export [--safe]                    Export memories (sanitized by default)
    [--workdir <path>]                     (default: current cwd)
    [--format json|md]                     (default: json)
    [--out <file>]                         (default: stdout)
    [--json]                               (machine summary when --out is set)

${c.cyan('PRIVACY')}
  relay pause [--minutes N] [--workdir P] [--json]
                                           Off-switch — sentinel blocks hooks
  relay pause --check [--workdir P]        Silent exit 0 if paused, 1 if not
  relay resume [--workdir P] [--json]      Remove the pause sentinel

${c.cyan('GENERAL')}
  relay --help, -h                         Show this help
  relay --version, -V                      Show version
  --color=auto|always|never                Force color (overrides NO_COLOR)

${c.cyan('DEFERRED TO v0.2')}
  relay budget show [--json]               Stub — reports deferred status (target: 0.2.0)
  relay corpus — see CHANGELOG.md.

${c.cyan('DOCS')}
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
  const provider = (lastOption(flags, 'provider') ?? 'codex') as 'codex' | 'openrouter' | 'lmstudio' | 'anthropic' | 'lmstudio-agentic';
  if (!['codex', 'openrouter', 'lmstudio', 'anthropic', 'lmstudio-agentic'].includes(provider)) {
    io.stderr(`unsupported --provider: ${provider}. Try codex / openrouter / lmstudio / anthropic / lmstudio-agentic.\n`);
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
    io.stderr('relay memory requires an action: remember | recall | search | show-context | get | hook | to-rules\n');
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
    const minTrustRaw = lastOption(flags, 'min-trust');
    let minTrust: 'unverified' | 'provisional' | 'trusted' | undefined;
    if (minTrustRaw !== undefined) {
      const valid = ['unverified', 'provisional', 'trusted'];
      if (!valid.includes(minTrustRaw)) {
        io.stderr(`--min-trust must be one of: ${valid.join(', ')}\n`);
        return 2;
      }
      minTrust = minTrustRaw as 'unverified' | 'provisional' | 'trusted';
    }
    const { executeRecallCommand } = await import('./cli/cmd-memory-ops.js');
    return executeRecallCommand({
      query,
      tags: allOptions(flags, 'tag'),
      types: allOptions(flags, 'type').length > 0 ? allOptions(flags, 'type') : undefined,
      tokenBudget: tokenBudgetRaw ? Number.parseInt(tokenBudgetRaw, 10) : 4000,
      // T50: when RELAY_MEMORY_ALLOWED_WORKDIRS is set and --workdir is
      // omitted, default to io.cwd; otherwise behavior is unchanged.
      workdir: resolveMemoryWorkdir(lastOption(flags, 'workdir'), io.cwd),
      includeExpired: isBool(flags, 'include-expired'),
      createdAfter: createdAfter ? Number.parseInt(createdAfter, 10) : undefined,
      createdBefore: createdBefore ? Number.parseInt(createdBefore, 10) : undefined,
      file: lastOption(flags, 'file'),
      minTrust,
      json: isBool(flags, 'json'),
    }, io);
  }

  if (action === 'show-context') {
    const query = flags.positionals.slice(1).join(' ').trim();
    if (!query) { io.stderr('relay memory show-context requires <query>\n'); return 2; }
    const validTypes = ['lesson', 'decision', 'fact', 'context', 'state', 'handoff', 'session'] as const;
    type T = typeof validTypes[number];
    const rawTypes = allOptions(flags, 'type');
    const types: T[] = rawTypes.length > 0
      ? rawTypes.map(t => {
          if (!(validTypes as readonly string[]).includes(t)) {
            throw new Error(`--type must be one of: ${validTypes.join(', ')}`);
          }
          return t as T;
        })
      : ['lesson', 'decision'];
    const tokenBudgetRaw = lastOption(flags, 'token-budget');
    const tokenBudget = tokenBudgetRaw ? Number.parseInt(tokenBudgetRaw, 10) : 800;
    const { executeMemoryShowContextCommand } = await import('./cli/cmd-memory-ops.js');
    return executeMemoryShowContextCommand({
      query,
      types,
      tokenBudget,
      // T50: same env-driven cwd default as `recall` so the show-context
      // preview lands in the same scope as the actual recall.
      workdir: resolveMemoryWorkdir(lastOption(flags, 'workdir'), io.cwd),
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
    const global = isBool(flags, 'global');
    const sessionEnd = isBool(flags, 'session-end');
    const { executeMemoryHookCommand } = await import('./cli/cmd-memory-ops.js');
    return executeMemoryHookCommand({ install, global, sessionEnd, json: isBool(flags, 'json') }, io, io.cwd);
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

  if (action === 'auto-extract') {
    if (isBool(flags, 'enable')) {
      const { executeMemoryAutoExtractEnableCommand } = await import('./cli/cmd-memory-auto-extract-enable.js');
      return executeMemoryAutoExtractEnableCommand({
        allowRemote: isBool(flags, 'allow-remote'),
        workdir: lastOption(flags, 'workdir') ?? io.cwd,
        json: isBool(flags, 'json'),
      }, io);
    }
    if (isBool(flags, 'from-stdin')) {
      const maxBytesRaw = lastOption(flags, 'max-bytes');
      const { executeMemoryAutoExtractCommand } = await import('./cli/cmd-memory-auto-extract.js');
      return executeMemoryAutoExtractCommand({
        fromStdin: true,
        maxBytes: maxBytesRaw ? Number.parseInt(maxBytesRaw, 10) : undefined,
        json: isBool(flags, 'json'),
      }, io);
    }
    io.stderr('relay memory auto-extract requires --enable [--allow-remote] OR --from-stdin\n');
    return 2;
  }

  if (action === 'wipe') {
    const workdir = lastOption(flags, 'workdir');
    if (!workdir) {
      io.stderr('relay memory wipe requires --workdir <path>\n');
      return 2;
    }
    const { executeWipeCommand } = await import('./cli/cmd-memory-ops.js');
    return executeWipeCommand({
      workdir,
      hard: isBool(flags, 'hard'),
      tag: lastOption(flags, 'tag'),
      confirm: lastOption(flags, 'confirm'),
      json: isBool(flags, 'json'),
    }, io);
  }

  if (action === 'rollback') {
    const runId = flags.positionals[1];
    const since = lastOption(flags, 'since');
    const { executeMemoryRollbackCommand } = await import('./cli/cmd-memory-rollback.js');
    return executeMemoryRollbackCommand({
      runId,
      since,
      hard: isBool(flags, 'hard'),
      dryRun: isBool(flags, 'dry-run'),
      json: isBool(flags, 'json'),
    }, io);
  }

  if (action === 'tail') {
    const { executeMemoryTailCommand } = await import('./cli/cmd-memory-tail.js');
    return executeMemoryTailCommand({
      filters: allOptions(flags, 'filter'),
      since: lastOption(flags, 'since'),
      json: isBool(flags, 'json'),
    }, io);
  }

  if (action === 'recent') {
    const limitRaw = lastOption(flags, 'limit');
    const limit = limitRaw !== undefined ? Number.parseInt(limitRaw, 10) : 10;
    if (limitRaw !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
      io.stderr(`--limit must be a positive integer (got: ${limitRaw})\n`);
      return 2;
    }
    const { executeMemoryRecentCommand } = await import('./cli/cmd-memory-recent.js');
    return executeMemoryRecentCommand({
      limit,
      workdir: lastOption(flags, 'workdir'),
      json: isBool(flags, 'json'),
    }, io);
  }

  if (action === 'why') {
    const memoryId = flags.positionals[1];
    if (!memoryId) {
      io.stderr('relay memory why requires <memory_id>\n');
      return 2;
    }
    const { executeMemoryWhyCommand } = await import('./cli/cmd-memory-why.js');
    return executeMemoryWhyCommand({ memoryId, json: isBool(flags, 'json') }, io);
  }

  if (action === 'forget') {
    const memoryId = flags.positionals[1];
    if (!memoryId) {
      io.stderr('relay memory forget requires <memory_id>\n');
      return 2;
    }
    const { executeForgetCommand } = await import('./cli/cmd-memory-ops.js');
    return executeForgetCommand({
      memoryId,
      hard: isBool(flags, 'hard'),
      json: isBool(flags, 'json'),
    }, io);
  }

  if (action === 'consolidate') {
    const thresholdRaw = lastOption(flags, 'similarity-threshold');
    const threshold = thresholdRaw !== undefined ? Number.parseFloat(thresholdRaw) : 0.85;
    const { executeMemoryConsolidateCommand } = await import('./cli/cmd-memory-consolidate.js');
    return executeMemoryConsolidateCommand({
      dryRun: isBool(flags, 'dry-run'),
      json: isBool(flags, 'json'),
      similarityThreshold: threshold,
      workdir: lastOption(flags, 'workdir'),
    }, io);
  }

  if (action === 'diff') {
    const idA = flags.positionals[1];
    const idB = flags.positionals[2];
    if (!idA || !idB) {
      io.stderr('relay memory diff requires <id1> <id2>\n');
      return 2;
    }
    const { executeMemoryDiffCommand } = await import('./cli/cmd-memory-diff.js');
    return executeMemoryDiffCommand({ idA, idB, json: isBool(flags, 'json') }, io);
  }

  if (action === 'chain') {
    const memoryId = flags.positionals[1];
    if (!memoryId) {
      io.stderr('relay memory chain requires <memory_id>\n');
      return 2;
    }
    const depthRaw = lastOption(flags, 'depth');
    const depth = depthRaw !== undefined ? Number.parseInt(depthRaw, 10) : 5;
    if (!Number.isFinite(depth) || depth < 0) {
      io.stderr('relay memory chain --depth must be a non-negative integer\n');
      return 2;
    }
    const { executeMemoryChainCommand } = await import('./cli/cmd-memory-chain.js');
    return executeMemoryChainCommand({
      memoryId,
      depth,
      json: isBool(flags, 'json'),
    }, io);
  }

  if (action === 'tag-stats') {
    const limitRaw = lastOption(flags, 'limit');
    const { DEFAULT_TAG_STATS_LIMIT, executeMemoryTagStatsCommand } = await import('./cli/cmd-memory-tag-stats.js');
    const limit = limitRaw !== undefined ? Number.parseInt(limitRaw, 10) : DEFAULT_TAG_STATS_LIMIT;
    return executeMemoryTagStatsCommand({
      workdir: lastOption(flags, 'workdir'),
      limit,
      json: isBool(flags, 'json'),
    }, io);
  }

  if (action === 'search') {
    const pattern = flags.positionals.slice(1).join(' ').trim();
    const limitRaw = lastOption(flags, 'limit');
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 50;
    const { executeMemorySearchCommand } = await import('./cli/cmd-memory-search.js');
    return executeMemorySearchCommand({
      pattern,
      workdir: lastOption(flags, 'workdir'),
      limit,
      json: isBool(flags, 'json'),
    }, io);
  }

  io.stderr(`relay memory: unknown action '${action}'. Try: remember, recall, search, show-context, get, hook, to-rules, auto-extract, wipe, tail, recent, why, forget, rollback, consolidate, diff, chain, tag-stats\n`);
  return 2;
}

async function dispatchContext(rest: readonly string[]): Promise<number> {
  const flags = parseFlags(rest);
  const action = flags.positionals[0];

  if (!action) {
    io.stderr('relay context requires an action: emit\n');
    return 2;
  }

  if (action === 'emit') {
    const target = lastOption(flags, 'target');
    if (!target) {
      io.stderr('relay context emit requires --target <cc|codex|lmstudio-http|lmstudio-cli>\n');
      return 2;
    }
    const { executeContextEmitCommand, parseEmitTypes, parseEmitMinTrust, VALID_EMIT_TARGETS } =
      await import('./cli/cmd-context-emit.js');
    if (!(VALID_EMIT_TARGETS as readonly string[]).includes(target)) {
      io.stderr(
        `--target must be one of: ${VALID_EMIT_TARGETS.join(', ')} (got: ${target})\n`
      );
      return 2;
    }
    const tokenBudgetRaw = lastOption(flags, 'token-budget');
    const tokenBudget = tokenBudgetRaw ? Number.parseInt(tokenBudgetRaw, 10) : 800;
    const typesRaw = lastOption(flags, 'types');
    const splitTypes = typesRaw
      ? typesRaw.split(',').map(s => s.trim()).filter(Boolean)
      : [];
    let types;
    try {
      types = parseEmitTypes(splitTypes);
    } catch (e) {
      io.stderr(`${(e as Error).message}\n`);
      return 2;
    }
    // T1 — parse `--min-trust` (default: provisional via parseEmitMinTrust).
    let minTrust: 'unverified' | 'provisional' | 'trusted';
    try {
      minTrust = parseEmitMinTrust(lastOption(flags, 'min-trust'));
    } catch (e) {
      io.stderr(`${(e as Error).message}\n`);
      return 2;
    }
    return executeContextEmitCommand(
      {
        target: target as 'cc' | 'codex' | 'lmstudio-http' | 'lmstudio-cli',
        workdir: lastOption(flags, 'workdir') ?? io.cwd,
        tokenBudget,
        types,
        minTrust,
      },
      io
    );
  }

  io.stderr(`relay context: unknown action '${action}'. Try: emit\n`);
  return 2;
}

async function dispatchVerify(rest: readonly string[]): Promise<number> {
  const flags = parseFlags(rest);
  const { executeVerifyCommand } = await import('./cli/cmd-verify.js');
  return executeVerifyCommand({ json: isBool(flags, 'json') }, io);
}

async function dispatchSession(rest: readonly string[]): Promise<number> {
  const flags = parseFlags(rest);
  const action = flags.positionals[0] ?? '';
  const { executeSessionCommand } = await import('./cli/cmd-session.js');
  return executeSessionCommand({
    action,
    positionals: flags.positionals.slice(1),
    provider: lastOption(flags, 'provider'),
    state: lastOption(flags, 'state'),
    after: lastOption(flags, 'after'),
    limit: lastOption(flags, 'limit'),
    from: lastOption(flags, 'from'),
    ttl: lastOption(flags, 'ttl'),
    maxMessages: lastOption(flags, 'max-messages'),
    expiresIn: lastOption(flags, 'expires-in'),
    noDeliver: isBool(flags, 'no-deliver'),
    json: isBool(flags, 'json'),
  }, io);
}

// `dispatchBudget` removed in v0.2 (budget feature stripped — local-first pivot).

const VALID_COLOR_MODES = new Set<ColorMode>(['auto', 'always', 'never']);

function isColorMode(v: string): v is ColorMode {
  return VALID_COLOR_MODES.has(v as ColorMode);
}

function applyColorFlag(args: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--color' && args[i + 1]) {
      const v = args[++i]!;
      if (!isColorMode(v)) {
        io.stderr(`--color must be one of auto|always|never (got: ${v})\n`);
        exit(2);
      }
      setColorMode(v);
      continue;
    }
    if (a.startsWith('--color=')) {
      const v = a.slice('--color='.length);
      if (!isColorMode(v)) {
        io.stderr(`--color must be one of auto|always|never (got: ${v})\n`);
        exit(2);
      }
      setColorMode(v);
      continue;
    }
    out.push(a);
  }
  return out;
}

async function main(): Promise<number> {
  const args = applyColorFlag(argv.slice(2));
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

  if (cmd === 'context') {
    return dispatchContext(rest);
  }

  if (cmd === 'run') return dispatchRun(rest);
  if (cmd === 'session') return dispatchSession(rest);
  if (cmd === 'verify') return dispatchVerify(rest);
  if (cmd === 'doctor') {
    const flags = parseFlags(rest);
    // Phase 7 — --figma flag runs the dedicated probe instead of the full doctor.
    if (isBool(flags, 'figma')) {
      const { probeFigma, formatFigmaProbeOutput } = await import('./cli/cmd-doctor-figma.js');
      const { homedir } = await import('node:os');
      const result = await probeFigma({ env: process.env, homeDir: homedir() });
      io.stdout(formatFigmaProbeOutput(result));
      return result.restStatus === 'failed' ? 1 : 0;
    }
    const { executeDoctorCommand } = await import('./cli/cmd-doctor.js');
    return executeDoctorCommand({ json: isBool(flags, 'json') }, io);
  }
  if (cmd === 'history') {
    const flags = parseFlags(rest);
    const limitRaw = lastOption(flags, 'limit');
    const { executeHistoryCommand } = await import('./cli/cmd-history.js');
    return executeHistoryCommand({
      limit: limitRaw ? Number.parseInt(limitRaw, 10) : 10,
      provider: lastOption(flags, 'provider'),
      status: lastOption(flags, 'status'),
      json: isBool(flags, 'json'),
    }, io);
  }
  if (cmd === 'diff') {
    const flags = parseFlags(rest);
    const runId = flags.positionals[0];
    if (!runId) { io.stderr('relay diff requires <run_id>\n'); return 2; }
    const { executeDiffCommand } = await import('./cli/cmd-diff.js');
    return executeDiffCommand({ runId, json: isBool(flags, 'json') }, io);
  }
  if (cmd === 'init') {
    const flags = parseFlags(rest);
    const { executeInitCommand } = await import('./cli/cmd-init.js');
    // --no-global-hook overrides --global-hook (both default to global=true).
    // Absence of either flag in interactive mode keeps the new default (global).
    const globalHook = isBool(flags, 'no-global-hook') ? false : true;
    return executeInitCommand({
      auto: isBool(flags, 'auto'),
      quick: isBool(flags, 'quick'),
      json: isBool(flags, 'json'),
      globalHook,
      sessionEndHook: isBool(flags, 'session-end-hook'),
      lmModel: lastOption(flags, 'lm-model'),
      noShellEdit: isBool(flags, 'no-shell-edit'),
      enableAutoExtract: isBool(flags, 'enable-auto-extract'),
    }, io);
  }
  if (cmd === 'update') {
    const flags = parseFlags(rest);
    const { executeUpdateCommand } = await import('./cli/cmd-update.js');
    const apply = isBool(flags, 'apply');
    const check = isBool(flags, 'check') || !apply;
    return executeUpdateCommand({
      check,
      apply,
      json: isBool(flags, 'json'),
      force: isBool(flags, 'force'),
    }, io);
  }
  if (cmd === 'setup-llm') {
    const flags = parseFlags(rest);
    const target = flags.positionals[0];
    const validTargets = ['codex', 'lmstudio', 'openrouter', 'anthropic'] as const;
    type Target = typeof validTargets[number];
    if (!target || !(validTargets as readonly string[]).includes(target)) {
      io.stderr(`relay setup-llm requires <target>. Try: ${validTargets.join(' / ')}\n`);
      return 2;
    }
    const { executeSetupLlmCommand } = await import('./cli/cmd-setup-llm.js');
    return executeSetupLlmCommand({
      target: target as Target,
      write: isBool(flags, 'write'),
      json: isBool(flags, 'json'),
    }, io);
  }
  if (cmd === 'setup') {
    const flags = parseFlags(rest);
    const { executeSetupCommand } = await import('./cli/cmd-setup.js');
    return executeSetupCommand({
      everything: isBool(flags, 'everything'),
      workdir: lastOption(flags, 'workdir'),
      lmModel: lastOption(flags, 'lm-model'),
      yes: isBool(flags, 'yes'),
      json: isBool(flags, 'json'),
      interactive: isBool(flags, 'interactive'),
      clean: isBool(flags, 'clean'),
    }, io);
  }
  if (cmd === 'info') {
    const flags = parseFlags(rest);
    const { executeInfoCommand } = await import('./cli/cmd-info.js');
    return executeInfoCommand({ json: isBool(flags, 'json') }, io, VERSION);
  }
  if (cmd === 'tui') {
    const flags = parseFlags(rest);
    const { executeTuiCommand } = await import('./cli/cmd-tui.js');
    return executeTuiCommand({ json: isBool(flags, 'json'), cwd: io.cwd, version: VERSION }, io);
  }
  if (cmd === 'compare') {
    const flags = parseFlags(rest);
    const [runA, runB] = flags.positionals;
    if (!runA || !runB) { io.stderr('relay compare requires <run_a> <run_b>\n'); return 2; }
    const { executeCompareCommand } = await import('./cli/cmd-compare.js');
    return executeCompareCommand({ runA, runB, json: isBool(flags, 'json') }, io);
  }
  if (cmd === 'parallel') {
    const flags = parseFlags(rest);
    const specPath = flags.positionals[0];
    if (!specPath) { io.stderr('relay parallel requires <spec.json>\n'); return 2; }
    const maxConcurrencyRaw = lastOption(flags, 'max-concurrency');
    const { executeParallelCommand } = await import('./cli/cmd-parallel.js');
    return executeParallelCommand({
      specPath,
      maxConcurrency: maxConcurrencyRaw ? Number.parseInt(maxConcurrencyRaw, 10) : 4,
      json: isBool(flags, 'json'),
    }, io);
  }
  if (cmd === 'project') {
    const flags = parseFlags(rest);
    const action = flags.positionals[0];
    if (!action || !['disable', 'enable', 'audit'].includes(action)) {
      io.stderr('relay project requires an action: disable | enable | audit\n');
      return 2;
    }
    const { executeProjectCommand } = await import('./cli/cmd-project.js');
    return executeProjectCommand({
      action: action as 'disable' | 'enable' | 'audit',
      yes: isBool(flags, 'yes'),
      json: isBool(flags, 'json'),
    }, io);
  }
  if (cmd === 'completion') {
    const flags = parseFlags(rest);
    const shell = flags.positionals[0];
    if (!shell || !['bash', 'zsh', 'fish'].includes(shell)) {
      io.stderr('relay completion requires <bash|zsh|fish>\n');
      return 2;
    }
    const { executeCompletionCommand } = await import('./cli/cmd-completion.js');
    return executeCompletionCommand({ shell: shell as 'bash' | 'zsh' | 'fish' }, io);
  }
  if (cmd === 'export') {
    const flags = parseFlags(rest);
    if (isBool(flags, 'unsafe')) {
      io.stderr('relay export: --unsafe is not supported in this version. Drop the flag (--safe is the default).\n');
      return 2;
    }
    const formatRaw = lastOption(flags, 'format') ?? 'json';
    if (formatRaw !== 'json' && formatRaw !== 'md' && formatRaw !== 'html') {
      io.stderr(`relay export: --format must be json, md, or html (got: ${formatRaw})\n`);
      return 2;
    }
    const { executeExportCommand } = await import('./cli/cmd-export.js');
    return executeExportCommand({
      safe: true,
      workdir: lastOption(flags, 'workdir'),
      format: formatRaw,
      out: lastOption(flags, 'out'),
      json: isBool(flags, 'json'),
    }, io);
  }
  if (cmd === 'pause') {
    const flags = parseFlags(rest);
    const minutesRaw = lastOption(flags, 'minutes');
    const minutes = minutesRaw ? Number.parseFloat(minutesRaw) : undefined;
    if (minutesRaw !== undefined && (minutes === undefined || Number.isNaN(minutes) || minutes <= 0)) {
      io.stderr(`--minutes must be a positive number (got: ${minutesRaw})\n`);
      return 2;
    }
    const workdir = lastOption(flags, 'workdir');
    if (isBool(flags, 'check')) {
      const { executePauseCheckCommand } = await import('./cli/cmd-pause.js');
      return executePauseCheckCommand({ workdir });
    }
    const { executePauseCommand } = await import('./cli/cmd-pause.js');
    return executePauseCommand({ minutes, workdir, json: isBool(flags, 'json') }, io);
  }
  if (cmd === 'resume') {
    const flags = parseFlags(rest);
    const { executeResumeCommand } = await import('./cli/cmd-pause.js');
    return executeResumeCommand({ workdir: lastOption(flags, 'workdir'), json: isBool(flags, 'json') }, io);
  }

  // Note: `budget` is wired above (see dispatchBudget) and returns a
  // structured deferred-status payload. `corpus` remains a future command
  // until QMD integration lands in v0.2.
  const futureCmds = ['corpus'];
  if (cmd && futureCmds.includes(cmd)) {
    io.stderr(`relay ${cmd}: deferred to v0.2. See CHANGELOG.md.\n`);
    return 64;
  }

  io.stderr(`relay: unknown command '${cmd}'. Run 'relay --help'.\n`);
  return 2;
}

main().then(
  code => exit(code),
  err => {
    io.stderr(`FATAL: ${(err as Error).message}\n`);
    if ((err as Error).stack) io.stderr(`${(err as Error).stack}\n`);
    exit(2);
  }
);
