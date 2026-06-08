/**
 * Phase 8 security follow-up (Codex fix re-review MEDIUM 1).
 *
 * The original `KEY\b` / `AUTH\b` matcher missed `_`-delimited credential
 * names because `_` is a regex word char, so `\b` never fired between `KEY`
 * and `_ID`. Real AWS / GCP / SSH / MySQL credential vars leaked into spawned
 * children. These tests pin the delimiter-aware behavior.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { isSecretEnvName, sanitizeChildEnv } from './env-sanitize.js';

test('isSecretEnvName catches _-delimited and glued credential names', () => {
  for (const name of [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'SSH_AUTH_SOCK',
    'MYSQL_PWD',
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
    'GITHUB_TOKEN',
    'PGPASSWORD',
    'DB_PASSWORD',
    'STRIPE_SECRET',
  ]) {
    assert.equal(isSecretEnvName(name), true, `${name} should be secret-shaped`);
  }
});

test('isSecretEnvName keeps benign standard env names', () => {
  for (const name of [
    'PATH',
    'HOME',
    'SHELL',
    'LANG',
    'TERM',
    'PWD',
    'USER',
    'TMPDIR',
    'XDG_CONFIG_HOME',
    'EDITOR',
  ]) {
    assert.equal(isSecretEnvName(name), false, `${name} should not be secret-shaped`);
  }
});

test('sanitizeChildEnv drops _-delimited secrets and RELAY_*, keeps the rest', () => {
  const out = sanitizeChildEnv({
    AWS_ACCESS_KEY_ID: 'AKIA000000000000000',
    GOOGLE_APPLICATION_CREDENTIALS: '/creds.json',
    SSH_AUTH_SOCK: '/tmp/sock',
    MYSQL_PWD: 'hunter2',
    RELAY_DB_PATH: '/db',
    PATH: '/usr/bin',
    HOME: '/home/x',
  });
  assert.equal(out['AWS_ACCESS_KEY_ID'], undefined);
  assert.equal(out['GOOGLE_APPLICATION_CREDENTIALS'], undefined);
  assert.equal(out['SSH_AUTH_SOCK'], undefined);
  assert.equal(out['MYSQL_PWD'], undefined);
  assert.equal(out['RELAY_DB_PATH'], undefined);
  assert.equal(out['PATH'], '/usr/bin');
  assert.equal(out['HOME'], '/home/x');
});
