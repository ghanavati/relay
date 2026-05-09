/**
 * `relay project` — per-project privacy controls.
 *
 * Three actions, all scoped to the cwd (no global writes):
 *   relay project disable [--yes] [--json]
 *     Writes a `.relayignore` file with extract/recall/hook/shareable all OFF.
 *     Adds `.relayignore` to `.gitignore` (interactively or via --yes).
 *   relay project enable [--yes] [--json]
 *     Removes `.relayignore` (with confirmation) so default behaviour resumes.
 *   relay project audit [--json]
 *     Read-only scan: counts relay hooks deployed via committed
 *     `.claude/settings.json` and counts memories scoped to this workdir
 *     that to-rules promotion would leak into a committed CLAUDE.md.
 *
 * `.relayignore` format mirrors `.gitignore` (one key per line); we use a
 * deliberately simple `key: value` shape so the file is human-editable and
 * trivially diffable. See README for full schema.
 */
import type { CliIO } from './commands.js';
import { readFile, writeFile, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { c } from './colors.js';

export interface ProjectArgs {
  action: 'disable' | 'enable' | 'audit';
  yes: boolean;
  json: boolean;
}

const RELAYIGNORE_FILENAME = '.relayignore';
const GITIGNORE_FILENAME = '.gitignore';
const SETTINGS_PATH = join('.claude', 'settings.json');

const DISABLED_CONTENT = 'extract: off\nrecall: off\nhook: off\nshareable: false\n';

async function pathExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function confirm(question: string, defaultYes: boolean): Promise<boolean> {
  if (!stdin.isTTY) return defaultYes;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
    const ans = (await rl.question(question + suffix)).trim().toLowerCase();
    if (!ans) return defaultYes;
    return ans === 'y' || ans === 'yes';
  } finally {
    rl.close();
  }
}

/** Append `.relayignore` to .gitignore if not already present. Returns true when modified. */
async function ensureGitignoreEntry(gitignorePath: string): Promise<boolean> {
  let existing = '';
  try { existing = await readFile(gitignorePath, 'utf8'); } catch { /* new file */ }
  // Match the exact entry on its own line — avoid false positives like `node_modules/.relayignore`.
  const lines = existing.split('\n').map(l => l.trim());
  if (lines.includes(RELAYIGNORE_FILENAME) || lines.includes('/' + RELAYIGNORE_FILENAME)) {
    return false;
  }
  const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  const updated = existing + sep + RELAYIGNORE_FILENAME + '\n';
  await writeFile(gitignorePath, updated, 'utf8');
  return true;
}

export async function executeProjectDisableCommand(args: ProjectArgs, io: CliIO): Promise<number> {
  const cwd = io.cwd;
  const relayignorePath = join(cwd, RELAYIGNORE_FILENAME);
  const gitignorePath = join(cwd, GITIGNORE_FILENAME);

  let proceed = args.yes || args.json;
  if (!proceed) {
    proceed = await confirm(`Disable Relay extract/recall/hook/share for ${cwd}?`, true);
  }
  if (!proceed) {
    if (!args.json) io.stdout('Aborted.\n');
    return 0;
  }

  try {
    await writeFile(relayignorePath, DISABLED_CONTENT, 'utf8');
  } catch (err) {
    const msg = (err as Error).message;
    if (args.json) io.stdout(JSON.stringify({ error: 'write_failed', path: relayignorePath, detail: msg }) + '\n');
    else io.stderr(`Failed to write ${relayignorePath}: ${msg}\n`);
    return 1;
  }

  let gitignoreUpdated = false;
  let askGitignore = args.yes || args.json;
  if (!askGitignore) {
    askGitignore = await confirm(`Add ${RELAYIGNORE_FILENAME} to .gitignore?`, true);
  }
  if (askGitignore) {
    try {
      gitignoreUpdated = await ensureGitignoreEntry(gitignorePath);
    } catch (err) {
      const msg = (err as Error).message;
      if (args.json) io.stdout(JSON.stringify({ error: 'gitignore_failed', path: gitignorePath, detail: msg }) + '\n');
      else io.stderr(`Failed to update ${gitignorePath}: ${msg}\n`);
      return 1;
    }
  }

  if (args.json) {
    io.stdout(JSON.stringify({
      action: 'disable',
      relayignore_path: relayignorePath,
      gitignore_updated: gitignoreUpdated,
    }) + '\n');
  } else {
    io.stdout(`${c.green('Disabled')} Relay for ${cwd}\n`);
    io.stdout(`  wrote ${relayignorePath}\n`);
    if (gitignoreUpdated) io.stdout(`  appended ${RELAYIGNORE_FILENAME} to ${GITIGNORE_FILENAME}\n`);
    else if (askGitignore) io.stdout(`  ${RELAYIGNORE_FILENAME} already in ${GITIGNORE_FILENAME}\n`);
  }
  return 0;
}

