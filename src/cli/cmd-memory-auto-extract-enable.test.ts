process.env['RELAY_DB_PATH'] = ':memory:';

import { describe, test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeMemoryAutoExtractEnableCommand } from './cmd-memory-auto-extract-enable.js';
import type { CliIO } from './commands.js';

interface CapturedIO {
  readonly io: CliIO;
  readonly stdout: string[];
  readonly stderr: string[];
}

function makeIO(cwd: string): CapturedIO {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { cwd, stdout: (m) => stdout.push(m), stderr: (m) => stderr.push(m) },
    stdout,
    stderr,
  };
}

describe('executeMemoryAutoExtractEnableCommand — extractor provider name', () => {
  let tmp: string;
  let savedFooUrl: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-auto-extract-enable-'));
    savedFooUrl = process.env['RELAY_PROVIDER_FOO_URL'];
    delete process.env['RELAY_PROVIDER_FOO_URL'];
  });

  afterEach(async () => {
    if (savedFooUrl === undefined) delete process.env['RELAY_PROVIDER_FOO_URL'];
    else process.env['RELAY_PROVIDER_FOO_URL'] = savedFooUrl;
    await rm(tmp, { recursive: true, force: true });
  });

  test('writes the requested builtin extractor provider name', async () => {
    const { io, stdout } = makeIO(tmp);
    const code = await executeMemoryAutoExtractEnableCommand(
      { allowRemote: false, workdir: tmp, json: true, extractor: 'claude' },
      io,
    );
    assert.strictEqual(code, 0);
    const raw = await readFile(join(tmp, '.relay', 'auto-extract.json'), 'utf8');
    const parsed = JSON.parse(raw) as { extractor?: string };
    assert.strictEqual(parsed.extractor, 'claude');
    assert.match(stdout.join(''), /claude/);
  });

  test('accepts env-declared provider names without a closed enum', async () => {
    process.env['RELAY_PROVIDER_FOO_URL'] = 'https://foo.example/v1';
    const { io } = makeIO(tmp);
    const code = await executeMemoryAutoExtractEnableCommand(
      { allowRemote: true, workdir: tmp, json: true, extractor: 'foo' },
      io,
    );
    assert.strictEqual(code, 0);
    const raw = await readFile(join(tmp, '.relay', 'auto-extract.json'), 'utf8');
    const parsed = JSON.parse(raw) as { extractor?: string };
    assert.strictEqual(parsed.extractor, 'foo');
  });

  test('unknown extractor fails fast with a registry error and does not write consent', async () => {
    const { io, stderr } = makeIO(tmp);
    const code = await executeMemoryAutoExtractEnableCommand(
      { allowRemote: false, workdir: tmp, json: false, extractor: 'missing-provider' },
      io,
    );
    assert.strictEqual(code, 2);
    assert.match(stderr.join(''), /unknown provider "missing-provider"/);
    await assert.rejects(
      readFile(join(tmp, '.relay', 'auto-extract.json'), 'utf8'),
      /ENOENT/,
    );
  });

  test('preserves an existing extractor when --extractor is omitted', async () => {
    await mkdir(join(tmp, '.relay'), { recursive: true });
    await writeFile(
      join(tmp, '.relay', 'auto-extract.json'),
      JSON.stringify({
        enabled: true,
        extractor: 'anthropic',
        allow_remote: true,
        max_bytes: 65_536,
        min_confidence: 0.7,
        extra_redaction_patterns: [],
      }),
      'utf8',
    );
    const { io } = makeIO(tmp);
    const code = await executeMemoryAutoExtractEnableCommand(
      { allowRemote: false, workdir: tmp, json: true },
      io,
    );
    assert.strictEqual(code, 0);
    const raw = await readFile(join(tmp, '.relay', 'auto-extract.json'), 'utf8');
    const parsed = JSON.parse(raw) as { extractor?: string };
    assert.strictEqual(parsed.extractor, 'anthropic');
  });
});
