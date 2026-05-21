/**
 * Phase 7 / Task 1 — Figma PAT scrubbing utility.
 *
 * Layered defense-in-depth: every string that may become a log line, error
 * message, or stderr write passes through `scrubPat` BEFORE emission. The
 * always-on `src/security/redaction.ts` also matches `figd_*` (added in
 * the redaction module), but this module is the precise utility used by
 * `rest-client.ts`, `cmd-doctor.ts`, and any handler that touches PATs.
 *
 * Threat coverage:
 *   - T-07-01 — error path PAT leak (rest-client)
 *   - T-07-02 — debug log PAT leak (RELAY_LMSTUDIO_DEBUG_DUMP=1)
 *   - T-07-10 — cmd-doctor stderr PAT leak
 *
 * Design choices:
 *   - All functions are PURE. Inputs are never mutated.
 *   - `scrubHeaders` returns a NEW object — immutability per
 *     ~/.claude/rules/typescript/coding-style.md.
 *   - `scrubError` returns a NEW Error — the original is left intact so
 *     callers can compare types (instanceof) before rethrowing.
 *   - Regex intentionally matches `figd_` followed by 1+ token chars (broad,
 *     fail-loud). Real Figma PATs are 40+ chars but partial-leak fragments
 *     should also be masked.
 */

/** Sentinel replacement for any Figma personal access token (PAT). */
export const SCRUB_SENTINEL = 'figd_***SCRUBBED***';

/** Matches `figd_` + 1 or more URL-safe token chars. Global so all occurrences are replaced. */
const FIGMA_PAT_RE = /figd_[A-Za-z0-9_-]+/g;

/**
 * Replace every Figma PAT in `input` with the SCRUB_SENTINEL.
 * Returns `input` unchanged when no match is present (identity preserved).
 *
 * Pure: never mutates input (strings are immutable in JS, but this is also
 * the foundational primitive for `scrubHeaders` and `scrubError`).
 */
export function scrubPat(input: string): string {
  if (typeof input !== 'string') return input;
  // Fresh regex literal usage — `.replace` does not mutate the regex object,
  // but we re-allocate to avoid any cross-call lastIndex surprises.
  return input.replace(new RegExp(FIGMA_PAT_RE.source, FIGMA_PAT_RE.flags), SCRUB_SENTINEL);
}

/**
 * Return a NEW header object with any Figma PAT value masked.
 *
 * Header keys are checked case-insensitively for `x-figma-token` — that header
 * is always-masked regardless of value content. All OTHER header values are
 * also passed through `scrubPat` so a stray PAT embedded elsewhere (e.g. a
 * misconfigured `Authorization: Bearer figd_...`) is still scrubbed.
 *
 * Immutability: source object is never modified. Returns new shallow copy.
 */
export function scrubHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== 'string') {
      out[key] = value;
      continue;
    }
    if (key.toLowerCase() === 'x-figma-token') {
      out[key] = SCRUB_SENTINEL;
    } else {
      out[key] = scrubPat(value);
    }
  }
  return out;
}

/**
 * Return a NEW Error with `.message` and `.stack` PAT-scrubbed.
 *
 * - If `err` is already an Error, copy `name`, `message`, `stack`, `cause`.
 * - Otherwise stringify and wrap into a generic Error.
 *
 * The original Error object is NEVER mutated — callers can still rethrow
 * the source after extracting a scrubbed copy (e.g., for logging without
 * losing the typed reference).
 */
export function scrubError(err: unknown): Error {
  if (err instanceof Error) {
    const out = new Error(scrubPat(err.message));
    out.name = err.name;
    if (err.stack) out.stack = scrubPat(err.stack);
    // Preserve cause if present (Node 16+). Recursive scrub — Error nested,
    // string/object/anything-else stringified through scrubPat so a future
    // code path putting `{ headers: { 'X-Figma-Token': 'figd_...' } }` as a
    // cause object cannot leak PAT via stderr / structured log serializers.
    const cause = (err as Error & { cause?: unknown }).cause;
    if (cause !== undefined) {
      (out as Error & { cause?: unknown }).cause = scrubCause(cause);
    }
    return out;
  }
  return new Error(scrubPat(typeof err === 'string' ? err : JSON.stringify(err)));
}

/**
 * Recursively scrub a cause value of any shape. Errors recurse via scrubError;
 * everything else is JSON-stringified through scrubPat so embedded PATs never
 * survive a `JSON.stringify({ cause })` at the log boundary.
 */
function scrubCause(cause: unknown): unknown {
  if (cause instanceof Error) return scrubError(cause);
  if (typeof cause === 'string') return scrubPat(cause);
  try {
    return scrubPat(JSON.stringify(cause));
  } catch {
    return '[unserializable cause]';
  }
}
