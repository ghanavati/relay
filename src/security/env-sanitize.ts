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
 *
 * STUB (RED): isAgenticSandbox and sanitizeChildEnv are non-functional here so
 * the new tests fail for the right reason; the real behavior lands in GREEN.
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
export function isAgenticSandbox(_env: NodeJS.ProcessEnv = process.env): boolean {
  // STUB (RED) — always false so the cmd-session guard tests fail.
  return false;
}

/**
 * Strip secret-shaped names AND the entire RELAY_* control/config namespace
 * (including the sandbox marker) from a copied env, preserving everything else.
 */
export function sanitizeChildEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // STUB (RED) — identity copy (no stripping) so the pty env test fails.
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}
