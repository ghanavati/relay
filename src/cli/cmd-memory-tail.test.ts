import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeMemoryTailCommand,
  parseDuration,
  parseLogLines,
  filterEntries,
} from './cmd-memory-tail.js';
import type { CliIO } from './commands.js';

interface CapturedIO {
  io: CliIO;
  stdout: string[];
  stderr: string[];
}

function makeIO(): CapturedIO {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { cwd: '/tmp', stdout: (m) => stdout.push(m), stderr: (m) => stderr.push(m) },
    stdout,
    stderr,
  };
}

const FIXTURE_NOW = 1_735_000_000_000;

function fixtureNdjson(): string {
  // 5 lines, varying ts (relative to FIXTURE_NOW), events, ok flags
  const lines = [
    { ts: FIXTURE_NOW - 90 * 60 * 1000, event: 'hook.fire', cwd: '/a', ok: true, meta: { hook: 'SessionStart' } },
    { ts: FIXTURE_NOW - 50 * 60 * 1000, event: 'recall', cwd: '/a', ok: true },
    { ts: FIXTURE_NOW - 20 * 60 * 1000, event: 'remember', cwd: '/b', ok: true, meta: { type: 'lesson' } },
    { ts: FIXTURE_NOW - 5 * 60 * 1000, event: 'extract.fire', cwd: '/a', ok: false },
    { ts: FIXTURE_NOW - 30 * 1000, event: 'extract.write', cwd: '/a', ok: true, meta: { lessons: 2 } },
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

describe('parseDuration', () => {
  test('parses ms', () => assert.strictEqual(parseDuration('500ms'), 500));
  test('parses seconds', () => assert.strictEqual(parseDuration('45s'), 45_000));
  test('parses minutes', () => assert.strictEqual(parseDuration('30m'), 30 * 60 * 1000));
  test('parses hours', () => assert.strictEqual(parseDuration('2h'), 2 * 3_600_000));
  test('parses days', () => assert.strictEqual(parseDuration('7d'), 7 * 86_400_000));
  test('accepts decimals', () => assert.strictEqual(parseDuration('1.5h'), Math.round(1.5 * 3_600_000)));
  test('case-insensitive unit', () => assert.strictEqual(parseDuration('30M'), 30 * 60 * 1000));
  test('rejects empty', () => assert.throws(() => parseDuration('')));
  test('rejects no unit', () => assert.throws(() => parseDuration('30')));
  test('rejects bad unit', () => assert.throws(() => parseDuration('30x')));
  test('rejects negative', () => assert.throws(() => parseDuration('-5m')));
});

describe('parseLogLines', () => {
  test('parses well-formed ndjson', () => {
    const text = fixtureNdjson();
    const entries = parseLogLines(text);
    assert.strictEqual(entries.length, 5);
    assert.strictEqual(entries[0]!.event, 'hook.fire');
    assert.strictEqual(entries[4]!.event, 'extract.write');
  });

  test('skips blank lines', () => {
    const text = '\n\n{"ts":1,"event":"a"}\n\n{"ts":2,"event":"b"}\n\n';
    const entries = parseLogLines(text);
    assert.strictEqual(entries.length, 2);
  });

  test('skips malformed lines but keeps valid neighbors', () => {
    const text = [
      '{"ts":1,"event":"a"}',
      'not-json-garbage',
      '{partial:',
      '{"ts":3,"event":"c"}',
    ].join('\n');
    const entries = parseLogLines(text);
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0]!.event, 'a');
    assert.strictEqual(entries[1]!.event, 'c');
  });

  test('skips json without ts/event fields', () => {
    const text = '{"foo":"bar"}\n{"ts":1,"event":"a"}\n';
    const entries = parseLogLines(text);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0]!.event, 'a');
  });
});

describe('filterEntries', () => {
  const entries = parseLogLines(fixtureNdjson());

  test('no filter, no since → all entries', () => {
    const out = filterEntries(entries, { filters: [] });
    assert.strictEqual(out.length, 5);
  });

  test('single filter substring matches event', () => {
    const out = filterEntries(entries, { filters: ['extract'] });
    assert.strictEqual(out.length, 2);
    assert.ok(out.every((e) => e.event.includes('extract')));
  });

  test('multiple filters → OR semantics', () => {
    const out = filterEntries(entries, { filters: ['recall', 'remember'] });
    assert.strictEqual(out.length, 2);
    const events = new Set(out.map((e) => e.event));
    assert.ok(events.has('recall'));
    assert.ok(events.has('remember'));
  });

  test('--since drops older entries', () => {
    // Keep only entries from the last 30m → 3 entries: the 20m, 5m, and 30s ones
    const sinceMs = FIXTURE_NOW - 30 * 60 * 1000;
    const out = filterEntries(entries, { filters: [], sinceMs });
    assert.strictEqual(out.length, 3);
    assert.ok(out.every((e) => e.ts >= sinceMs));
  });

  test('combined filter + since', () => {
    const sinceMs = FIXTURE_NOW - 30 * 60 * 1000;
    const out = filterEntries(entries, { filters: ['extract'], sinceMs });
    assert.strictEqual(out.length, 2);
    assert.ok(out.every((e) => e.event.includes('extract') && e.ts >= sinceMs));
  });
});

