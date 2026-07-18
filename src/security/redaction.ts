export interface RedactionPattern {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replacement: string;
}

export const REDACTION_PATTERNS: readonly RedactionPattern[] = [
  { name: "aws_key", pattern: /AKIA[0-9A-Z]{16}/g, replacement: "[REDACTED:AWS_KEY]" },
  { name: "bearer", pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, replacement: "Bearer [REDACTED]" },
  {
    name: "openai_key",
    pattern: /sk-(?:proj-|ant-|live-)?[A-Za-z0-9_\-]{20,}/g,
    replacement: "[REDACTED:OPENAI_KEY]",
  },
  {
    name: "github_pat",
    pattern: /ghp_[A-Za-z0-9]{36}/g,
    replacement: "[REDACTED:GITHUB_PAT]",
  },
  {
    // Phase 7 — Figma personal access tokens (figd_...). Always-on (REDACTION_PATTERNS,
    // not gated to auto-extract) because PATs may leak into ANY log path (worker stdout,
    // debug dump, error stack). The tool-side `src/tools/figma/scrub.ts` is the precise
    // utility; this catch-all guards every other write path in the codebase.
    name: "figma_pat",
    pattern: /figd_[A-Za-z0-9_-]+/g,
    replacement: "[REDACTED:FIGMA_PAT]",
  },
  {
    name: "slack_token",
    pattern: /xox[baprs]-[A-Za-z0-9\-]{10,}/g,
    replacement: "[REDACTED:SLACK_TOKEN]",
  },
  {
    name: "generic_api",
    pattern: /(?:api[_-]?key|token)[=:\s]+[A-Za-z0-9_\-]{20,}/gi,
    replacement: "[REDACTED:API_KEY]",
  },
  {
    // Connection-string credentials: scheme://user:pass@host. The secret is in
    // the VALUE, not the env-var name, so the name-based env sanitizer cannot
    // catch DATABASE_URL / REDIS_URL / MONGODB_URI etc. This value pass does,
    // wherever redactSecrets runs (process output, broker messages, spawn
    // errors). Scheme + host are preserved so logs stay useful.
    name: "dsn_credentials",
    pattern: /\b([a-z][a-z0-9+.\-]*:\/\/)[^\s:/@]+:[^\s:/@]+@/gi,
    replacement: "$1[REDACTED:DSN]@",
  },
  {
    // Matches env-style assignments where the identifier contains a secret-suggestive
    // keyword (KEY, SECRET, TOKEN, PASSWORD, PWD, CREDENTIAL) as a complete `_`-delimited
    // segment. The keyword may appear anywhere in the identifier, e.g. MY_API_KEY=...,
    // USER_DB_PASSWORD=..., GITHUB_TOKEN=.... Identifier is preserved in the replacement
    // so logs remain useful; only the value is redacted.
    name: "env_assignment",
    pattern:
      /\b((?:[A-Z][A-Z0-9]*_)*(?:KEY|SECRET|TOKEN|PASSWORD|PWD|CREDENTIAL)(?:_[A-Z0-9]+)*\s*=\s*)\S+/g,
    replacement: "$1[REDACTED:ENV_SECRET]",
  },
  {
    name: "private_key",
    pattern: /-----BEGIN [A-Z]+ PRIVATE KEY-----[\s\S]+?-----END [A-Z]+ PRIVATE KEY-----/g,
    replacement: "[REDACTED:PRIVATE_KEY]",
  },
];

export function redactSecrets(
  input: string,
  patterns: readonly RedactionPattern[] = REDACTION_PATTERNS
): string {
  let result = input;
  for (const { pattern, replacement } of patterns) {
    // Create fresh RegExp to avoid stale lastIndex across calls.
    result = result.replace(new RegExp(pattern.source, pattern.flags), replacement);
  }
  return result;
}

/**
 * Values shorter than this are never scrubbed: replacing 2-3 char fragments
 * would shred unrelated text (`ab` inside `abort`) for no real protection.
 */
const MIN_KNOWN_VALUE_LENGTH = 4;

function escapeRegExpLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Value-based scrubbing (Codex round 2): replace every occurrence of each
 * KNOWN sensitive value with `[REDACTED:KNOWN]`.
 *
 * redactSecrets is pattern-matching — it only catches values that LOOK like
 * secrets. A provider/proxy echoing request headers back leaks values that
 * match no pattern (arbitrary RELAY_PROVIDER_<NAME>_HEADER_* values, short
 * x-api-key strings inside JSON echoes). Callers that constructed the
 * request know the exact values they sent; this scrubs those verbatim.
 *
 * Longest value first, so a shorter value that is a prefix/substring of a
 * longer one cannot split the longer one and leak its tail. Values are
 * escaped — matched as literals, never as regex patterns. Run this BEFORE
 * redactSecrets: a pattern can partially consume a known value and leave a
 * fragment behind that the exact match would then miss.
 */
export function scrubKnownValues(text: string, values: readonly string[]): string {
  const candidates = [...new Set(values)]
    .filter((v) => v.length >= MIN_KNOWN_VALUE_LENGTH)
    .sort((a, b) => b.length - a.length);
  let result = text;
  for (const value of candidates) {
    result = result.replace(
      new RegExp(escapeRegExpLiteral(value), "g"),
      "[REDACTED:KNOWN]"
    );
  }
  return result;
}
