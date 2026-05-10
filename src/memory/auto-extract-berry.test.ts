/**
 * T29 — Berry helper now spawns a shell command instead of hitting HTTP.
 *
 * Tests cover:
 *   - exit 0 → 'pass'
 *   - exit non-zero → 'flagged'
 *   - missing RELAY_BERRY_CMD → 'unavailable' with reason 'berry-not-configured'
 *   - empty lesson → 'unavailable' (short-circuit, no spawn)
 *   - spawn error → 'unavailable'
 *   - timeout → 'unavailable'
 *   - lesson content delivered to child stdin
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable, Readable } from 'node:stream';
import type { ChildProcess, spawn } from 'node:child_process';
import { checkLessonViaBerry } from './auto-extract-berry.js';

interface FakeChild extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill: (signal?: string) => boolean;
  killed: boolean;
  pid?: number;
}

interface MockSpawn {
  fn: typeof spawn;
  calls: Array<{ cmd: string; opts: unknown; stdinData: string }>;
  child: FakeChild;
  /** Trigger after the call so the test controls when the child exits. */
  exitWith: (code: number) => void;
  errorWith: (err: Error) => void;
}

function makeMockSpawn(): MockSpawn {
  const calls: MockSpawn['calls'] = [];
  let stdinChunks: Buffer[] = [];

  const child = new EventEmitter() as FakeChild;
  // stdin captures whatever the helper pipes in.
  child.stdin = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      stdinChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      cb();
    },
    final(cb) {
      cb();
    },
  });
  child.stdout = Readable.from([]);
  child.stderr = Readable.from([]);
  child.killed = false;
  child.kill = (_signal?: string) => {
    child.killed = true;
    return true;
  };

  const fn = ((cmd: string, opts: unknown): ChildProcess => {
    calls.push({
      cmd,
      opts,
      get stdinData() {
        return Buffer.concat(stdinChunks).toString('utf8');
      },
    } as unknown as MockSpawn['calls'][number]);
    // Reset stdin buffer for the *next* call (we leave the captured one alone).
    stdinChunks = [];
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;

  return {
    fn,
    calls,
    child,
    exitWith: (code: number) => {
      child.emit('close', code);
    },
    errorWith: (err: Error) => {
      child.emit('error', err);
    },
  };
}

describe('checkLessonViaBerry — shell-command (T29)', () => {
  let savedCmd: string | undefined;

  beforeEach(() => {
    savedCmd = process.env['RELAY_BERRY_CMD'];
    delete process.env['RELAY_BERRY_CMD'];
  });

  afterEach(() => {
    if (savedCmd === undefined) delete process.env['RELAY_BERRY_CMD'];
    else process.env['RELAY_BERRY_CMD'] = savedCmd;
  });

  test('returns "unavailable" with reason berry-not-configured when env var unset', async () => {
    const result = await checkLessonViaBerry({
      lessonContent: 'always run npm test',
      transcriptSpans: [{ source: 's', text: 't' }],
    });
    assert.strictEqual(result.ok, 'unavailable');
    const details = result.details as { reason: string };
    assert.strictEqual(details.reason, 'berry-not-configured');
  });

  test('returns "unavailable" reason berry-not-configured when env var is whitespace', async () => {
    const result = await checkLessonViaBerry({
      lessonContent: 'lesson',
      transcriptSpans: [{ source: 's', text: 't' }],
      cmd: '   ',
    });
    assert.strictEqual(result.ok, 'unavailable');
    assert.strictEqual((result.details as { reason: string }).reason, 'berry-not-configured');
  });

  test('returns "unavailable" for empty lesson content (short-circuits before spawn)', async () => {
    const mock = makeMockSpawn();
    const result = await checkLessonViaBerry({
      lessonContent: '   ',
      transcriptSpans: [{ source: 's', text: 't' }],
      cmd: 'true',
      spawnFn: mock.fn,
    });
    assert.strictEqual(result.ok, 'unavailable');
    assert.strictEqual(mock.calls.length, 0, 'must not spawn for empty lesson');
  });

  test('exit 0 → "pass" and lesson content piped on stdin', async () => {
    const mock = makeMockSpawn();
    const promise = checkLessonViaBerry({
      lessonContent: 'always run npm typecheck before commit',
      transcriptSpans: [{ source: 's', text: 't' }],
      cmd: 'fake-berry --check',
      spawnFn: mock.fn,
    });
    // Simulate the child closing cleanly on the next tick so the helper
    // wires its 'close' listener first.
    setImmediate(() => mock.exitWith(0));
    const result = await promise;
    assert.strictEqual(result.ok, 'pass');
    assert.strictEqual(mock.calls.length, 1);
    assert.strictEqual(mock.calls[0]!.cmd, 'fake-berry --check');
    // Confirm the captured stdin matches the lesson body.
    const stdinData = (mock.calls[0] as unknown as { stdinData: string }).stdinData;
    assert.strictEqual(stdinData, 'always run npm typecheck before commit');
  });

  test('non-zero exit → "flagged"', async () => {
    const mock = makeMockSpawn();
    const promise = checkLessonViaBerry({
      lessonContent: 'relay was authored by a bot in 1999',
      transcriptSpans: [{ source: 's', text: 't' }],
      cmd: 'fake-berry',
      spawnFn: mock.fn,
    });
    setImmediate(() => mock.exitWith(1));
    const result = await promise;
    assert.strictEqual(result.ok, 'flagged');
    assert.strictEqual((result.details as { code: number }).code, 1);
  });

  test('spawn error event → "unavailable" with error details', async () => {
    const mock = makeMockSpawn();
    const promise = checkLessonViaBerry({
      lessonContent: 'lesson',
      transcriptSpans: [{ source: 's', text: 't' }],
      cmd: 'no-such-binary',
      spawnFn: mock.fn,
    });
    setImmediate(() => mock.errorWith(new Error('ENOENT: no-such-binary')));
    const result = await promise;
    assert.strictEqual(result.ok, 'unavailable');
    assert.match((result.details as { error: string }).error, /ENOENT/);
  });

  test('timeout → "unavailable" reason=timeout and child is killed', async () => {
    const mock = makeMockSpawn();
    const promise = checkLessonViaBerry({
      lessonContent: 'lesson',
      transcriptSpans: [{ source: 's', text: 't' }],
      cmd: 'sleep 60',
      spawnFn: mock.fn,
      timeoutMs: 25,
    });
    // Never call exitWith — the timeout should kick in.
    const result = await promise;
    assert.strictEqual(result.ok, 'unavailable');
    assert.strictEqual((result.details as { reason: string }).reason, 'timeout');
    assert.strictEqual(mock.child.killed, true);
  });

  test('process.env RELAY_BERRY_CMD is honoured when no override is passed', async () => {
    process.env['RELAY_BERRY_CMD'] = 'env-set-cmd';
    const mock = makeMockSpawn();
    const promise = checkLessonViaBerry({
      lessonContent: 'lesson',
      transcriptSpans: [{ source: 's', text: 't' }],
      spawnFn: mock.fn,
    });
    setImmediate(() => mock.exitWith(0));
    const result = await promise;
    assert.strictEqual(result.ok, 'pass');
    assert.strictEqual(mock.calls[0]!.cmd, 'env-set-cmd');
  });
});
