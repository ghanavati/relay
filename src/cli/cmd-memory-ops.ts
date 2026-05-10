import type { CliIO } from './commands.js';
import { handleGetMemory } from '../tools/get_memory.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export async function executeRememberCommand(
  command: {
    content: string;
    memoryType: 'fact' | 'decision' | 'lesson' | 'context' | 'state' | 'handoff';
    tags: string[];
    pinned: boolean;
    workdir: string | undefined;
    expiresInHours: number | undefined;
    json: boolean;
  },
  io: CliIO
): Promise<number> {
  const { handleRemember } = await import('../tools/remember.js');
  const response = handleRemember({
    content: command.content,
    memory_type: command.memoryType,
    tags: command.tags,
    pinned: command.pinned,
    workdir: command.workdir,
    expires_in_hours: command.expiresInHours,
  }, 'human') as { content: Array<{ type: string; text: string }>; isError?: boolean };
  const text = response.content[0]?.text ?? '{}';
  if (command.json) {
    io.stdout(`${text}\n`);
    return response.isError ? 1 : 0;
  }
  if (response.isError) { io.stderr(`remember failed: ${text}\n`); return 1; }
  io.stdout(`Memory stored.\n${text}\n`);
  return 0;
}

export async function executeRecallCommand(
  command: {
    query: string | undefined;
    tags: string[];
    types: string[] | undefined;
    tokenBudget: number;
    workdir: string | undefined;
    includeExpired: boolean;
    createdAfter: number | undefined;
    createdBefore: number | undefined;
    file: string | undefined;
    minTrust: 'unverified' | 'provisional' | 'trusted' | undefined;
    json: boolean;
  },
  io: CliIO
): Promise<number> {
  const { handleRecall } = await import('../tools/recall.js');
  const response = handleRecall({
    query: command.query,
    tags: command.tags,
    types: command.types as never,
    token_budget: command.tokenBudget,
    workdir: command.workdir,
    include_expired: command.includeExpired,
    created_after: command.createdAfter,
    created_before: command.createdBefore,
    file: command.file,
    min_trust: command.minTrust,
  }) as { content: Array<{ type: string; text: string }>; isError?: boolean };
  const text = response.content[0]?.text ?? '';
  if (command.json) {
    io.stdout(`${text}\n`);
    return response.isError ? 1 : 0;
  }
  if (response.isError) { io.stderr(`recall failed: ${text}\n`); return 1; }
  io.stdout(`${text}\n`);
  return 0;
}

export function executeGetMemoryCommand(
  command: { memoryId: string; json: boolean },
  io: CliIO
): number {
  const response = handleGetMemory({ memory_id: command.memoryId }) as { content: Array<{ type: string; text: string }>; isError?: boolean };
  const text = response.content[0]?.text ?? '{}';
  if (command.json) {
    io.stdout(`${text}\n`);
    return response.isError ? 1 : 0;
  }
  if (response.isError) { io.stderr(`get-memory failed: ${text}\n`); return 1; }
  io.stdout(`${text}\n`);
  return 0;
}

export async function executeMemoryShowContextCommand(
  command: {
    query: string;
    types: ('lesson' | 'decision' | 'fact' | 'context' | 'state' | 'handoff' | 'session')[];
    tokenBudget: number;
    workdir?: string;
    json: boolean;
  },
  io: CliIO
): Promise<number> {
  const { loadRecalledLessonsContent } = await import('../context/layers.js');
  const workdir = command.workdir ?? io.cwd;
  const content = await loadRecalledLessonsContent(workdir, command.query, undefined, {
    types: command.types,
    tokenBudget: command.tokenBudget,
  });
  if (command.json) {
    io.stdout(JSON.stringify({ content, query: command.query, types: command.types, token_budget: command.tokenBudget, workdir }) + '\n');
  } else if (content === null) {
    io.stdout('No relevant lessons found for this query.\n');
  } else {
    io.stdout(content + '\n');
  }
  return 0;
}

