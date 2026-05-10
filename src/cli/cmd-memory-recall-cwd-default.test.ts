process.env['RELAY_DB_PATH'] = ':memory:';

/**
 * T50 — `relay memory recall` and `relay memory show-context` should default
 * `--workdir` to the current working directory whenever
 * `RELAY_MEMORY_ALLOWED_WORKDIRS` is set in the environment AND the user did
 * not pass an explicit `--workdir`. Empty-string `--workdir` is treated as
 * "not provided" so a stray empty flag does not bypass the default.
 *
 * When the env var is unset, behavior is unchanged: omitting `--workdir` falls
 * through to a global recall (workdir undefined).
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { executeRecallCommand, executeMemoryShowContextCommand } from './cmd-memory-ops.js';
import { resolveMemoryWorkdir } from './resolve-memory-workdir.js';
import type { CliIO } from './commands.js';

const ALLOW_LIST_ENV = 'RELAY_MEMORY_ALLOWED_WORKDIRS';
const ALLOWED_WORKDIR = '/tmp/relay-t50-cwd-default';
const OTHER_WORKDIR = '/tmp/relay-t50-other-cwd';

interface CapturedIO {
  io: CliIO;
  stdout: string[];
  stderr: string[];
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

/** Find the last JSON-shaped line in captured stdout. */
function findJsonLine(stdout: string[]): string | undefined {
  return stdout
    .map((s) => s.trim())
    .reverse()
    .find((s) => s.startsWith('{') && s.endsWith('}'));
}

interface RecallResponse {
  memories: Array<{ memory_id: string }>;
  candidate_count: number;
}

describe('resolveMemoryWorkdir (T50 helper)', () => {
  test('explicit --workdir always wins, even when env unset', () => {
    const env = {} as NodeJS.ProcessEnv;
    const result = resolveMemoryWorkdir('/explicit/path', '/cwd/path', env);
    assert.strictEqual(result, '/explicit/path');
  });

  test('explicit --workdir always wins, even when env set', () => {
    const env = { [ALLOW_LIST_ENV]: '/allowed' } as NodeJS.ProcessEnv;
    const result = resolveMemoryWorkdir('/explicit/path', '/cwd/path', env);
    assert.strictEqual(result, '/explicit/path');
  });

  test('env set + no --workdir → returns cwd', () => {
    const env = { [ALLOW_LIST_ENV]: '/some/allowed/root' } as NodeJS.ProcessEnv;
    const result = resolveMemoryWorkdir(undefined, '/cwd/path', env);
    assert.strictEqual(result, '/cwd/path');
  });

  test('env unset + no --workdir → returns undefined (global recall)', () => {
    const env = {} as NodeJS.ProcessEnv;
    const result = resolveMemoryWorkdir(undefined, '/cwd/path', env);
    assert.strictEqual(result, undefined);
  });

  test('env set + empty-string --workdir → treated as not provided → returns cwd', () => {
    const env = { [ALLOW_LIST_ENV]: '/allowed' } as NodeJS.ProcessEnv;
    const result = resolveMemoryWorkdir('', '/cwd/path', env);
    assert.strictEqual(result, '/cwd/path');
  });

  test('env unset + empty-string --workdir → treated as not provided → returns undefined', () => {
    const env = {} as NodeJS.ProcessEnv;
    const result = resolveMemoryWorkdir('', '/cwd/path', env);
    assert.strictEqual(result, undefined);
  });

  test('env set to empty string → treated as unset (no defaulting)', () => {
    const env = { [ALLOW_LIST_ENV]: '' } as NodeJS.ProcessEnv;
    const result = resolveMemoryWorkdir(undefined, '/cwd/path', env);
    assert.strictEqual(result, undefined);
  });
});

