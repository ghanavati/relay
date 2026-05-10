process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { executeSetupCommand, type SetupExecutors } from './cmd-setup.js';
import type { CliIO } from './commands.js';

interface CapturedIO {
  io: CliIO;
  stdout: string[];
  stderr: string[];
}

function makeIO(cwd: string = '/tmp/setup-test'): CapturedIO {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { cwd, stdout: (m) => stdout.push(m), stderr: (m) => stderr.push(m) },
    stdout,
    stderr,
  };
}

interface RecordedCall {
  step: 'init' | 'hook' | 'auto-extract';
  args: unknown;
  cwd?: string;
}

/** Build a recorder + executor set. The recorder shares state across all 4 callers. */
function makeRecorder(overrides: { initExit?: number; hookExit?: number[]; autoExtractExit?: number } = {}): {
  calls: RecordedCall[];
  executors: SetupExecutors;
} {
  const calls: RecordedCall[] = [];
  let hookCallIndex = 0;
  const executors: SetupExecutors = {
    runInit: async (args) => {
      calls.push({ step: 'init', args });
      return overrides.initExit ?? 0;
    },
    runHookInstall: async (args, _io, cwd) => {
      calls.push({ step: 'hook', args, cwd });
      const hookExits = overrides.hookExit ?? [0, 0];
      const code = hookExits[hookCallIndex] ?? 0;
      hookCallIndex += 1;
      return code;
    },
    runAutoExtractEnable: async (args) => {
      calls.push({ step: 'auto-extract', args });
      return overrides.autoExtractExit ?? 0;
    },
  };
  return { calls, executors };
}

function findJsonLine(stdout: string[]): string | undefined {
  return stdout
    .map((s) => s.trim())
    .reverse()
    .find((s) => s.startsWith('{') && s.endsWith('}'));
}