// Working SessionStart hook: pulls recall results, then jq-wraps them as
// `{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:"..."}}`
// so CC injects the recalled memories as additional context at session start.
// `--workdir "${CLAUDE_PROJECT_DIR:-$PWD}"` scopes recall to the project CC opened in,
// not wherever Relay's CWD happens to be — required for --global installs to work
// correctly across every project the user opens.
export const HOOK_SCRIPT =
  'relay memory recall --token-budget 800 --type lesson --type fact --type decision --type context --workdir "${CLAUDE_PROJECT_DIR:-$PWD}" --json 2>/dev/null | jq -c \'{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:(if (.memories | length > 0) then "## Recalled memories\\n\\n" + (.memories | map("- " + .content) | join("\\n\\n")) else "" end)}}\' 2>/dev/null || true';
const HOOK_ID = 'relay-memory-session-start';

// SessionEnd hook: pipes CC's SessionEnd payload (JSON on stdin) to the auto-extract
// command, which runs the consent-gated transcript distillation pipeline. Errors are
// appended to the relay log so the hook never blocks CC from terminating cleanly.
export const HOOK_SCRIPT_SESSION_END =
  'relay memory auto-extract --from-stdin 2>>$HOME/.relay/auto-extract.log || true';
const HOOK_ID_SESSION_END = 'relay-memory-session-end';

/** Resolve the settings.json path. `global=true` targets the user-wide
 *  `~/.claude/settings.json` so the hook fires in every project; otherwise
 *  the project-local `<cwd>/.claude/settings.json`. */
export function resolveHookSettingsPath(cwd: string, global: boolean): string {
  return global
    ? join(homedir(), '.claude', 'settings.json')
    : join(cwd, '.claude', 'settings.json');
}

/**
 * Install or remove a CC hook (SessionStart by default; SessionEnd when
 * `sessionEnd: true`). The two hook variants are independent — installing
 * one does not touch the other, so users can opt into either or both.
 */
export async function executeMemoryHookCommand(
  command: { install: boolean; json: boolean; global?: boolean; sessionEnd?: boolean },
  io: CliIO,
  cwd: string
): Promise<number> {
  const settingsPath = resolveHookSettingsPath(cwd, command.global === true);
  const sessionEnd = command.sessionEnd === true;
  const hookEventName = sessionEnd ? 'SessionEnd' : 'SessionStart';
  const hookScript = sessionEnd ? HOOK_SCRIPT_SESSION_END : HOOK_SCRIPT;
  const legacyHookId = sessionEnd ? HOOK_ID_SESSION_END : HOOK_ID;

  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
  } catch {
    // file doesn't exist yet — start fresh
  }

  const hooks = (settings['hooks'] ?? {}) as Record<string, unknown>;
  const existing = (Array.isArray(hooks[hookEventName]) ? hooks[hookEventName] : []) as Array<Record<string, unknown>>;

  // Strip any stale relay hook entries for THIS event: legacy { id, run } shape AND any
  // current-format entry whose inner hooks[] contains our hookScript. Makes install
  // idempotent and self-heals settings.json files written by a prior buggy version.
  const cleaned = existing.filter(h => {
    if (h['id'] === legacyHookId) return false;
    const inner = (Array.isArray(h['hooks']) ? h['hooks'] : []) as Array<Record<string, unknown>>;
    if (inner.some(i => i['command'] === hookScript)) return false;
    return true;
  });

  if (command.install) {
    // CC hook schema: each entry is { hooks: [{ type, command }] }, optionally with matcher.
    cleaned.push({ hooks: [{ type: 'command', command: hookScript }] });
    hooks[hookEventName] = cleaned;
    settings['hooks'] = hooks;
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    if (command.json) io.stdout(JSON.stringify({ installed: true, path: settingsPath, event: hookEventName }) + '\n');
    else if (sessionEnd) io.stdout(`SessionEnd hook installed in ${settingsPath}\nRelay will run auto-extract on session end (consent gated; see 'relay memory auto-extract --enable').\n`);
    else io.stdout(`SessionStart hook installed in ${settingsPath}\nRelay will inject recalled memories at the start of every new CC session.\n`);
  } else {
    hooks[hookEventName] = cleaned;
    settings['hooks'] = hooks;
    await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    if (command.json) io.stdout(JSON.stringify({ installed: false, path: settingsPath, event: hookEventName }) + '\n');
    else io.stdout(`${hookEventName} hook removed from ${settingsPath}\n`);
  }
  return 0;
}

