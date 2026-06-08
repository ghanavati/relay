/**
 * Shared env-sanitization for spawned children (Phase 8 security fix).
 *
 * Two paths hand a subprocess an environment:
 *   - shell_exec inside lmstudio-agentic (model-emitted commands)
 *   - Relay-owned process sessions in control/pty-session
 *
 * Both must keep provider secrets and the Relay control namespace out of the
 * child. A child that prints `env` would otherwise leak API keys into stored
 * control events, and RELAY_DB_PATH / RELAY_ALLOWED_ROOTS would hand a model
 * the control database path and its own scoping.
 */

/** Env var name marking a process as an agentic shell_exec sandbox child. */
export const AGENTIC_SANDBOX_ENV = 'RELAY_AGENTIC_SANDBOX';

/**
 * Credential keywords. A `\b`-anchored regex is NOT enough: `_` is a regex
 * word char, so `KEY\b` never fires in `AWS_ACCESS_KEY_ID` and `CREDENTIAL\b`
 * misses `..._CREDENTIALS`. We instead split the name on non-alphanumerics and
 * match per segment (plus glued prefix/suffix for names like `PGPASSWORD`).
 */
const SECRET_KEYWORDS: readonly string[] = [
  'KEY',
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'PWD',
  'CREDENTIAL',
  'CREDENTIALS',
  'PRIVATE',
  'AUTH',
];

/**
 * True when the env name looks like it carries a secret. Delimiter-aware:
 * `AWS_ACCESS_KEY_ID`, `GOOGLE_APPLICATION_CREDENTIALS`, `SSH_AUTH_SOCK`,
 * `MYSQL_PWD`, `PGPASSWORD` all match. Over-stripping a benign var from a child
 * env is safe; leaking a credential is not, so this errs toward stripping.
 *
 * Exception: a bare `PWD` is the POSIX working-directory var, not a secret, so
 * it is kept when it is the whole name (but `MYSQL_PWD` and friends still match).
 */
export function isSecretEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  const segments = upper.split(/[^A-Z0-9]+/).filter(Boolean);
  if (segments.length === 1 && segments[0] === 'PWD') return false;
  for (const seg of segments) {
    for (const kw of SECRET_KEYWORDS) {
      if (seg === kw || seg.endsWith(kw) || seg.startsWith(kw)) return true;
    }
  }
  return false;
}

/** True when this process is an agentic shell_exec sandbox child. */
export function isAgenticSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[AGENTIC_SANDBOX_ENV] === '1';
}

/**
 * Strip secret-shaped names AND the entire RELAY_* control/config namespace
 * (including the sandbox marker) from a copied env, preserving everything else.
 *
 * Used for Relay-owned process sessions (control/pty-session), which are
 * operator-launched and need a broadly-complete env (SHELL, XDG_*, locale)
 * minus secrets and control vars. RELAY_DB_PATH, RELAY_ALLOWED_ROOTS,
 * RELAY_MEMORY_ALLOWED_WORKDIRS, RELAY_CONFIG, RELAY_RECALLED_LESSONS et al. are
 * all dropped — a child has no business reading the control DB path or its own
 * scoping. Provider API keys (ANTHROPIC_API_KEY, OPENROUTER_API_KEY, ...) are
 * secret-shaped and dropped too.
 */
export function sanitizeChildEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (isSecretEnvName(key)) continue;
    if (key.startsWith('RELAY_')) continue;
    out[key] = value;
  }
  return out;
}
