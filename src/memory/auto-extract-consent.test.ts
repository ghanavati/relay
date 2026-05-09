process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConsent, consentFilePath, ConsentFile } from './auto-extract-consent.js';

describe('T13: loadConsent — per-workdir consent file', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-consent-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test('missing file -> ok=false reason=no-file (default opt-OUT)', async () => {
    const result = await loadConsent(tmp);
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.strictEqual(result.reason, 'no-file');
  });

  test('malformed JSON -> ok=false reason=parse-error', async () => {
    const path = consentFilePath(tmp);
    await mkdir(join(tmp, '.relay'), { recursive: true });
    await writeFile(path, '{not valid json', 'utf8');
    const result = await loadConsent(tmp);
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.strictEqual(result.reason, 'parse-error');
      assert.match(result.detail ?? '', /invalid JSON/);
    }
  });

  test('valid JSON missing required fields -> ok=false reason=schema-error', async () => {
    const path = consentFilePath(tmp);
    await mkdir(join(tmp, '.relay'), { recursive: true });
    // Missing `enabled`
    await writeFile(path, JSON.stringify({ allow_remote: true }), 'utf8');
    const result = await loadConsent(tmp);
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.strictEqual(result.reason, 'schema-error');
      assert.match(result.detail ?? '', /enabled/);
    }
  });

  test('schema-error on wrong type for enabled', async () => {
    const path = consentFilePath(tmp);
    await mkdir(join(tmp, '.relay'), { recursive: true });
    await writeFile(path, JSON.stringify({ enabled: 'yes' }), 'utf8');
    const result = await loadConsent(tmp);
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.strictEqual(result.reason, 'schema-error');
  });

  test('schema-error when max_bytes is non-positive', async () => {
    const path = consentFilePath(tmp);
    await mkdir(join(tmp, '.relay'), { recursive: true });
    await writeFile(path, JSON.stringify({ enabled: true, max_bytes: 0 }), 'utf8');
    const result = await loadConsent(tmp);
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.strictEqual(result.reason, 'schema-error');
  });

  test('schema-error when min_confidence outside [0,1]', async () => {
    const path = consentFilePath(tmp);
    await mkdir(join(tmp, '.relay'), { recursive: true });
    await writeFile(path, JSON.stringify({ enabled: true, min_confidence: 1.5 }), 'utf8');
    const result = await loadConsent(tmp);
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.strictEqual(result.reason, 'schema-error');
  });

  test('invalid regex in extra_redaction_patterns -> ok=false reason=invalid-regex', async () => {
    const path = consentFilePath(tmp);
    await mkdir(join(tmp, '.relay'), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        enabled: true,
        extra_redaction_patterns: [
          { name: 'broken', pattern: '[unclosed', replacement: '[X]' },
        ],
      }),
      'utf8',
    );
    const result = await loadConsent(tmp);
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.strictEqual(result.reason, 'invalid-regex');
      assert.match(result.detail ?? '', /broken/);
    }
  });

  test('first invalid regex stops validation; later patterns are not reached', async () => {
    const path = consentFilePath(tmp);
    await mkdir(join(tmp, '.relay'), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        enabled: true,
        extra_redaction_patterns: [
          { name: 'first-bad', pattern: '(', replacement: '[X]' },
          { name: 'second-bad', pattern: '[also-broken', replacement: '[Y]' },
        ],
      }),
      'utf8',
    );
    const result = await loadConsent(tmp);
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.strictEqual(result.reason, 'invalid-regex');
      assert.match(result.detail ?? '', /first-bad/);
    }
  });

  test('valid minimal config -> ok=true with defaults applied', async () => {
    const path = consentFilePath(tmp);
    await mkdir(join(tmp, '.relay'), { recursive: true });
    await writeFile(path, JSON.stringify({ enabled: true }), 'utf8');
    const result = await loadConsent(tmp);
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual(result.consent.enabled, true);
      assert.strictEqual(result.consent.allow_remote, false);
      assert.strictEqual(result.consent.max_bytes, 32_768);
      assert.strictEqual(result.consent.min_confidence, 0.6);
      assert.deepStrictEqual(result.consent.extra_redaction_patterns, []);
    }
  });

  test('valid config with custom values + valid regex passes', async () => {
    const path = consentFilePath(tmp);
    await mkdir(join(tmp, '.relay'), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        enabled: true,
        enabled_at: 1_700_000_000_000,
        allow_remote: true,
        max_bytes: 65_536,
        min_confidence: 0.85,
        extra_redaction_patterns: [
          { name: 'employee_id', pattern: 'EMP-[0-9]{6}', replacement: '[REDACTED:EMP]' },
        ],
      }),
      'utf8',
    );
    const result = await loadConsent(tmp);
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual(result.consent.enabled_at, 1_700_000_000_000);
      assert.strictEqual(result.consent.allow_remote, true);
      assert.strictEqual(result.consent.max_bytes, 65_536);
      assert.strictEqual(result.consent.min_confidence, 0.85);
      assert.strictEqual(result.consent.extra_redaction_patterns.length, 1);
      assert.strictEqual(result.consent.extra_redaction_patterns[0]!.name, 'employee_id');
    }
  });

  test('disabled=true with extras still parses (file presence != enable)', async () => {
    const path = consentFilePath(tmp);
    await mkdir(join(tmp, '.relay'), { recursive: true });
    await writeFile(path, JSON.stringify({ enabled: false }), 'utf8');
    const result = await loadConsent(tmp);
    // Parsing succeeds — caller is responsible for honoring `enabled` flag.
    assert.strictEqual(result.ok, true);
    if (result.ok) assert.strictEqual(result.consent.enabled, false);
  });

  test('consentFilePath returns <workdir>/.relay/auto-extract.json', () => {
    assert.strictEqual(
      consentFilePath('/some/workdir'),
      join('/some/workdir', '.relay', 'auto-extract.json'),
    );
  });

  test('Zod schema rejects pattern over 500 chars', () => {
    const tooLong = 'a'.repeat(501);
    const result = ConsentFile.safeParse({
      enabled: true,
      extra_redaction_patterns: [{ name: 'x', pattern: tooLong, replacement: '[R]' }],
    });
    assert.strictEqual(result.success, false);
  });

  test('Zod schema rejects name over 60 chars', () => {
    const tooLong = 'n'.repeat(61);
    const result = ConsentFile.safeParse({
      enabled: true,
      extra_redaction_patterns: [{ name: tooLong, pattern: '.', replacement: '[R]' }],
    });
    assert.strictEqual(result.success, false);
  });
});
