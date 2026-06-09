/**
 * `relay providers` — inventory of available providers.
 *
 * RED skeleton (09-01 Task 3): exports compile, behavior not implemented yet.
 */

import type { CliIO } from './commands.js';

export interface ProvidersCommandOptions {
  readonly json: boolean;
  /** Injected env for tests; defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
}

/** One row in the JSON output — key VALUES are never present by construction. */
export interface ProviderJsonEntry {
  readonly name: string;
  readonly source: 'builtin' | 'env';
  readonly type: string;
  readonly url: string | null;
  readonly key_env_var: string | null;
  readonly key_set: boolean;
  readonly agentic: boolean;
}

export async function executeProvidersCommand(
  _opts: ProvidersCommandOptions,
  io: CliIO
): Promise<number> {
  io.stderr('not implemented\n');
  return 1;
}
