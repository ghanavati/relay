/**
 * Tests for the centralized ndjson logger.
 *
 * Uses `RELAY_HOME` env to redirect log to a per-test tmpdir so we never
 * touch the developer's real ~/.relay directory. The implementation
 * resolves the path lazily on every call, so setting `RELAY_HOME` in
 * `beforeEach` is honored.
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLog, readLog, rotateIfNeeded, shouldRotate, MAX_BYTES, MAX_AGE_MS } from './relay-log.js';
import type { LogEvent } from './relay-log.js';

const LOG_FILE = 'relay.ndjson';

describe('relay-log', () => {
  let tmp: string;
  let savedRelayHome: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-log-'));
    savedRelayHome = process.env['RELAY_HOME'];
    process.env['RELAY_HOME'] = tmp;
  });

  afterEach(async () => {
    if (savedRelayHome === undefined) delete process.env['RELAY_HOME'];
    else process.env['RELAY_HOME'] = savedRelayHome;
    await rm(tmp, { recursive: true, force: true });
  });

  test('appendLog writes a stamped LogEntry as ndjson', async () => {
    await appendLog({ event: 'recall', ok: true, cwd: '/some/dir' });
    const raw = await readFile(join(tmp, LOG_FILE), 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'one entry written');
    const parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.event, 'recall');
    assert.equal(parsed.ok, true);
    assert.equal(parsed.cwd, '/some/dir');
    assert.equal(typeof parsed.ts, 'number');
    assert.ok(parsed.ts > 0, 'ts is set at write time');
  });

  test('appendLog appends multiple entries on separate lines', async () => {
    await appendLog({ event: 'hook.fire', ok: true });
    await appendLog({ event: 'hook.skip', ok: true, meta: { reason: 'paused' } });
    await appendLog({ event: 'recall.empty', ok: true });
    const raw = await readFile(join(tmp, LOG_FILE), 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    assert.equal(lines.length, 3);
    const events = lines.map((l) => JSON.parse(l).event);
    assert.deepEqual(events, ['hook.fire', 'hook.skip', 'recall.empty']);
  });

  test('readLog returns [] when file does not exist', async () => {
    const out = await readLog();
    assert.deepEqual(out, []);
  });

  test('readLog returns entries in insertion order with no opts', async () => {
    await appendLog({ event: 'remember', ok: true });
    await appendLog({ event: 'recall', ok: true });
    const out = await readLog();
    assert.equal(out.length, 2);
    assert.equal(out[0]!.event, 'remember');
    assert.equal(out[1]!.event, 'recall');
  });

  test('readLog filter narrows by event name', async () => {
    await appendLog({ event: 'hook.fire', ok: true });
    await appendLog({ event: 'recall', ok: true });
    await appendLog({ event: 'hook.skip', ok: true });
    await appendLog({ event: 'recall', ok: false });
    const out = await readLog({ filter: ['recall'] });
    assert.equal(out.length, 2);
    for (const entry of out) assert.equal(entry.event, 'recall');
  });

  test('readLog filter accepts multiple events', async () => {
    await appendLog({ event: 'hook.fire', ok: true });
    await appendLog({ event: 'hook.skip', ok: true });
    await appendLog({ event: 'recall', ok: true });
    const out = await readLog({ filter: ['hook.fire', 'hook.skip'] });
    assert.equal(out.length, 2);
    const names = out.map((e) => e.event).sort();
    assert.deepEqual(names, ['hook.fire', 'hook.skip']);
  });

  test('readLog since drops entries older than threshold', async () => {
    // Manually craft entries with controlled timestamps so we don't rely on
    // sleeps. Lines we write directly are read back by readLog().
    const oldTs = Date.now() - 60_000;
    const newTs = Date.now();
    const lines = [
      JSON.stringify({ ts: oldTs, event: 'hook.fire', ok: true } satisfies { ts: number; event: LogEvent; ok: boolean }),
      JSON.stringify({ ts: newTs, event: 'hook.skip', ok: true } satisfies { ts: number; event: LogEvent; ok: boolean }),
      '',
    ].join('\n');
    await writeFile(join(tmp, LOG_FILE), lines, 'utf-8');
    const out = await readLog({ since: newTs - 1 });
    assert.equal(out.length, 1);
    assert.equal(out[0]!.event, 'hook.skip');
  });

  test('readLog limit returns most-recent-first up to N', async () => {
    for (let i = 0; i < 5; i++) {
      await appendLog({ event: 'recall', ok: true, meta: { i } });
    }
    const out = await readLog({ limit: 2 });
    assert.equal(out.length, 2);
    // most recent first
    assert.equal((out[0]!.meta as { i: number }).i, 4);
    assert.equal((out[1]!.meta as { i: number }).i, 3);
  });

  test('readLog skips malformed lines silently', async () => {
    await appendLog({ event: 'recall', ok: true });
    // Append a garbage line directly between two good ones
    await writeFile(
      join(tmp, LOG_FILE),
      (await readFile(join(tmp, LOG_FILE), 'utf-8')) + 'this-is-not-json\n',
      'utf-8'
    );
    await appendLog({ event: 'remember', ok: true });
    const out = await readLog();
    assert.equal(out.length, 2, 'malformed line skipped');
    assert.deepEqual(out.map((e) => e.event), ['recall', 'remember']);
  });

  test('rotateIfNeeded returns rotated=false when log absent', async () => {
    const result = await rotateIfNeeded();
    assert.equal(result.rotated, false);
    assert.equal(result.archivePath, undefined);
  });

  test('rotateIfNeeded returns rotated=false for small recent log', async () => {
    await appendLog({ event: 'recall', ok: true });
    const result = await rotateIfNeeded();
    assert.equal(result.rotated, false);
  });

  test('rotateIfNeeded triggers when file exceeds 10 MB', async () => {
    const path = join(tmp, LOG_FILE);
    // Write 10 MB + 1 byte of dummy ndjson content
    const big = 'x'.repeat(10 * 1024 * 1024 + 1);
    await writeFile(path, big, 'utf-8');
    const result = await rotateIfNeeded();
    assert.equal(result.rotated, true, 'rotation triggered by size');
    assert.ok(result.archivePath, 'archive path returned');
    assert.ok(result.archivePath!.startsWith(path + '.'), 'archive next to original');
    // Original is gone (renamed)
    let originalGone = false;
    try { await stat(path); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') originalGone = true;
    }
    assert.ok(originalGone, 'original log was renamed away');
    // Subsequent appendLog re-creates the file fresh
    await appendLog({ event: 'recall', ok: true });
    const after = await readFile(path, 'utf-8');
    assert.equal(after.split('\n').filter(Boolean).length, 1);
  });

  // Age-based rotation can't be reliably exercised end-to-end because
  // `birthtimeMs` cannot be backdated via `utimes` on most platforms. The
  // pure decision function is tested directly instead — it's the same
  // logic used by `rotateIfNeeded`.
  test('shouldRotate returns true at exactly the size threshold', () => {
    assert.equal(shouldRotate({ size: MAX_BYTES, birthtimeMs: Date.now(), mtimeMs: Date.now() }), true);
  });

  test('shouldRotate returns false below the size threshold and within age', () => {
    const now = Date.now();
    assert.equal(shouldRotate({ size: 100, birthtimeMs: now, mtimeMs: now }, now), false);
  });

  test('shouldRotate returns true when birthtime is older than 30 days', () => {
    const now = Date.now();
    const old = now - MAX_AGE_MS - 1;
    assert.equal(shouldRotate({ size: 100, birthtimeMs: old, mtimeMs: now }, now), true);
  });

  test('shouldRotate falls back to mtime when birthtime is 0', () => {
    const now = Date.now();
    const old = now - MAX_AGE_MS - 1;
    assert.equal(shouldRotate({ size: 100, birthtimeMs: 0, mtimeMs: old }, now), true);
    // And the inverse: birthtime=0, mtime fresh → no rotation
    assert.equal(shouldRotate({ size: 100, birthtimeMs: 0, mtimeMs: now }, now), false);
  });
});