describe('executeSetupCommand', () => {
  let cap: CapturedIO;

  beforeEach(() => {
    cap = makeIO('/tmp/setup-cwd');
  });

  test('returns 2 if --everything is not set', async () => {
    const { executors } = makeRecorder();
    const code = await executeSetupCommand(
      { everything: false, workdir: undefined, lmModel: undefined, yes: false, json: false },
      cap.io,
      executors
    );
    assert.strictEqual(code, 2);
    assert.match(cap.stderr.join(''), /requires --everything/);
  });

  test('--everything --yes runs all 4 steps in order, returns 0 on success', async () => {
    const { calls, executors } = makeRecorder();
    const code = await executeSetupCommand(
      { everything: true, workdir: undefined, lmModel: undefined, yes: true, json: false },
      cap.io,
      executors
    );
    assert.strictEqual(code, 0);
    assert.strictEqual(calls.length, 4);
    assert.strictEqual(calls[0]!.step, 'init');
    assert.strictEqual(calls[1]!.step, 'hook');
    assert.strictEqual(calls[2]!.step, 'hook');
    assert.strictEqual(calls[3]!.step, 'auto-extract');
  });

  test('init args carry auto:true when --yes is passed', async () => {
    const { calls, executors } = makeRecorder();
    await executeSetupCommand(
      { everything: true, workdir: undefined, lmModel: undefined, yes: true, json: false },
      cap.io,
      executors
    );
    const initArgs = calls[0]!.args as { auto: boolean; quick: boolean; json: boolean };
    assert.strictEqual(initArgs.auto, true);
    assert.strictEqual(initArgs.quick, false);
    assert.strictEqual(initArgs.json, false);
  });

  test('init args carry auto:true when --json is passed (json implies non-interactive)', async () => {
    const { calls, executors } = makeRecorder();
    await executeSetupCommand(
      { everything: true, workdir: undefined, lmModel: undefined, yes: false, json: true },
      cap.io,
      executors
    );
    const initArgs = calls[0]!.args as { auto: boolean; quick: boolean; json: boolean };
    assert.strictEqual(initArgs.auto, true);
    assert.strictEqual(initArgs.json, true);
  });

  test('hook step #1 sets global=true, sessionEnd=false (SessionStart)', async () => {
    const { calls, executors } = makeRecorder();
    await executeSetupCommand(
      { everything: true, workdir: undefined, lmModel: undefined, yes: true, json: false },
      cap.io,
      executors
    );
    const hook1 = calls[1]!.args as { install: boolean; global?: boolean; sessionEnd?: boolean };
    assert.strictEqual(hook1.install, true);
    assert.strictEqual(hook1.global, true);
    assert.strictEqual(hook1.sessionEnd, false);
  });

  test('hook step #2 sets global=true, sessionEnd=true (SessionEnd)', async () => {
    const { calls, executors } = makeRecorder();
    await executeSetupCommand(
      { everything: true, workdir: undefined, lmModel: undefined, yes: true, json: false },
      cap.io,
      executors
    );
    const hook2 = calls[2]!.args as { install: boolean; global?: boolean; sessionEnd?: boolean };
    assert.strictEqual(hook2.install, true);
    assert.strictEqual(hook2.global, true);
    assert.strictEqual(hook2.sessionEnd, true);
  });

  test('auto-extract uses --workdir flag when provided', async () => {
    const { calls, executors } = makeRecorder();
    await executeSetupCommand(
      { everything: true, workdir: '/some/explicit/path', lmModel: undefined, yes: true, json: false },
      cap.io,
      executors
    );
    const aeArgs = calls[3]!.args as { workdir: string };
    assert.strictEqual(aeArgs.workdir, '/some/explicit/path');
  });

  test('auto-extract defaults to io.cwd when --workdir omitted', async () => {
    const { calls, executors } = makeRecorder();
    await executeSetupCommand(
      { everything: true, workdir: undefined, lmModel: undefined, yes: true, json: false },
      cap.io,
      executors
    );
    const aeArgs = calls[3]!.args as { workdir: string };
    assert.strictEqual(aeArgs.workdir, '/tmp/setup-cwd');
  });

  test('init failure aborts: only init runs, returns 1', async () => {
    const { calls, executors } = makeRecorder({ initExit: 1 });
    const code = await executeSetupCommand(
      { everything: true, workdir: undefined, lmModel: undefined, yes: true, json: false },
      cap.io,
      executors
    );
    assert.strictEqual(code, 1);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]!.step, 'init');
    assert.match(cap.stderr.join(''), /aborted at step "relay init/);
  });

  test('first hook failure aborts: init+hook1 ran, returns 1', async () => {
    const { calls, executors } = makeRecorder({ hookExit: [1, 0] });
    const code = await executeSetupCommand(
      { everything: true, workdir: undefined, lmModel: undefined, yes: true, json: false },
      cap.io,
      executors
    );
    assert.strictEqual(code, 1);
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0]!.step, 'init');
    assert.strictEqual(calls[1]!.step, 'hook');
  });

  test('second hook failure aborts: init+hook1+hook2 ran, returns 1', async () => {
    const { calls, executors } = makeRecorder({ hookExit: [0, 1] });
    const code = await executeSetupCommand(
      { everything: true, workdir: undefined, lmModel: undefined, yes: true, json: false },
      cap.io,
      executors
    );
    assert.strictEqual(code, 1);
    assert.strictEqual(calls.length, 3);
    assert.strictEqual(calls[2]!.step, 'hook');
  });

  test('auto-extract failure: all 4 steps ran, returns 1', async () => {
    const { calls, executors } = makeRecorder({ autoExtractExit: 1 });
    const code = await executeSetupCommand(
      { everything: true, workdir: undefined, lmModel: undefined, yes: true, json: false },
      cap.io,
      executors
    );
    assert.strictEqual(code, 1);
    assert.strictEqual(calls.length, 4);
    assert.strictEqual(calls[3]!.step, 'auto-extract');
  });

  test('init thrown exception is caught and aborts setup', async () => {
    const executors: SetupExecutors = {
      runInit: async () => { throw new Error('boom'); },
      runHookInstall: async () => 0,
      runAutoExtractEnable: async () => 0,
    };
    const code = await executeSetupCommand(
      { everything: true, workdir: undefined, lmModel: undefined, yes: true, json: false },
      cap.io,
      executors
    );
    assert.strictEqual(code, 1);
    assert.match(cap.stderr.join(''), /boom/);
  });

  test('--json mode emits a single parseable summary object with steps', async () => {
    const { executors } = makeRecorder();
    const code = await executeSetupCommand(
      { everything: true, workdir: undefined, lmModel: undefined, yes: false, json: true },
      cap.io,
      executors
    );
    assert.strictEqual(code, 0);
    const jsonLine = findJsonLine(cap.stdout);
    assert.ok(jsonLine, 'expected a JSON line in stdout');
    const parsed = JSON.parse(jsonLine!) as {
      ok: boolean;
      steps: Array<{ step: string; ok: boolean; exit_code: number }>;
    };
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.steps.length, 4);
    for (const s of parsed.steps) {
      assert.strictEqual(s.ok, true);
      assert.strictEqual(s.exit_code, 0);
    }
  });

  test('--json mode on failure emits ok:false and only the steps that ran', async () => {
    const { executors } = makeRecorder({ hookExit: [1, 0] });
    const code = await executeSetupCommand(
      { everything: true, workdir: undefined, lmModel: undefined, yes: false, json: true },
      cap.io,
      executors
    );
    assert.strictEqual(code, 1);
    const jsonLine = findJsonLine(cap.stdout);
    assert.ok(jsonLine);
    const parsed = JSON.parse(jsonLine!) as {
      ok: boolean;
      steps: Array<{ step: string; ok: boolean; exit_code: number }>;
    };
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.steps.length, 2);
    assert.strictEqual(parsed.steps[0]!.ok, true);
    assert.strictEqual(parsed.steps[1]!.ok, false);
  });

  test('text mode prints "==> step" progress lines and a final ok line', async () => {
    const { executors } = makeRecorder();
    await executeSetupCommand(
      { everything: true, workdir: undefined, lmModel: undefined, yes: true, json: false },
      cap.io,
      executors
    );
    const out = cap.stdout.join('');
    assert.match(out, /==> relay init --auto/);
    assert.match(out, /==> relay memory hook --install --global\n/);
    assert.match(out, /==> relay memory hook --install --global --session-end/);
    assert.match(out, /==> relay memory auto-extract --enable --workdir/);
    assert.match(out, /\[ok\] relay setup --everything: 4 steps completed/);
  });
});
