import { REDACTION_PATTERNS, redactSecrets, type RedactionPattern } from './redaction.js';

/**
 * Extended PII / secret patterns for the auto-extract pipeline ONLY.
 *
 * These patterns are intentionally separated from REDACTION_PATTERNS because
 * they over-match in code-bearing content (e.g., the `email` pattern would
 * mangle author lines in code, the `db_url` pattern would erase example
 * connection strings in documentation, etc.).
 *
 * Use REDACTION_PATTERNS / redactSecrets for memory writes (where preserving
 * code content matters). Use FULL_PATTERNS / redactSecretsAndPII for
 * transcripts shipped to an LLM for auto-extraction (where erring toward
 * over-redaction is the safer default).
 */
export const PII_PATTERNS: readonly RedactionPattern[] = [
  {
    name: 'jwt',
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    replacement: '[REDACTED:JWT]',
  },
  {
    name: 'gh_fine_grained_pat',
    pattern: /github_pat_[A-Za-z0-9_]{82}/g,
    replacement: '[REDACTED:GITHUB_FINE_GRAINED_PAT]',
  },
  {
    name: 'stripe',
    pattern: /(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9]{24,}/g,
    replacement: '[REDACTED:STRIPE_KEY]',
  },
  {
    name: 'gcp_service_account',
    pattern: /"private_key":\s*"-----BEGIN[\s\S]+?-----END[^"]+"/g,
    replacement: '"private_key": "[REDACTED:GCP_PRIVATE_KEY]"',
  },
  {
    name: 'db_url',
    pattern: /\b(?:postgres|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"']{3,}:[^\s"']{3,}@[^\s"']+/gi,
    replacement: '[REDACTED:DB_URL]',
  },
  {
    name: 'email',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    replacement: '[REDACTED:EMAIL]',
  },
  {
    name: 'ipv4_private',
    pattern: /\b(?:10|192\.168|172\.(?:1[6-9]|2[0-9]|3[01]))(?:\.\d{1,3}){2,3}\b/g,
    replacement: '[REDACTED:PRIVATE_IP]',
  },
  {
    name: 'internal_lan_host',
    pattern: /\b[\w-]+\.(?:lan|local|internal|corp|intra)\b/gi,
    replacement: '[REDACTED:INTERNAL_HOST]',
  },
  {
    name: 'env_assignment',
    pattern:
      /\b(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET)[A-Z_]*\s*[:=]\s*['"]?[^\s'"]{8,}/gi,
    replacement: '[REDACTED:ENV_SECRET]',
  },
];

/**
 * Combined patterns: original secret patterns + extended PII patterns.
 * For use by the auto-extract pipeline before sending transcripts to an LLM.
 */
export const FULL_PATTERNS: readonly RedactionPattern[] = [...REDACTION_PATTERNS, ...PII_PATTERNS];

/**
 * Apply both the original secret patterns and the extended PII patterns.
 *
 * Intended ONLY for the auto-extract pre-redaction step. Do NOT use this for
 * memory writes — over-redaction can corrupt code content stored in memories.
 */
export function redactSecretsAndPII(text: string): string {
  return redactSecrets(text, FULL_PATTERNS);
}
