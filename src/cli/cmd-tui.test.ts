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
import type { ControlSnapshot } from '../control/read-model.js';
import { ControlSessionStore } from '../control/session-store.js';
import { getDb } from '../runtime/store/db.js';

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

/** Untyped access so the contract test compiles before `control` is wired. */
function controlOf(snap: unknown): ControlSnapshot | undefined {
  return (snap as { control?: ControlSnapshot }).control;
}

/** Snapshot reads the control tables globally — wipe for exact assertions. */
function wipeControlTables(): void {
  const db = getDb();
  for (const table of [
    'control_delivery_attempts',
    'control_grants',
    'control_mailbox',
    'control_events',
    'control_sessions',
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
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

describe('gatherSnapshot — Command Central control snapshot', () => {
  let tmp: string;
  let originalLogPath: string | undefined;
  let originalDbPath: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-tui-control-'));
    originalLogPath = process.env['RELAY_LOG_PATH'];
    originalDbPath = process.env['RELAY_DB_PATH'];
    process.env['RELAY_LOG_PATH'] = join(tmp, 'relay.ndjson');
    process.env['RELAY_DB_PATH'] = ':memory:';
    wipeControlTables();
  });

  afterEach(async () => {
    if (originalLogPath === undefined) delete process.env['RELAY_LOG_PATH'];
    else process.env['RELAY_LOG_PATH'] = originalLogPath;
    if (originalDbPath === undefined) delete process.env['RELAY_DB_PATH'];
    else process.env['RELAY_DB_PATH'] = originalDbPath;
    await rm(tmp, { recursive: true, force: true });
  });

  test('snapshot carries a control read model with all Command Central panes', async () => {
    const snap = await gatherSnapshot({ cwd: tmp, version: '1.0.0' });
    const control = controlOf(snap);
    assert.ok(control, 'snapshot must include the shared ControlSnapshot (D-12)');
    assert.ok(Number.isFinite(control.generated_at));
    assert.ok(Array.isArray(control.sessions));
    assert.ok(Array.isArray(control.events));
    assert.ok(Array.isArray(control.inbox));
    assert.ok(Array.isArray(control.grants));
    assert.ok(Array.isArray(control.pending_actions));
    assert.ok(Array.isArray(control.blocked));
    assert.ok(Array.isArray(control.audit));
    assert.ok(Array.isArray(control.providers));
  });

  test('control pane reflects registered sessions and queued mailbox items', async () => {
    const store = new ControlSessionStore();
    store.upsertSession({
      session_id: 'tui-sess-a',
      provider: 'fake',
      capabilities: ['register', 'mailbox'],
    });
    store.upsertSession({
      session_id: 'tui-sess-b',
      provider: 'fake',
      capabilities: ['register', 'mailbox'],
    });
    store.enqueueMessage({
      source_session_id: 'tui-sess-a',
      target_session_id: 'tui-sess-b',
      sender_kind: 'human',
      content: 'queued for delivery',
    });

    const snap = await gatherSnapshot({ cwd: tmp, version: '1.0.0' });
    const control = controlOf(snap);
    assert.ok(control);
    assert.deepEqual(
      control.sessions.map((s) => s.session_id).sort(),
      ['tui-sess-a', 'tui-sess-b'],
    );
    assert.ok(control.selected_session !== null, 'a session must be selected by default');
    assert.equal(control.inbox.length, 1);
    assert.equal(control.inbox[0]!.target_session_id, 'tui-sess-b');
    const fakeSummary = control.providers.find((p) => p.provider === 'fake');
    assert.ok(fakeSummary);
    assert.equal(fakeSummary.total, 2);
  });

  test('legacy health fields survive next to the control snapshot', async () => {
    const snap = await gatherSnapshot({ cwd: tmp, version: '7.7.7' });
    assert.ok(controlOf(snap), 'control snapshot present');
    // Script-facing legacy contract — unchanged shape and names.
    assert.equal(snap.version, '7.7.7');
    assert.equal(snap.status.binary_version, '7.7.7');
    assert.ok(typeof snap.status.db_path === 'string');
    assert.ok(Number.isInteger(snap.status.db_entries));
    assert.ok(typeof snap.status.hook_installed === 'boolean');
    assert.equal(snap.status.providers.length, 4);
    assert.ok(Array.isArray(snap.recent_activity));
    assert.ok(Array.isArray(snap.recall_preview));
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

  test('--json is the machine-readable Command Central contract (control + legacy)', async () => {
    wipeControlTables();
    const store = new ControlSessionStore();
    store.upsertSession({
      session_id: 'tui-json-sess',
      provider: 'fake',
      capabilities: ['register', 'mailbox'],
      label: 'json contract',
    });

    const cap = makeIO(tmp);
    const code = await executeTuiCommand({ json: true, cwd: tmp, version: '2.0.0' }, cap.io);
    assert.strictEqual(code, 0);
    const lines = cap.stdout.join('').trim().split('\n');
    assert.strictEqual(lines.length, 1, '--json stays a SINGLE bounded snapshot');
    const parsed = JSON.parse(lines[0]!) as {
      version: string;
      control?: {
        sessions: Array<{ session_id: string }>;
        events: unknown[];
        inbox: unknown[];
        grants: unknown[];
        pending_actions: unknown[];
        blocked: unknown[];
        audit: unknown[];
        providers: unknown[];
        selected_session: { session_id: string } | null;
      };
      status: { binary_version: string; providers: unknown[] };
    };
    // Command Central state contract.
    assert.ok(parsed.control, 'JSON snapshot must expose the control read model');
    assert.deepStrictEqual(
      parsed.control.sessions.map((s) => s.session_id),
      ['tui-json-sess'],
    );
    assert.strictEqual(parsed.control.selected_session?.session_id, 'tui-json-sess');
    assert.ok(Array.isArray(parsed.control.events));
    assert.ok(Array.isArray(parsed.control.inbox));
    assert.ok(Array.isArray(parsed.control.grants));
    assert.ok(Array.isArray(parsed.control.pending_actions));
    assert.ok(Array.isArray(parsed.control.blocked));
    assert.ok(Array.isArray(parsed.control.audit));
    assert.ok(Array.isArray(parsed.control.providers));
    // Legacy health fields scripts rely on stay top-level and unchanged.
    assert.strictEqual(parsed.version, '2.0.0');
    assert.strictEqual(parsed.status.binary_version, '2.0.0');
    assert.strictEqual(parsed.status.providers.length, 4);
  });
});
