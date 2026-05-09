import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { REDACTION_PATTERNS, redactSecrets } from './redaction.js';
import { FULL_PATTERNS, PII_PATTERNS, redactSecretsAndPII } from './redaction-pii.js';

describe('redactSecretsAndPII — PII patterns', () => {
  test('jwt: redacts a 3-segment JWT token', () => {
    const input = 'auth: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const result = redactSecretsAndPII(input);
    assert.match(result, /\[REDACTED:JWT\]/);
    assert.doesNotMatch(result, /eyJhbGci/);
  });

  test('gh_fine_grained_pat: redacts a github_pat_ token (82 chars after prefix)', () => {
    const token = 'github_pat_' + 'A'.repeat(82);
    // Use a context word that does NOT trigger the original generic_api pattern
    // (which would otherwise consume the value first and label it API_KEY).
    const input = `value ${token} done`;
    const result = redactSecretsAndPII(input);
    assert.match(result, /\[REDACTED:GITHUB_FINE_GRAINED_PAT\]/);
    assert.doesNotMatch(result, /github_pat_A/);
  });

  test('stripe: redacts sk_live, rk_test, pk_test variants', () => {
    const input = 'keys: sk_live_abcdefghijklmnopqrstuvwx rk_test_ABCDEFGHIJKLMNOPQRSTUVWX pk_test_1234567890abcdefghijklmn';
    const result = redactSecretsAndPII(input);
    const occurrences = result.match(/\[REDACTED:STRIPE_KEY\]/g) ?? [];
    assert.strictEqual(occurrences.length, 3);
  });

  test('gcp_service_account: redacts private_key field block', () => {
    const input = '{"type":"service_account","private_key": "-----BEGIN PRIVATE KEY-----\\nABC...XYZ\\n-----END PRIVATE KEY-----\\n","client_email":"x@y.iam.gserviceaccount.com"}';
    const result = redactSecretsAndPII(input);
    assert.match(result, /\[REDACTED:GCP_PRIVATE_KEY\]/);
    assert.doesNotMatch(result, /BEGIN PRIVATE KEY/);
  });

  test('db_url: redacts postgres/mysql/mongodb/redis URLs with credentials', () => {
    const inputs = [
      'postgres://user:pass@host.example.com:5432/db',
      'mysql://root:secret@10.0.0.1:3306/app',
      'mongodb+srv://admin:p%40ss@cluster0.mongodb.net/test',
      'redis://default:longpasswordhere@redis-12345.cloud.redislabs.com:12345',
    ];
    for (const input of inputs) {
      const result = redactSecretsAndPII(input);
      assert.match(result, /\[REDACTED:DB_URL\]/, `expected redaction in: ${input}`);
    }
  });

  test('email: redacts plain email addresses', () => {
    const input = 'Contact: alice.smith+work@example.co.uk for help';
    const result = redactSecretsAndPII(input);
    assert.match(result, /\[REDACTED:EMAIL\]/);
    assert.doesNotMatch(result, /alice\.smith/);
  });

  test('ipv4_private: redacts 10.x, 192.168.x, 172.16-31.x', () => {
    const inputs = ['10.0.0.1', '192.168.1.42', '172.16.5.10', '172.31.255.254'];
    for (const ip of inputs) {
      const result = redactSecretsAndPII(`server at ${ip} listening`);
      assert.match(result, /\[REDACTED:PRIVATE_IP\]/, `expected redaction for ${ip}`);
    }
  });

  test('ipv4_private: does NOT redact public IPs', () => {
    const input = 'public DNS 8.8.8.8 and 1.1.1.1 are fine';
    const result = redactSecretsAndPII(input);
    assert.doesNotMatch(result, /\[REDACTED:PRIVATE_IP\]/);
  });

  test('internal_lan_host: redacts .lan/.local/.internal/.corp/.intra hostnames', () => {
    const inputs = ['db01.internal', 'printer.local', 'host.lan', 'app.corp', 'svc.intra'];
    for (const host of inputs) {
      const result = redactSecretsAndPII(`ping ${host} now`);
      assert.match(result, /\[REDACTED:INTERNAL_HOST\]/, `expected redaction for ${host}`);
    }
  });

  test('env_assignment: redacts SECRET/TOKEN/PASSWORD/API_KEY assignments with 8+ char value', () => {
    // The pattern requires the word to start at a \b boundary, so
    // DATABASE_PASSWORD won't match (no \b between _ and PASSWORD); use the
    // bare keyword forms which is what env files / shell exports actually
    // produce in real-world transcripts.
    const inputs = [
      'PASSWORD=supersecret123',
      'API_KEY: "abcdef1234567890"',
      'CLIENT_SECRET=zxcvbnmasdfghjk',
      'TOKEN=ghs_aaaaaaaaaa',
    ];
    for (const input of inputs) {
      const result = redactSecretsAndPII(input);
      // Either the new env_assignment pattern matched, or the existing
      // generic_api pattern picked it up — both are acceptable; we just
      // require the secret value to be gone.
      assert.match(
        result,
        /\[REDACTED:(ENV_SECRET|API_KEY)\]/,
        `expected redaction in: ${input}`,
      );
    }
    // And confirm at least one input genuinely exercises the new pattern
    // (the generic_api regex requires the word "token"/"key"; "PASSWORD" alone
    // does not, so this case must be handled by env_assignment).
    const passwordOnly = redactSecretsAndPII('PASSWORD=supersecret123');
    assert.match(passwordOnly, /\[REDACTED:ENV_SECRET\]/);
  });

  test('FULL_PATTERNS includes all original + PII patterns', () => {
    assert.strictEqual(FULL_PATTERNS.length, REDACTION_PATTERNS.length + PII_PATTERNS.length);
  });

  test('original REDACTION_PATTERNS / redactSecrets unchanged (no PII redaction)', () => {
    const input = 'Email user@example.com is fine in code comments';
    const result = redactSecrets(input);
    assert.doesNotMatch(result, /\[REDACTED:EMAIL\]/);
    assert.match(result, /user@example\.com/);
  });

  test('original AWS / OpenAI / GitHub PAT patterns still applied via FULL_PATTERNS', () => {
    const input = 'AKIAIOSFODNN7EXAMPLE and sk-proj-abcdefghijklmnopqrstuvwxyz123456';
    const result = redactSecretsAndPII(input);
    assert.match(result, /\[REDACTED:AWS_KEY\]/);
    assert.match(result, /\[REDACTED:OPENAI_KEY\]/);
  });
});
