/**
 * Provider probe functions — shared by `relay doctor` and `relay init`.
 *
 * Each probe returns a unified `ProviderProbe` shape. Status semantics:
 *   - 'ok'      — provider is reachable / configured
 *   - 'failed'  — provider was attempted (CLI/HTTP) and explicitly failed
 *   - 'missing' — env-key based provider, the env var is not set
 *
 * Callers translating to a boolean "available" should treat `status === 'ok'`
 * as available and any other value as unavailable.
 */

import { execFile } from 'node:child_process';

export interface ProviderProbe {
  name: string;
  status: 'ok' | 'failed' | 'missing';
  detail: string;
}

/** Probe codex CLI — `codex --version`. 5s timeout. */
export async function probeCodex(): Promise<ProviderProbe> {
  return new Promise<ProviderProbe>((resolve) => {
    execFile('codex', ['--version'], { encoding: 'utf-8', timeout: 5000 }, (err, stdoutData) => {
      if (err) {
        resolve({ name: 'codex', status: 'failed', detail: 'codex not found or not accessible' });
      } else {
        const version = (stdoutData as string).trim();
        resolve({ name: 'codex', status: 'ok', detail: `codex-cli ${version}` });
      }
    });
  });
}

/** Probe LM Studio HTTP endpoint — `${LMSTUDIO_ENDPOINT|http://localhost:1234}/v1/models`. 3s timeout. */
export async function probeLmStudio(): Promise<ProviderProbe> {
  const endpoint = process.env['LMSTUDIO_ENDPOINT'] ?? 'http://localhost:1234';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${endpoint}/v1/models`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return { name: 'lmstudio', status: 'failed', detail: 'LM Studio endpoint not reachable' };
    }
    const json = (await res.json()) as { data?: unknown[] };
    const count = Array.isArray(json.data) ? json.data.length : 0;
    return { name: 'lmstudio', status: 'ok', detail: `${endpoint} (${count} models)` };
  } catch {
    clearTimeout(timer);
    return { name: 'lmstudio', status: 'failed', detail: 'LM Studio endpoint not reachable' };
  }
}

/** Probe an env-var-based provider — returns 'ok' if set, 'missing' otherwise. */
export function probeEnvKey(envName: string, label: string): ProviderProbe {
  const v = process.env[envName];
  return v
    ? { name: label, status: 'ok', detail: `${envName} set` }
    : { name: label, status: 'missing', detail: `${envName} not set` };
}
