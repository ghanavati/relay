/**
 * Minimal ANSI color helper for the CLI.
 *
 * Honors the NO_COLOR convention (https://no-color.org). Auto-detects TTY:
 * - colors ON when stdout is a TTY AND `NO_COLOR`/`CI` unset AND `TERM` != "dumb"
 * - colors OFF otherwise
 *
 * The `--color=auto|always|never` CLI flag overrides auto-detection. If
 * `RELAY_COLOR` env var is set to any of those, that overrides too.
 *
 * Zero deps. ~50 lines. No `chalk`. The full SGR ANSI subset we use:
 *   - 0=reset, 1=bold, 2=dim, 31=red, 32=green, 33=yellow, 34=blue, 36=cyan, 90=gray
 */
const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const;

let cachedEnabled: boolean | null = null;

export type ColorMode = 'auto' | 'always' | 'never';

export function setColorMode(mode: ColorMode): void {
  cachedEnabled =
    mode === 'always' ? true :
    mode === 'never' ? false :
    null;
}

export function colorsEnabled(): boolean {
  if (cachedEnabled !== null) return cachedEnabled;

  const envOverride = process.env['RELAY_COLOR'];
  if (envOverride === 'always') return true;
  if (envOverride === 'never') return false;

  if (process.env['CI']) return false;
  if (process.env['NO_COLOR']) return false;
  if (process.env['TERM'] === 'dumb') return false;
  if (!process.stdout.isTTY) return false;

  return true;
}

function wrap(code: string, text: string): string {
  return colorsEnabled() ? `${code}${text}${ANSI.reset}` : text;
}

export const c = {
  bold: (s: string) => wrap(ANSI.bold, s),
  dim: (s: string) => wrap(ANSI.dim, s),
  red: (s: string) => wrap(ANSI.red, s),
  green: (s: string) => wrap(ANSI.green, s),
  yellow: (s: string) => wrap(ANSI.yellow, s),
  blue: (s: string) => wrap(ANSI.blue, s),
  cyan: (s: string) => wrap(ANSI.cyan, s),
  gray: (s: string) => wrap(ANSI.gray, s),
};

/** Render a status badge — `[OK]` green, `[!!]` red, `[--]` gray. */
export function statusBadge(status: 'ok' | 'failed' | 'missing' | 'success' | 'error' | 'timeout' | string): string {
  if (status === 'ok' || status === 'success') return c.green('[OK]');
  if (status === 'failed' || status === 'error') return c.red('[!!]');
  if (status === 'timeout') return c.yellow('[..]');
  return c.gray('[--]');
}