export async function executeProjectEnableCommand(args: ProjectArgs, io: CliIO): Promise<number> {
  const cwd = io.cwd;
  const relayignorePath = join(cwd, RELAYIGNORE_FILENAME);

  if (!(await pathExists(relayignorePath))) {
    if (args.json) io.stdout(JSON.stringify({ action: 'enable', already_enabled: true, path: relayignorePath }) + '\n');
    else io.stdout(`Relay is already enabled here (no ${RELAYIGNORE_FILENAME} present).\n`);
    return 0;
  }

  let proceed = args.yes || args.json;
  if (!proceed) {
    proceed = await confirm(`Remove ${relayignorePath} and re-enable Relay for ${cwd}?`, true);
  }
  if (!proceed) {
    if (!args.json) io.stdout('Aborted.\n');
    return 0;
  }

  try {
    await unlink(relayignorePath);
  } catch (err) {
    const msg = (err as Error).message;
    if (args.json) io.stdout(JSON.stringify({ error: 'unlink_failed', path: relayignorePath, detail: msg }) + '\n');
    else io.stderr(`Failed to remove ${relayignorePath}: ${msg}\n`);
    return 1;
  }

  if (args.json) {
    io.stdout(JSON.stringify({ action: 'enable', removed: relayignorePath }) + '\n');
  } else {
    io.stdout(`${c.green('Enabled')} Relay for ${cwd}\n`);
    io.stdout(`  removed ${relayignorePath}\n`);
  }
  return 0;
}

interface AuditResult {
  hooks_deployed: number;
  hook_settings_path: string | null;
  workdir_memories: number;
  workdir: string;
}

/**
 * Read-only scan: counts relay hooks committed via .claude/settings.json
 * and memories scoped to the cwd workdir (which to-rules promotion would
 * leak into a committed rules file). Always exits 0 unless an unexpected
 * error occurs.
 */
export async function executeProjectAuditCommand(args: ProjectArgs, io: CliIO): Promise<number> {
  const cwd = io.cwd;
  const settingsPath = join(cwd, SETTINGS_PATH);

  let hookCount = 0;
  let hookSettingsPath: string | null = null;
  if (await pathExists(settingsPath)) {
    try {
      const raw = await readFile(settingsPath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const hooks = (parsed['hooks'] ?? {}) as Record<string, unknown>;
      const sessionStart = (Array.isArray(hooks['SessionStart']) ? hooks['SessionStart'] : []) as Array<Record<string, unknown>>;
      for (const entry of sessionStart) {
        const inner = (Array.isArray(entry['hooks']) ? entry['hooks'] : []) as Array<Record<string, unknown>>;
        for (const i of inner) {
          const cmd = i['command'];
          if (typeof cmd === 'string' && cmd.includes('relay memory recall')) hookCount++;
        }
      }
      if (hookCount > 0) hookSettingsPath = settingsPath;
    } catch (err) {
      // Non-fatal — surface in JSON detail. Audit is read-only so we keep going.
      if (!args.json) io.stderr(`(warning) failed to parse ${settingsPath}: ${(err as Error).message}\n`);
    }
  }

  let memoryCount = 0;
  try {
    const { MemoryStore } = await import('../memory/memory-store.js');
    const { getDb } = await import('../runtime/store/db.js');
    // Touch MemoryStore so DB migrations run before the count query.
    new MemoryStore();
    const row = getDb()
      .prepare('SELECT COUNT(*) AS n FROM memories WHERE workdir = ? AND superseded_by IS NULL')
      .get(cwd) as { n: number } | undefined;
    memoryCount = row?.n ?? 0;
  } catch (err) {
    if (!args.json) io.stderr(`(warning) failed to scan memories: ${(err as Error).message}\n`);
  }

  const result: AuditResult = {
    hooks_deployed: hookCount,
    hook_settings_path: hookSettingsPath,
    workdir_memories: memoryCount,
    workdir: cwd,
  };

  if (args.json) {
    io.stdout(JSON.stringify(result) + '\n');
  } else {
    io.stdout(c.bold('relay project audit') + '\n\n');
    io.stdout(`${result.hooks_deployed} hooks would deploy if cloned, ${result.workdir_memories} memories would leak via to-rules history.\n`);
    if (hookSettingsPath) io.stdout(`  hooks source: ${hookSettingsPath}\n`);
    io.stdout(`  workdir scope: ${cwd}\n`);
  }
  return 0;
}

export async function executeProjectCommand(args: ProjectArgs, io: CliIO): Promise<number> {
  if (args.action === 'disable') return executeProjectDisableCommand(args, io);
  if (args.action === 'enable') return executeProjectEnableCommand(args, io);
  if (args.action === 'audit') return executeProjectAuditCommand(args, io);
  io.stderr(`relay project: unknown action '${args.action as string}'. Try: disable | enable | audit\n`);
  return 2;
}
