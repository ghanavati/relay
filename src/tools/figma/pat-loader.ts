/**
 * Phase 7 / Task 1 — Figma PAT loader.
 *
 * Resolution order (FIGMA-03 graceful absence):
 *   1. env.FIGMA_API_TOKEN — wins if non-empty after trim.
 *   2. {homeDir}/.relay/secrets/figma.json → { "token": "figd_..." }
 *   3. Neither → returns null (NEVER throws — caller decides what to do).
 *
 * Chmod 600 enforcement (T-07-03 mitigation):
 *   If figma.json exists with permissions allowing group/other read, the
 *   loader REFUSES to read it, emits a single stderr warning, and returns
 *   null. Mirrors the codex tempfile pattern (src/workers/codex.ts:49) but
 *   on the READ side.
 *
 * Pure-ish: no network, no async, only sync IO + one stderr warn on chmod
 * failure. Sync fs matches the better-sqlite3 / config-loading convention
 * already used across the codebase (e.g. src/cli/cmd-doctor.ts uses sync).
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const FIGMA_TOKEN_ENV = 'FIGMA_API_TOKEN';
const RELATIVE_SECRETS_PATH = ['.relay', 'secrets', 'figma.json'] as const;
const RELATIVE_WORKDIR_PATH = ['.relay', 'figma.json'] as const;

/** chmod mask for group + other read/write/execute bits. Non-zero → file is too-open. */
const GROUP_OTHER_MASK = 0o077;

/**
 * Load the Figma PAT (personal access token) from env > home-secrets-file > null.
 *
 * @param env    process env (passed in for testability — never reads process.env directly)
 * @param homeDir absolute path to the user's home directory (os.homedir() in production)
 * @returns trimmed PAT string when available; null otherwise (FIGMA-03 graceful)
 *
 * IMPORTANT: returns null on every failure path (missing file, malformed JSON,
 * empty token, chmod violation). Never throws — the caller (registerFigmaTools)
 * uses null as the signal to skip tool registration entirely.
 */
export function loadPat(env: NodeJS.ProcessEnv, homeDir: string): string | null {
  // 1. env wins (highest priority — matches getOpenRouterApiKey pattern).
  const envValue = env[FIGMA_TOKEN_ENV]?.trim();
  if (envValue) return envValue;

  // 2. ~/.relay/secrets/figma.json fallback.
  const filePath = join(homeDir, ...RELATIVE_SECRETS_PATH);
  let mode: number;
  try {
    const st = statSync(filePath);
    mode = st.mode;
  } catch {
    // File does not exist (or other stat failure) — pure graceful absence.
    return null;
  }

  // Chmod 600 check — if group/other has any permission, refuse to read.
  if ((mode & GROUP_OTHER_MASK) !== 0) {
    process.stderr.write(
      `relay: refusing to read ${filePath} — file must be chmod 600 ` +
        `(current mode allows group/other access). Run: chmod 600 ${filePath}\n`,
    );
    return null;
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  let parsed: { token?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const token = typeof parsed.token === 'string' ? parsed.token.trim() : '';
  if (!token) return null;
  return token;
}

/**
 * Load the per-workdir Figma file_key binding from `${workdir}/.relay/figma.json`.
 *
 * Designer-user pattern: each project workdir can declare which Figma file it
 * binds to, so `relay run --task "list layers in this file"` doesn't require
 * the model to know the key. NOT a credential — `file_key` is a public
 * identifier (T-07-04 accepted risk).
 *
 * Returns null gracefully when file absent or malformed.
 */
export function loadWorkdirFileKey(workdir: string): string | null {
  const filePath = join(workdir, ...RELATIVE_WORKDIR_PATH);
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  let parsed: { file_key?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const key = typeof parsed.file_key === 'string' ? parsed.file_key.trim() : '';
  return key || null;
}
