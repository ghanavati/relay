import type { CliIO } from './commands.js';
import { handleGetMemory } from '../tools/get_memory.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

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

export const HOOK_SCRIPT = 'relay memory recall --token-budget 800 --type lesson --type fact --type decision --json 2>/dev/null || true';
const HOOK_ID = 'relay-memory-session-start';

/** Install or remove a SessionStart hook that injects recalled memories into every new CC session. */
export async function executeMemoryHookCommand(
  command: { install: boolean; json: boolean },
  io: CliIO,
  cwd: string
): Promise<number> {
  const settingsPath = join(cwd, '.claude', 'settings.json');
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
  } catch {
    // file doesn't exist yet — start fresh
  }

  const hooks = (settings['hooks'] ?? {}) as Record<string, unknown>;
  const sessionStart = (Array.isArray(hooks['SessionStart']) ? hooks['SessionStart'] : []) as Array<Record<string, unknown>>;

  if (command.install) {
    const alreadyPresent = sessionStart.some(h => h['id'] === HOOK_ID);
    if (!alreadyPresent) {
      sessionStart.push({ id: HOOK_ID, run: HOOK_SCRIPT });
    }
    hooks['SessionStart'] = sessionStart;
    settings['hooks'] = hooks;
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    if (command.json) io.stdout(JSON.stringify({ installed: true, path: settingsPath }) + '\n');
    else io.stdout(`SessionStart hook installed in ${settingsPath}\nRelay will inject recalled memories at the start of every new CC session.\n`);
  } else {
    hooks['SessionStart'] = sessionStart.filter(h => h['id'] !== HOOK_ID);
    settings['hooks'] = hooks;
    await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    if (command.json) io.stdout(JSON.stringify({ installed: false, path: settingsPath }) + '\n');
    else io.stdout(`SessionStart hook removed from ${settingsPath}\n`);
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