describe('executeMemoryTailCommand', () => {
  let tmp: string;
  let logPath: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-tail-'));
    logPath = join(tmp, 'relay.ndjson');
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test('missing log file → "no activity logged yet" on stderr, exit 0', async () => {
    const cap = makeIO();
    const code = await executeMemoryTailCommand(
      { filters: [], json: false, logPath },
      cap.io
    );
    assert.strictEqual(code, 0);
    assert.match(cap.stderr.join(''), /no activity logged yet/);
    assert.strictEqual(cap.stdout.join(''), '');
  });

  test('no filter → human table with all entries', async () => {
    await writeFile(logPath, fixtureNdjson(), 'utf-8');
    const cap = makeIO();
    const code = await executeMemoryTailCommand(
      { filters: [], json: false, logPath },
      cap.io
    );
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');
    // Each line includes ISO timestamp brackets
    assert.match(out, /\[\d{4}-\d{2}-\d{2}T/);
    assert.match(out, /hook\.fire/);
    assert.match(out, /recall/);
    assert.match(out, /remember/);
    assert.match(out, /extract\.fire/);
    assert.match(out, /extract\.write/);
    // ok=... shown
    assert.match(out, /ok=/);
  });

  test('--filter narrows by event substring', async () => {
    await writeFile(logPath, fixtureNdjson(), 'utf-8');
    const cap = makeIO();
    const code = await executeMemoryTailCommand(
      { filters: ['extract'], json: false, logPath },
      cap.io
    );
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');
    assert.match(out, /extract\.fire/);
    assert.match(out, /extract\.write/);
    assert.ok(!out.includes('hook.fire'));
    assert.ok(!out.includes('recall'));
    assert.ok(!out.includes('remember'));
  });

  test('multiple --filter flags → OR', async () => {
    await writeFile(logPath, fixtureNdjson(), 'utf-8');
    const cap = makeIO();
    const code = await executeMemoryTailCommand(
      { filters: ['hook.fire', 'remember'], json: false, logPath },
      cap.io
    );
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');
    assert.match(out, /hook\.fire/);
    assert.match(out, /remember/);
    assert.ok(!out.includes('recall'));
    assert.ok(!out.includes('extract'));
  });

  test('--since filters by recency relative to now', async () => {
    // Use an ndjson where ts values are anchored relative to actual now()
    // so the time-window math works regardless of when the test runs.
    const now = Date.now();
    const lines = [
      JSON.stringify({ ts: now - 2 * 3_600_000, event: 'old', cwd: '/x', ok: true }),
      JSON.stringify({ ts: now - 10 * 60 * 1000, event: 'recent', cwd: '/x', ok: true }),
      JSON.stringify({ ts: now - 30 * 1000, event: 'fresh', cwd: '/x', ok: true }),
    ].join('\n') + '\n';
    await writeFile(logPath, lines, 'utf-8');
    const cap = makeIO();
    const code = await executeMemoryTailCommand(
      { filters: [], since: '30m', json: false, logPath },
      cap.io
    );
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');
    assert.match(out, /recent/);
    assert.match(out, /fresh/);
    assert.ok(!out.includes('old'));
  });

  test('invalid --since duration → exit 2 with explanatory stderr', async () => {
    await writeFile(logPath, fixtureNdjson(), 'utf-8');
    const cap = makeIO();
    const code = await executeMemoryTailCommand(
      { filters: [], since: 'banana', json: false, logPath },
      cap.io
    );
    assert.strictEqual(code, 2);
    assert.match(cap.stderr.join(''), /invalid --since duration/);
  });

  test('--json mode emits ndjson lines, no ANSI', async () => {
    await writeFile(logPath, fixtureNdjson(), 'utf-8');
    const cap = makeIO();
    const code = await executeMemoryTailCommand(
      { filters: [], json: true, logPath },
      cap.io
    );
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');
    // No ANSI escape codes in JSON mode
    // eslint-disable-next-line no-control-regex
    assert.ok(!/\x1b\[/.test(out), 'JSON output must be plain (no ANSI)');
    // 5 newline-terminated JSON objects
    const lines = out.trim().split('\n');
    assert.strictEqual(lines.length, 5);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { ts: number; event: string };
      assert.ok(typeof parsed.ts === 'number');
      assert.ok(typeof parsed.event === 'string');
    }
  });

  test('--json + --filter combined', async () => {
    await writeFile(logPath, fixtureNdjson(), 'utf-8');
    const cap = makeIO();
    const code = await executeMemoryTailCommand(
      { filters: ['recall'], json: true, logPath },
      cap.io
    );
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');
    const lines = out.trim().split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 1);
    const parsed = JSON.parse(lines[0]!) as { event: string };
    assert.strictEqual(parsed.event, 'recall');
  });

  test('empty log file → "no matching log entries"', async () => {
    await writeFile(logPath, '', 'utf-8');
    const cap = makeIO();
    const code = await executeMemoryTailCommand(
      { filters: [], json: false, logPath },
      cap.io
    );
    assert.strictEqual(code, 0);
    assert.match(cap.stdout.join(''), /no matching log entries/);
  });

  test('filter that matches nothing → "no matching log entries"', async () => {
    await writeFile(logPath, fixtureNdjson(), 'utf-8');
    const cap = makeIO();
    const code = await executeMemoryTailCommand(
      { filters: ['no-such-event'], json: false, logPath },
      cap.io
    );
    assert.strictEqual(code, 0);
    assert.match(cap.stdout.join(''), /no matching log entries/);
  });
});
