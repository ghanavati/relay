import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildCodexInvocation,
  type TempFileWriter,
  type TempPathBuilder,
} from './codex.js';
import type { WorkerTask } from './types.js';

type CodexTaskFields = Pick<
  WorkerTask,
  | 'workdir'
  | 'model'
  | 'reasoning_effort'
  | 'task'
  | 'mcps'
  | 'codex_approval_policy'
  | 'run_id'
  | 'contextPrefix'
>;

function baseTask(overrides: Partial<CodexTaskFields> = {}): CodexTaskFields {
  return {
    workdir: '/tmp/work',
    task: 'do something',
    run_id: 'test-run-1',
    ...overrides,
  };
}

interface WriteCall {
  path: string;
  content: string;
}

function makeWriter(): { writer: TempFileWriter; calls: WriteCall[] } {
  const calls: WriteCall[] = [];
  const writer: TempFileWriter = (path, content) => {
    calls.push({ path, content });
  };
  return { writer, calls };
}

function fixedPathBuilder(path: string): TempPathBuilder {
  return () => path;
}

describe('buildCodexInvocation - contextPrefix injection', () => {
  test('omits model_instructions_file when contextPrefix is undefined', () => {
    const { writer, calls } = makeWriter();
    const result = buildCodexInvocation(
      baseTask(),
      {},
      undefined,
      writer,
      fixedPathBuilder('/tmp/should-not-be-used.md')
    );

    assert.equal(calls.length, 0, 'writer should not be called');
    assert.equal(result.tempFiles.length, 0, 'no tempfiles should be tracked');
    assert.ok(
      !result.args.some((a) => a.startsWith('model_instructions_file=')),
      'no -c model_instructions_file flag should appear'
    );
  });

  test('omits model_instructions_file when contextPrefix is empty string', () => {
    const { writer, calls } = makeWriter();
    const result = buildCodexInvocation(
      baseTask({ contextPrefix: '' }),
      {},
      undefined,
      writer,
      fixedPathBuilder('/tmp/should-not-be-used.md')
    );

    assert.equal(calls.length, 0, 'writer should not be called for empty contextPrefix');
    assert.equal(result.tempFiles.length, 0);
    assert.ok(
      !result.args.some((a) => a.startsWith('model_instructions_file=')),
      'no -c model_instructions_file flag should appear for empty contextPrefix'
    );
  });

  test('writes contextPrefix to tempfile and adds -c model_instructions_file flag when set', () => {
    const { writer, calls } = makeWriter();
    const tempPath = '/tmp/relay-codex-instructions-test-run-1-1234-0.md';
    const prefix = '## Recalled lessons\n- always validate input\n- never mutate';

    const result = buildCodexInvocation(
      baseTask({ contextPrefix: prefix }),
      {},
      undefined,
      writer,
      fixedPathBuilder(tempPath)
    );

    assert.equal(calls.length, 1, 'writer should be called once');
    assert.equal(calls[0]?.path, tempPath);
    assert.equal(calls[0]?.content, prefix, 'tempfile contents should equal contextPrefix');

    assert.deepEqual(result.tempFiles, [tempPath], 'tempfile should be tracked for cleanup');

    const cIdx = result.args.indexOf('-c');
    assert.notEqual(cIdx, -1, '-c flag should be present');
    // Find the -c model_instructions_file= entry specifically (others may exist)
    const miFlag = result.args.find((a) => a.startsWith('model_instructions_file='));
    assert.ok(miFlag, 'model_instructions_file= argument should be present');
    // TOML quoting: value must be wrapped in double quotes
    assert.equal(
      miFlag,
      `model_instructions_file="${tempPath}"`,
      'value must be TOML-quoted with double quotes'
    );
  });

  test('TOML-quotes paths containing spaces and special characters', () => {
    const { writer } = makeWriter();
    const trickyPath = '/tmp/path with spaces/quote"and\\backslash.md';

    const result = buildCodexInvocation(
      baseTask({ contextPrefix: 'some context' }),
      {},
      undefined,
      writer,
      fixedPathBuilder(trickyPath)
    );

    const miFlag = result.args.find((a) => a.startsWith('model_instructions_file='));
    assert.ok(miFlag, 'model_instructions_file flag should be present');
    // JSON.stringify (toTomlString) escapes \" → \\\" and \\ → \\\\
    // Expected: model_instructions_file="/tmp/path with spaces/quote\"and\\backslash.md"
    const expected = `model_instructions_file=${JSON.stringify(trickyPath)}`;
    assert.equal(miFlag, expected, 'TOML quoting must escape special characters via JSON.stringify');
  });

  test('-c model_instructions_file flag is paired correctly (preceded by -c, in globalArgs)', () => {
    const { writer } = makeWriter();
    const tempPath = '/tmp/instructions.md';

    const result = buildCodexInvocation(
      baseTask({ contextPrefix: 'context' }),
      {},
      undefined,
      writer,
      fixedPathBuilder(tempPath)
    );

    // Find the model_instructions_file value's index, then check the prior token is '-c'
    const valIdx = result.args.findIndex((a) => a.startsWith('model_instructions_file='));
    assert.ok(valIdx > 0, 'model_instructions_file value should not be first arg');
    assert.equal(result.args[valIdx - 1], '-c', '-c must immediately precede the value');

    // Should appear in globalArgs section (before "exec")
    const execIdx = result.args.indexOf('exec');
    assert.ok(execIdx !== -1, 'exec subcommand must be present');
    assert.ok(valIdx < execIdx, 'model_instructions_file must appear in global args (before exec)');
  });

  test('preserves bare task as prompt argument when contextPrefix is set', () => {
    const { writer } = makeWriter();
    const result = buildCodexInvocation(
      baseTask({ contextPrefix: 'context layer content', task: 'fix bug X' }),
      {},
      undefined,
      writer,
      fixedPathBuilder('/tmp/x.md')
    );

    // Find the -- separator and verify the prompt that follows is the bare task
    const sepIdx = result.args.indexOf('--');
    assert.ok(sepIdx !== -1, '-- separator must be present');
    assert.equal(result.args[sepIdx + 1], 'fix bug X', 'prompt must be bare task, not contextPrefix + task');
  });

  test('default writer/pathBuilder are used when not provided (smoke check via signature)', () => {
    // When contextPrefix is absent, defaults should never be invoked — so this should not throw.
    const result = buildCodexInvocation(baseTask());
    assert.equal(result.tempFiles.length, 0);
    assert.ok(
      !result.args.some((a) => a.startsWith('model_instructions_file=')),
      'no model_instructions_file flag without contextPrefix'
    );
  });
});
