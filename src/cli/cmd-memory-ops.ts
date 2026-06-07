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
  const response = (await handleRecall({
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
  })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
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

/**
 * Forget (delete) a single memory by id.
 *
 * Soft mode (default) marks the row `superseded_by='forget'` so it is
 * excluded from recall/get/count but preserved for audit. Hard mode
 * physically removes the row; the FTS5 delete trigger keeps the FTS
 * index in sync.
 *
 * Exit codes: 0 if a row was affected, 1 if id not found (or already
 * forgotten in soft mode), 2 for missing argument.
 */
export async function executeForgetCommand(
  command: { memoryId: string; hard: boolean; json: boolean },
  io: CliIO
): Promise<number> {
  const { MemoryStore } = await import('../memory/memory-store.js');
  const store = new MemoryStore();
  const result = store.forget(command.memoryId, { hard: command.hard });

  if (!result.found) {
    if (command.json) {
      io.stdout(JSON.stringify({ found: false, mode: result.mode, memory_id: command.memoryId }) + '\n');
    } else {
      io.stderr(`Memory ${command.memoryId} not found${result.mode === 'soft' ? ' (or already forgotten)' : ''}\n`);
    }
    return 1;
  }

  if (command.json) {
    io.stdout(JSON.stringify({ found: true, mode: result.mode, memory_id: command.memoryId }) + '\n');
  } else {
    io.stdout(`Forgot memory ${command.memoryId} (${result.mode === 'hard' ? 'hard delete' : 'soft delete'}).\n`);
  }
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
//
// Privacy gate (P1 fix — Codex finding #1): `relay pause --check` exits 0 when
// paused, non-zero otherwise. The `&& exit 0` short-circuits the whole hook when
// the user has run `relay pause`, so no recall happens and no memories are emitted
// to CC's context. When not paused, the `;` separator lets the emit proceed. The
// 2>/dev/null on the check is defense-in-depth: even if pause-check faults, the
// hook still degrades to the normal emit path rather than spam CC's stderr.
export const HOOK_SCRIPT =
  'relay pause --check --workdir "${CLAUDE_PROJECT_DIR:-$PWD}" 2>/dev/null && exit 0; ' +
  'relay context emit --target cc --workdir "${CLAUDE_PROJECT_DIR:-$PWD}" 2>/dev/null || true';
const HOOK_ID = 'relay-memory-session-start';

// SessionEnd hook: pipes CC's SessionEnd payload (JSON on stdin) to the auto-extract
// command, which runs the consent-gated transcript distillation pipeline. The pipeline
// itself logs structured outcomes through the centralized `appendLog` helper to the
// unified `~/.relay/relay.ndjson` stream — the shell-level `2>>` redirect is a defense-
// in-depth fallback that captures any uncaught stderr (e.g. node startup faults that
// fire before the in-process logger initializes). Both targets converge on the same
// ndjson path so `relay memory tail` / `relay doctor` see one stream.
//
// Codex review BLOCKER fix: shell `2>>` opens log path BEFORE relay runs, so
// `~/.relay/` must exist first or the hook silently fails on a fresh install.
//
// Privacy gate (P1 fix — Codex finding #1): identical to SessionStart — when
// `relay pause` is active, short-circuit before auto-extract runs. Otherwise the
// paused user's transcripts still get distilled into memories, defeating the
// privacy off-switch.
export const HOOK_SCRIPT_SESSION_END =
  'relay pause --check --workdir "${CLAUDE_PROJECT_DIR:-$PWD}" 2>/dev/null && exit 0; ' +
  'mkdir -p "$HOME/.relay" && relay memory auto-extract --from-stdin 2>>"$HOME/.relay/relay.ndjson" || true';
const HOOK_ID_SESSION_END = 'relay-memory-session-end';

// UserPromptSubmit hook (Phase 8 / CONTROL-06): delivers queued Relay
// cross-session messages as additionalContext on each prompt. The COMMAND is
// identical to the SessionStart script — `relay context emit --target cc`
// reads the hook payload from stdin and differentiates on
// `hook_event_name` (UserPromptSubmit skips memory re-injection and only
// drains the control mailbox), so one pipeline serves both boundaries.
export const HOOK_SCRIPT_USER_PROMPT = HOOK_SCRIPT;
const HOOK_ID_USER_PROMPT = 'relay-memory-user-prompt';

// Stable marker we attach to every Relay-managed hook entry so install/uninstall
// can identify our own entries without ever matching foreign hooks by command
// substring. CC ignores extra fields on hook entries, so this is schema-safe.
// We bump the version suffix only if the hook script changes in a backward-
// incompatible way that requires a forced replace of legacy entries.
export const HOOK_MARKER_FIELD = '_relay_id';
export const HOOK_MARKER_SESSION_START = 'relay-context-emit-v1';
export const HOOK_MARKER_SESSION_END = 'relay-session-end-v1';
export const HOOK_MARKER_USER_PROMPT = 'relay-user-prompt-v1';

/** Resolve the settings.json path. `global=true` targets the user-wide
 *  `~/.claude/settings.json` so the hook fires in every project; otherwise
 *  the project-local `<cwd>/.claude/settings.json`. */
export function resolveHookSettingsPath(cwd: string, global: boolean): string {
  return global
    ? join(homedir(), '.claude', 'settings.json')
    : join(cwd, '.claude', 'settings.json');
}

/**
 * True iff this hook entry is one Relay manages for the given event.
 *
 * Match precedence:
 * 1. New marker — entry carries `_relay_id` matching the expected marker.
 *    This is the ONLY identifier we trust going forward; it survives users
 *    editing the inner command, and it never collides with foreign hooks
 *    that happen to share a substring.
 * 2. Legacy migration — older Relay versions wrote either
 *    (a) the legacy top-level `id` field, or
 *    (b) a current-format entry without a marker but whose inner hooks[]
 *        contains the EXACT current `hookScript` string.
 *    We treat both as "this is ours" so a fresh install replaces them
 *    cleanly. We never match by substring — only by full equality of the
 *    command string — to keep the foreign-hook blast radius at zero.
 */
function isRelayManagedHookEntry(
  entry: Record<string, unknown>,
  marker: string,
  legacyHookId: string,
  hookScript: string
): boolean {
  if (entry[HOOK_MARKER_FIELD] === marker) return true;
  if (entry['id'] === legacyHookId) return true;
  const inner = (Array.isArray(entry['hooks']) ? entry['hooks'] : []) as Array<Record<string, unknown>>;
  return inner.some(i => i['command'] === hookScript);
}

/**
 * Install or remove a CC hook (SessionStart by default; SessionEnd when
 * `sessionEnd: true`). The two hook variants are independent — installing
 * one does not touch the other, so users can opt into either or both.
 *
 * Identification is marker-based: every entry we write carries an
 * `_relay_id` field (CC ignores unknown fields). Install replaces any
 * existing entry with the matching marker (idempotent), and uninstall
 * removes only entries whose marker matches. We never use a substring
 * match against the inner command — that would risk wiping a user's own
 * hook that happens to look like ours.
 */
export async function executeMemoryHookCommand(
  command: {
    install: boolean;
    json: boolean;
    global?: boolean;
    sessionEnd?: boolean;
    userPrompt?: boolean;
  },
  io: CliIO,
  cwd: string
): Promise<number> {
  const settingsPath = resolveHookSettingsPath(cwd, command.global === true);
  const sessionEnd = command.sessionEnd === true;
  const hookEventName = sessionEnd ? 'SessionEnd' : 'SessionStart';
  const hookScript = sessionEnd ? HOOK_SCRIPT_SESSION_END : HOOK_SCRIPT;
  const legacyHookId = sessionEnd ? HOOK_ID_SESSION_END : HOOK_ID;
  const marker = sessionEnd ? HOOK_MARKER_SESSION_END : HOOK_MARKER_SESSION_START;

  let settings: Record<string, unknown> = {};
  let raw: string | undefined;
  try {
    raw = await readFile(settingsPath, 'utf8');
  } catch (err) {
    // ENOENT (file doesn't exist yet) → safe to start fresh.
    // Anything else (EACCES, EISDIR, etc.) → re-throw; caller handles it.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // P2 fix (Codex finding #7): uninstall on a fresh $HOME with no settings.json
    // is a no-op success — there is nothing to remove. Returning early avoids the
    // downstream `writeFile` call that would throw ENOENT (parent .claude/ missing)
    // and also avoids creating an empty settings file just to satisfy uninstall.
    if (!command.install) {
      if (command.json) {
        io.stdout(JSON.stringify({ installed: false, path: settingsPath, event: hookEventName, action: 'no-op', reason: 'settings-not-found' }) + '\n');
      } else {
        io.stdout(`${hookEventName} hook uninstall: no settings file at ${settingsPath} — nothing to remove.\n`);
      }
      return 0;
    }
  }
  if (raw !== undefined) {
    try {
      settings = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      // EPARSE: file exists but is not valid JSON. Aborting prevents us from
      // silently overwriting the user's hand-edited (but broken) settings.
      const msg = (err as Error).message;
      if (command.json) {
        io.stdout(JSON.stringify({ error: 'settings-parse', path: settingsPath, message: msg }) + '\n');
      }
      io.stderr(
        `relay memory hook: ${settingsPath} exists but is not valid JSON (${msg}).\n` +
          `Aborted to avoid overwriting your settings. Fix the JSON manually, then re-run.\n`
      );
      return 1;
    }
  }

  const hooks = (settings['hooks'] ?? {}) as Record<string, unknown>;
  const existing = (Array.isArray(hooks[hookEventName]) ? hooks[hookEventName] : []) as Array<Record<string, unknown>>;

  // Drop any Relay-managed entry for THIS event (matched by marker, with
  // legacy-id and exact-command fallbacks for migration). Foreign hooks are
  // preserved untouched — that is the whole point of this fix.
  const cleaned = existing.filter(h => !isRelayManagedHookEntry(h, marker, legacyHookId, hookScript));

  if (command.install) {
    // CC hook schema: each entry is { hooks: [{ type, command }] }, optionally
    // with matcher. We add `_relay_id` so future runs can find this entry by
    // marker instead of by command-string equality. CC ignores the extra field.
    cleaned.push({
      [HOOK_MARKER_FIELD]: marker,
      hooks: [{ type: 'command', command: hookScript }],
    });
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
