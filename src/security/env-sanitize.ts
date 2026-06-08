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
 * Secret-shaped env name matcher: any var whose name carries a credential
 * keyword on a word boundary (KEY, TOKEN, SECRET, PASSWORD, ...). Case-insensitive.
 */
export const SECRET_NAME_PATTERN = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH)\b/i;

/** True when the env name looks like a secret. */
export function isSecretEnvName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name);
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
