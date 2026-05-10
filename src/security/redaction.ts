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
