/**
 * Smoke tests for `relay tui` — focused on the `--json` snapshot path.
 *
 * The interactive Ink renderer is intentionally not exercised here: spawning
 * a fake TTY in CI is brittle and the value of automated coverage there is
 * marginal versus the cost. We instead verify the data layer (gatherSnapshot)
 * and the `--json` exit path emit a well-formed Snapshot.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeTuiCommand, gatherSnapshot } from './cmd-tui.js';
import type { CliIO } from './commands.js';

interface CapturedIO {
  io: CliIO;
  stdout: string[];
  stderr: string[];
}

function makeIO(cwd = '/tmp'): CapturedIO {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { cwd, stdout: (m) => stdout.push(m), stderr: (m) => stderr.push(m) },
    stdout,
    stderr,
  };
}

describe('gatherSnapshot', () => {
  let tmp: string;
  let originalLogPath: string | undefined;
  let originalDbPath: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-tui-'));
    originalLogPath = process.env['RELAY_LOG_PATH'];
    originalDbPath = process.env['RELAY_DB_PATH'];
    // Pin the activity log to a known empty location so test runs do not
    // bleed in real `~/.relay/relay.ndjson` content from the dev box.
    process.env['RELAY_LOG_PATH'] = join(tmp, 'relay.ndjson');
    // Use in-memory DB so MemoryStore.count() always works without touching ~/.relay/.
    process.env['RELAY_DB_PATH'] = ':memory:';
  });

  afterEach(async () => {
    if (originalLogPath === undefined) delete process.env['RELAY_LOG_PATH'];
    else process.env['RELAY_LOG_PATH'] = originalLogPath;
    if (originalDbPath === undefined) delete process.env['RELAY_DB_PATH'];
    else process.env['RELAY_DB_PATH'] = originalDbPath;
    await rm(tmp, { recursive: true, force: true });
  });

  test('returns a Snapshot with all required fields', async () => {
    const snap = await gatherSnapshot({ cwd: tmp, version: '9.9.9' });
    assert.strictEqual(snap.version, '9.9.9');
    assert.ok(Number.isFinite(snap.generated_at));
    assert.ok(Array.isArray(snap.recent_activity));
    assert.ok(Array.isArray(snap.recall_preview));
    assert.strictEqual(snap.status.binary_version, '9.9.9');
    assert.ok(typeof snap.status.db_path === 'string');
    assert.ok(Number.isInteger(snap.status.db_entries));
    assert.ok(typeof snap.status.hook_installed === 'boolean');
    assert.ok(Array.isArray(snap.status.providers));
    // codex, lm-studio, openrouter, anthropic
    assert.strictEqual(snap.status.providers.length, 4);
    const names = snap.status.providers.map(p => p.name).sort();
    assert.deepStrictEqual(names, ['anthropic', 'codex', 'lm-studio', 'openrouter']);
  });

  test('returns empty recent_activity when log file is missing', async () => {
    const snap = await gatherSnapshot({ cwd: tmp, version: '0.0.1' });
    assert.deepStrictEqual(snap.recent_activity, []);
  });

  test('returns last 10 entries in reverse-chronological order when log exists', async () => {
    // 12 entries — we should keep the last 10, newest first.
    const lines: string[] = [];
    const baseTs = 1_700_000_000_000;
    for (let i = 0; i < 12; i++) {
      lines.push(JSON.stringify({ ts: baseTs + i * 1000, event: `e${i}`, ok: true }));
    }
    await writeFile(process.env['RELAY_LOG_PATH']!, lines.join('\n') + '\n', 'utf-8');
    const snap = await gatherSnapshot({ cwd: tmp, version: '0.0.1' });
    assert.strictEqual(snap.recent_activity.length, 10);
    // Newest first → e11 then e10 ... e2
    assert.strictEqual(snap.recent_activity[0]!.event, 'e11');
    assert.strictEqual(snap.recent_activity[9]!.event, 'e2');
  });

  test('does not throw when MemoryStore is unreachable', async () => {
    // Point at a file path inside a directory we never created → store
    // construction will throw internally; gatherSnapshot must swallow it.
    process.env['RELAY_DB_PATH'] = join(tmp, 'no-such-dir', 'no.db');
    const snap = await gatherSnapshot({ cwd: tmp, version: '0.0.1' });
    assert.ok(Array.isArray(snap.recall_preview));
    assert.strictEqual(snap.recall_preview.length, 0);
  });

  test('recall preview path imports semantic-similarities (PLAN-4 T6 wire-up)', async () => {
    // Smoke-test the wire-up: gatherSnapshot must not throw and must produce a
    // recall_preview when the semantic-similarities helper is invoked even with
    // empty candidates / no embedding model set. Short-circuit returns empty
    // Map, engine falls through to word-overlap, recall_preview stays []
    // (no seeded memories). This proves the import + call chain compiles and
    // executes — the underlying helper has its own dedicated test suite.
    const prevModel = process.env['RELAY_EMBEDDING_MODEL'];
    delete process.env['RELAY_EMBEDDING_MODEL'];
    try {
      const snap = await gatherSnapshot({ cwd: tmp, version: '0.0.1' });
      assert.ok(Array.isArray(snap.recall_preview));
    } finally {
      if (prevModel === undefined) delete process.env['RELAY_EMBEDDING_MODEL'];
      else process.env['RELAY_EMBEDDING_MODEL'] = prevModel;
    }
  });
});

describe('executeTuiCommand --json', () => {
  let tmp: string;
  let originalLogPath: string | undefined;
  let originalDbPath: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-tui-cmd-'));
    originalLogPath = process.env['RELAY_LOG_PATH'];
    originalDbPath = process.env['RELAY_DB_PATH'];
    process.env['RELAY_LOG_PATH'] = join(tmp, 'relay.ndjson');
    process.env['RELAY_DB_PATH'] = ':memory:';
  });

  afterEach(async () => {
    if (originalLogPath === undefined) delete process.env['RELAY_LOG_PATH'];
    else process.env['RELAY_LOG_PATH'] = originalLogPath;
    if (originalDbPath === undefined) delete process.env['RELAY_DB_PATH'];
    else process.env['RELAY_DB_PATH'] = originalDbPath;
    await rm(tmp, { recursive: true, force: true });
  });

  test('--json prints a single parseable Snapshot line, exit 0', async () => {
    const cap = makeIO(tmp);
    const code = await executeTuiCommand(
      { json: true, cwd: tmp, version: '1.2.3' },
      cap.io
    );
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');
    const lines = out.trim().split('\n');
    assert.strictEqual(lines.length, 1);
    const parsed = JSON.parse(lines[0]!) as { version: string; status: { binary_version: string; providers: unknown[] } };
    assert.strictEqual(parsed.version, '1.2.3');
    assert.strictEqual(parsed.status.binary_version, '1.2.3');
    assert.ok(Array.isArray(parsed.status.providers));
  });

  test('--json output contains no ANSI escape codes', async () => {
    const cap = makeIO(tmp);
    await executeTuiCommand({ json: true, cwd: tmp, version: '1.0.0' }, cap.io);
    const out = cap.stdout.join('');
    // eslint-disable-next-line no-control-regex
    assert.ok(!/\x1b\[/.test(out), 'JSON snapshot must be plain text (no ANSI)');
  });

  test('--json reflects activity log entries when present', async () => {
    await mkdir(tmp, { recursive: true });
    const lines = [
      JSON.stringify({ ts: Date.now() - 60_000, event: 'recall', cwd: tmp, ok: true }),
      JSON.stringify({ ts: Date.now() - 30_000, event: 'remember', cwd: tmp, ok: true }),
    ].join('\n') + '\n';
    await writeFile(process.env['RELAY_LOG_PATH']!, lines, 'utf-8');
    const cap = makeIO(tmp);
    const code = await executeTuiCommand(
      { json: true, cwd: tmp, version: '0.0.1' },
      cap.io
    );
    assert.strictEqual(code, 0);
    const parsed = JSON.parse(cap.stdout.join('').trim()) as { recent_activity: Array<{ event: string }> };
    assert.strictEqual(parsed.recent_activity.length, 2);
    // Newest first
    assert.strictEqual(parsed.recent_activity[0]!.event, 'remember');
    assert.strictEqual(parsed.recent_activity[1]!.event, 'recall');
  });
});
