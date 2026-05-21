import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { redactSecrets, REDACTION_PATTERNS } from './redaction.js';

describe('redactSecrets — existing patterns (no regression)', () => {
  test('AWS access key is redacted', () => {
    const out = redactSecrets('cred=AKIAIOSFODNN7EXAMPLE here');
    assert.match(out, /\[REDACTED:AWS_KEY\]/);
    assert.doesNotMatch(out, /AKIAIOSFODNN7EXAMPLE/);
  });

  test('Bearer token is redacted', () => {
    const out = redactSecrets('Authorization: Bearer abc123XYZdef456==');
    assert.match(out, /Bearer \[REDACTED\]/);
    assert.doesNotMatch(out, /abc123XYZdef456/);
  });

  test('OpenAI key is redacted', () => {
    const out = redactSecrets('use sk-proj-abcdefghijklmnopqrstuvwxyz now');
    assert.match(out, /\[REDACTED:OPENAI_KEY\]/);
  });

  test('GitHub PAT is redacted', () => {
    const out = redactSecrets('token ghp_' + 'A'.repeat(36));
    assert.match(out, /\[REDACTED:GITHUB_PAT\]/);
  });

  test('Slack token is redacted', () => {
    const out = redactSecrets('hook xoxb-1234567890-abcdef');
    assert.match(out, /\[REDACTED:SLACK_TOKEN\]/);
  });

  test('Private key block is redacted', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----';
    const out = redactSecrets(`pre ${pem} post`);
    assert.match(out, /\[REDACTED:PRIVATE_KEY\]/);
    assert.doesNotMatch(out, /MIIabc/);
  });

  test('Plain text without secrets passes through unchanged', () => {
    const input = 'hello world this has no secrets';
    assert.strictEqual(redactSecrets(input), input);
  });
});

describe('redactSecrets — env_assignment pattern (Wave 4b T8)', () => {
  test('MY_API_KEY=value is redacted', () => {
    const out = redactSecrets('MY_API_KEY=abc123def456');
    assert.match(out, /MY_API_KEY=\s*\[REDACTED:ENV_SECRET\]/);
    assert.doesNotMatch(out, /abc123def456/);
  });

  test('USER_DB_PASSWORD=value is redacted', () => {
    const out = redactSecrets('USER_DB_PASSWORD=hunter2-supersecret');
    assert.match(out, /USER_DB_PASSWORD=\s*\[REDACTED:ENV_SECRET\]/);
    assert.doesNotMatch(out, /hunter2-supersecret/);
  });

  test('GITHUB_TOKEN=value is redacted', () => {
    const out = redactSecrets('GITHUB_TOKEN=tokenvalue123');
    assert.match(out, /GITHUB_TOKEN=\s*\[REDACTED:ENV_SECRET\]/);
    assert.doesNotMatch(out, /tokenvalue123/);
  });

  test('Multiple env assignments on separate lines are all redacted', () => {
    const input = [
      'MY_API_KEY=v1',
      'USER_DB_PASSWORD=v2',
      'GITHUB_TOKEN=v3',
    ].join('\n');
    const out = redactSecrets(input);
    assert.doesNotMatch(out, /=v1/);
    assert.doesNotMatch(out, /=v2/);
    assert.doesNotMatch(out, /=v3/);
    const matches = out.match(/\[REDACTED:ENV_SECRET\]/g) ?? [];
    assert.strictEqual(matches.length, 3);
  });

  test('plain SECRET=value, KEY=value, TOKEN=value are redacted', () => {
    const out = redactSecrets('SECRET=abc TOKEN=def KEY=ghi PWD=jkl');
    assert.match(out, /SECRET=\s*\[REDACTED:ENV_SECRET\]/);
    assert.match(out, /TOKEN=\s*\[REDACTED:ENV_SECRET\]/);
    assert.match(out, /KEY=\s*\[REDACTED:ENV_SECRET\]/);
    assert.match(out, /PWD=\s*\[REDACTED:ENV_SECRET\]/);
  });

  test('AWS_SECRET_ACCESS_KEY=value is redacted', () => {
    const out = redactSecrets('AWS_SECRET_ACCESS_KEY=opaqueblob');
    assert.match(out, /AWS_SECRET_ACCESS_KEY=\s*\[REDACTED:ENV_SECRET\]/);
    assert.doesNotMatch(out, /opaqueblob/);
  });

  test('non-secret env identifier (PATH, HOME) is NOT redacted', () => {
    const input = 'PATH=/usr/bin HOME=/root';
    const out = redactSecrets(input);
    assert.strictEqual(out, input);
  });

  test('keyword embedded mid-word without underscore boundary is NOT redacted', () => {
    // MONKEY contains "KEY" but not as an _-delimited segment; should NOT match.
    // TOKENIZER contains "TOKEN" but with non-_ suffix; should NOT match.
    const input = 'MONKEY=banana TOKENIZER=fast';
    const out = redactSecrets(input);
    assert.strictEqual(out, input);
  });

  test('env_assignment pattern is registered in REDACTION_PATTERNS', () => {
    const names = REDACTION_PATTERNS.map((p) => p.name);
    assert.ok(names.includes('env_assignment'), 'env_assignment must be a registered pattern');
  });
});

describe('redactSecrets — figma_pat pattern (Phase 7)', () => {
  test('figd_ PAT is redacted', () => {
    const out = redactSecrets('header X-Figma-Token: figd_abcdef0123456789_-ghijkl');
    assert.match(out, /\[REDACTED:FIGMA_PAT\]/);
    assert.doesNotMatch(out, /figd_abcdef0123456789_-ghijkl/);
  });

  test('multiple Figma PATs in one string are all redacted', () => {
    const out = redactSecrets('first=figd_AAAAAAAAAA second=figd_BBBBBBBBBB');
    assert.doesNotMatch(out, /figd_AAAAAAAAAA/);
    assert.doesNotMatch(out, /figd_BBBBBBBBBB/);
    const matches = out.match(/\[REDACTED:FIGMA_PAT\]/g) ?? [];
    assert.strictEqual(matches.length, 2);
  });

  test('figma_pat pattern is registered in REDACTION_PATTERNS', () => {
    const names = REDACTION_PATTERNS.map((p) => p.name);
    assert.ok(names.includes('figma_pat'), 'figma_pat must be a registered pattern');
  });
});