/**
 * T15 — Per-project memory wipe (GDPR-style).
 *
 * Soft delete by default (preserves audit trail); `--hard` for true erasure.
 * Requires a confirmation phrase to prevent accidental data loss.
 */
export async function executeWipeCommand(
  command: {
    workdir: string;
    hard: boolean;
    tag: string | undefined;
    confirm: string | undefined;
    json: boolean;
  },
  io: CliIO
): Promise<number> {
  if (!command.workdir) {
    if (command.json) io.stdout(JSON.stringify({ error: 'missing_workdir' }) + '\n');
    else io.stderr('relay memory wipe requires --workdir <path>\n');
    return 2;
  }

  const expectedPhrase = command.hard
    ? `WIPE HARD ${command.workdir}`
    : `WIPE ${command.workdir}`;

  if (command.confirm !== expectedPhrase) {
    const msg = `Refusing to wipe without explicit --confirm. Re-run with: --confirm "${expectedPhrase}"`;
    if (command.json) {
      io.stdout(JSON.stringify({ error: 'confirmation_required', expected: expectedPhrase }) + '\n');
    } else {
      io.stderr(`${msg}\n`);
    }
    return 2;
  }

  const { MemoryStore } = await import('../memory/memory-store.js');
  const store = new MemoryStore();
  const result = store.wipeWorkdir(command.workdir, { hard: command.hard, tag: command.tag });

  if (command.json) {
    io.stdout(JSON.stringify({
      workdir: command.workdir,
      hard: command.hard,
      tag: command.tag ?? null,
      soft_deleted: result.soft_deleted,
      hard_deleted: result.hard_deleted,
    }) + '\n');
  } else {
    const mode = command.hard ? 'hard-deleted' : 'soft-deleted';
    const count = command.hard ? result.hard_deleted : result.soft_deleted;
    const tagSuffix = command.tag ? ` (tag: ${command.tag})` : '';
    io.stdout(`Wiped ${count} memories from ${command.workdir}${tagSuffix} — ${mode}.\n`);
  }
  return 0;
}

/** Promote a high-trust memory to a permanent rule in CLAUDE.md (or specified rules file). */
export async function executeMemoryToRulesCommand(
  command: { memoryId: string; rulesFile: string; json: boolean },
  io: CliIO,
  cwd: string
): Promise<number> {
  const { MemoryStore } = await import('../memory/memory-store.js');
  const store = new MemoryStore();
  const memory = store.getMemory(command.memoryId);
  if (!memory) {
    if (command.json) io.stdout(JSON.stringify({ error: 'not_found', memory_id: command.memoryId }) + '\n');
    else io.stderr(`Memory ${command.memoryId} not found\n`);
    return 1;
  }

  const rulesPath = join(cwd, command.rulesFile);
  let existing = '';
  try { existing = await readFile(rulesPath, 'utf8'); } catch { /* new file */ }

  const section = '\n\n## Promoted Memory Rules\n\n';
  const entry = `- [${memory.memory_type}] ${memory.content}\n`;

  const hasSection = existing.includes('## Promoted Memory Rules');
  const alreadyPresent = existing.includes(entry);
  const updated = alreadyPresent
    ? existing
    : hasSection
      ? existing.replace(/(\n## Promoted Memory Rules\n\n)([\s\S]*?)(\n##|$)/, (_m, hdr, body, tail) => `${hdr}${body}${entry}${tail}`)
      : existing + section + entry;

  if (alreadyPresent) {
    if (command.json) io.stdout(JSON.stringify({ promoted: command.memoryId, rules_file: rulesPath, skipped: 'already present' }) + '\n');
    else io.stdout(`Already present in ${rulesPath} — no change.\n`);
    return 0;
  }

  await mkdir(dirname(rulesPath), { recursive: true });
  await writeFile(rulesPath, updated, 'utf8');

  if (command.json) io.stdout(JSON.stringify({ promoted: command.memoryId, rules_file: rulesPath }) + '\n');
  else io.stdout(`Appended to ${rulesPath}:\n  [${memory.memory_type}] ${memory.content.slice(0, 80)}${memory.content.length > 80 ? '…' : ''}\n`);
  return 0;
}