describe('executeRecallCommand under T50 cwd-default semantics', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ALLOW_LIST_ENV];
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ALLOW_LIST_ENV];
    else process.env[ALLOW_LIST_ENV] = savedEnv;
  });

  test('env set, no --workdir → dispatch defaults to cwd → recall succeeds', async () => {
    // Simulate the exact value the cli.ts dispatcher would compute:
    //   resolveMemoryWorkdir(undefined, io.cwd) === io.cwd when env is set.
    // Then exercise executeRecallCommand with that resolved workdir.
    process.env[ALLOW_LIST_ENV] = ALLOWED_WORKDIR;
    const cap = makeIO(ALLOWED_WORKDIR);
    const resolved = resolveMemoryWorkdir(undefined, cap.io.cwd);
    assert.strictEqual(
      resolved,
      ALLOWED_WORKDIR,
      'helper should default to cwd when env is set',
    );

    const code = await executeRecallCommand({
      query: 'anything',
      tags: [],
      types: undefined,
      tokenBudget: 800,
      workdir: resolved,
      includeExpired: false,
      createdAfter: undefined,
      createdBefore: undefined,
      file: undefined,
      json: true,
      minTrust: undefined,
    }, cap.io);

    assert.strictEqual(code, 0, `recall should succeed; stderr=${cap.stderr.join('')}`);
    const jsonLine = findJsonLine(cap.stdout);
    assert.ok(jsonLine, 'expected JSON output');
    const parsed = JSON.parse(jsonLine!) as RecallResponse;
    assert.ok(Array.isArray(parsed.memories), 'memories should be an array');
    assert.strictEqual(typeof parsed.candidate_count, 'number');
  });

  test('env unset, no --workdir → no defaulting → recall succeeds (returns global)', async () => {
    delete process.env[ALLOW_LIST_ENV];
    const cap = makeIO(ALLOWED_WORKDIR);
    const resolved = resolveMemoryWorkdir(undefined, cap.io.cwd);
    assert.strictEqual(
      resolved,
      undefined,
      'helper should return undefined when env is unset (global recall)',
    );

    const code = await executeRecallCommand({
      query: 'anything',
      tags: [],
      types: undefined,
      tokenBudget: 800,
      workdir: resolved,
      includeExpired: false,
      createdAfter: undefined,
      createdBefore: undefined,
      file: undefined,
      json: true,
      minTrust: undefined,
    }, cap.io);

    assert.strictEqual(code, 0, `recall should succeed; stderr=${cap.stderr.join('')}`);
    const jsonLine = findJsonLine(cap.stdout);
    assert.ok(jsonLine, 'expected JSON output');
    const parsed = JSON.parse(jsonLine!) as RecallResponse;
    assert.ok(Array.isArray(parsed.memories), 'memories should be an array');
  });

  test('--workdir provided always wins (env set, explicit different from cwd)', async () => {
    // When the user passes --workdir, that value is forwarded verbatim. The
    // env-driven cwd-default never overrides an explicit user choice.
    process.env[ALLOW_LIST_ENV] = `${ALLOWED_WORKDIR}:${OTHER_WORKDIR}`;
    const cap = makeIO(ALLOWED_WORKDIR); // cwd is in allow-list

    const explicit = OTHER_WORKDIR;
    const resolved = resolveMemoryWorkdir(explicit, cap.io.cwd);
    assert.strictEqual(
      resolved,
      OTHER_WORKDIR,
      'explicit --workdir must win over cwd-default',
    );
    assert.notStrictEqual(resolved, cap.io.cwd, 'helper must NOT silently swap to cwd');

    const code = await executeRecallCommand({
      query: 'anything',
      tags: [],
      types: undefined,
      tokenBudget: 800,
      workdir: resolved,
      includeExpired: false,
      createdAfter: undefined,
      createdBefore: undefined,
      file: undefined,
      json: true,
      minTrust: undefined,
    }, cap.io);

    assert.strictEqual(code, 0, `recall should succeed; stderr=${cap.stderr.join('')}`);
  });

  test('--workdir provided always wins (env unset)', async () => {
    delete process.env[ALLOW_LIST_ENV];
    const cap = makeIO('/some/random/cwd');
    const explicit = '/some/explicit/workdir';
    const resolved = resolveMemoryWorkdir(explicit, cap.io.cwd);
    assert.strictEqual(resolved, explicit);
  });
});

describe('executeMemoryShowContextCommand under T50 cwd-default semantics', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ALLOW_LIST_ENV];
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ALLOW_LIST_ENV];
    else process.env[ALLOW_LIST_ENV] = savedEnv;
  });

  test('env set, no --workdir → defaults to cwd → show-context succeeds', async () => {
    process.env[ALLOW_LIST_ENV] = ALLOWED_WORKDIR;
    const cap = makeIO(ALLOWED_WORKDIR);
    const resolved = resolveMemoryWorkdir(undefined, cap.io.cwd);
    assert.strictEqual(resolved, ALLOWED_WORKDIR);

    const code = await executeMemoryShowContextCommand({
      query: 'anything',
      types: ['lesson', 'decision'],
      tokenBudget: 800,
      workdir: resolved,
      json: true,
    }, cap.io);

    assert.strictEqual(code, 0, `show-context should succeed; stderr=${cap.stderr.join('')}`);
    const jsonLine = findJsonLine(cap.stdout);
    assert.ok(jsonLine, 'expected JSON output');
    const parsed = JSON.parse(jsonLine!) as { workdir: string | null };
    assert.strictEqual(parsed.workdir, ALLOWED_WORKDIR);
  });

  test('env unset, no --workdir → no defaulting → show-context falls back to io.cwd internally', async () => {
    // executeMemoryShowContextCommand always falls back to io.cwd when
    // command.workdir is undefined (existing behavior, see cmd-memory-ops.ts).
    // T50 still leaves command.workdir === undefined at the dispatch layer
    // when the env is unset; the show-context handler then uses io.cwd.
    delete process.env[ALLOW_LIST_ENV];
    const cap = makeIO('/tmp/relay-t50-show-context-fallback');
    const resolved = resolveMemoryWorkdir(undefined, cap.io.cwd);
    assert.strictEqual(resolved, undefined);

    const code = await executeMemoryShowContextCommand({
      query: 'anything',
      types: ['lesson', 'decision'],
      tokenBudget: 800,
      workdir: resolved,
      json: true,
    }, cap.io);

    assert.strictEqual(code, 0, `show-context should succeed; stderr=${cap.stderr.join('')}`);
    const jsonLine = findJsonLine(cap.stdout);
    assert.ok(jsonLine, 'expected JSON output');
    const parsed = JSON.parse(jsonLine!) as { workdir: string };
    // Handler internally defaults to io.cwd when command.workdir is undefined.
    assert.strictEqual(parsed.workdir, cap.io.cwd);
  });
});
