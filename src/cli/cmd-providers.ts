/**
 * `relay providers` — inventory of available providers (DISPATCH-03).
 *
 * Lists builtin + RELAY_PROVIDER_<NAME>_* env-discovered providers with their
 * source, protocol type, request URL, and key env-var name. Keys are masked
 * by construction: ProviderConfig carries env-var NAMES, never values
 * (T-09-01) — this command cannot print a secret. URLs are rendered through
 * redactDisplayUrl so credentials embedded IN the URL (userinfo, ?api_key=)
 * never reach the table or --json output either.
 *
 * Output:
 *   Default — fixed-width columns: name | source | type | url | key
 *   --json  — structured array (key_env_var + key_set boolean, no values)
 *
 * Exit codes: 0 on success, 1 on provider config errors (e.g. invalid _TYPE).
 */

import type { CliIO } from './commands.js';
import { c } from './colors.js';
import { redactSecrets } from '../security/redaction.js';

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
  /**
   * true on an env definition whose name collides with a builtin (review
   * fix 5): the builtin wins and `relay run` refuses the name — this row
   * shows which env config is being ignored.
   */
  readonly conflict: boolean;
}

const NAME_W = 18;
const SOURCE_W = 8;
const TYPE_W = 11;
const URL_W = 50;

/**
 * Display-only URL scrub (review fix 1): a RELAY_PROVIDER_*_URL may embed
 * credentials (`https://user:pass@host/v1?api_key=...`) that the key-column
 * masking cannot catch. Two passes:
 *   1. targeted query-param scrub — any param whose NAME suggests a secret
 *      (key/token/secret/password/pwd/credential) loses its value, regardless
 *      of value shape or length (redactSecrets' value patterns need ≥20 chars
 *      or a known prefix; a short `?key=abc` would slip through them)
 *   2. redactSecrets — covers `user:pass@` userinfo (dsn_credentials) plus
 *      every known secret-shaped value anywhere else in the string
 * Over-redaction is acceptable here: this string is for human display only;
 * dispatch derives its own URL from the raw config.
 */
export function redactDisplayUrl(url: string): string {
  const paramScrubbed = url.replace(
    /([?&][^=&#]*(?:key|token|secret|password|pwd|credential)[^=&#]*=)[^&#\s]*/gi,
    '$1[REDACTED]'
  );
  return redactSecrets(paramScrubbed);
}

export async function executeProvidersCommand(
  opts: ProvidersCommandOptions,
  io: CliIO
): Promise<number> {
  const env = opts.env ?? process.env;
  const { listProviders } = await import('../workers/provider-registry.js');

  let entries: ProviderJsonEntry[];
  try {
    entries = listProviders(env).map((p) => ({
      name: p.name,
      source: p.source,
      type: p.type,
      url: p.url === null ? null : redactDisplayUrl(p.url),
      key_env_var: p.keyEnvVar,
      key_set: p.keyEnvVar ? Boolean(env[p.keyEnvVar]?.trim()) : false,
      agentic: p.agentic,
      conflict: p.conflict === true,
    }));
  } catch (err) {
    io.stderr(`${(err as Error).message}\n`);
    return 1;
  }

  if (opts.json) {
    io.stdout(JSON.stringify(entries) + '\n');
    return 0;
  }

  const header =
    `${c.bold('name'.padEnd(NAME_W))}  ${c.bold('source'.padEnd(SOURCE_W))}  ` +
    `${c.bold('type'.padEnd(TYPE_W))}  ${c.bold('url'.padEnd(URL_W))}  ${c.bold('key')}\n`;
  io.stdout(header);
  for (const e of entries) {
    const key = e.key_env_var
      ? `${e.key_env_var} (${e.key_set ? 'set' : 'unset'})`
      : '-';
    const conflictNote = e.conflict
      ? `  ${c.red('CONFLICT — builtin name wins; rename or unset the env var')}`
      : '';
    io.stdout(
      `${e.name.padEnd(NAME_W)}  ${c.cyan(e.source.padEnd(SOURCE_W))}  ` +
        `${c.yellow(e.type.padEnd(TYPE_W))}  ${(e.url ?? 'n/a').padEnd(URL_W)}  ${c.gray(key)}` +
        `${conflictNote}\n`
    );
  }
  return 0;
}
