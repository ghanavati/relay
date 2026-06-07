/**
 * Tests for `relay tui` — the `--json` snapshot path, the pure Command
 * Central render shape, and the command palette (08-07: palette actions and
 * the grant approval queue route through the SAME broker/session-command
 * functions as `relay session ...`, D-13/D-14).
 *
 * The interactive Ink renderer is intentionally not exercised here: spawning
 * a fake TTY in CI is brittle and the value of automated coverage there is
 * marginal versus the cost. We instead verify the data layer (gatherSnapshot),
 * the `--json` exit path, and the palette executor against the shared
 * in-memory control store.
 */

process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCommandCentralView,
  executePaletteCommand,
  executeTuiCommand,
  gatherSnapshot,
  parsePaletteCommand,
} from './cmd-tui.js';
import type { CliIO } from './commands.js';
import { gatherControlSnapshot, type ControlSnapshot } from '../control/read-model.js';
import type {
  ControlCapability,
  ControlEvent,
  ControlGrant,
  ControlMessage,
  ControlSession,
  ControlSessionState,
} from '../control/types.js';
import { ControlSessionStore } from '../control/session-store.js';
import { ControlBroker } from '../control/broker.js';
import { ControlAdapterRegistry } from '../control/adapter-registry.js';
import { FakeControlAdapter } from '../control/adapters/fake.js';
import { DEFAULT_HUMAN_SOURCE, executeSessionCommand } from './cmd-session.js';
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

// ─── Command Central render shape (Task 3) ──────────────────────────────────
//
// buildCommandCentralView is PURE: fixtures below are plain frozen literals,
// no store, no TTY, no provider network calls. The Ink components only map
// this view model to Text nodes, so these tests pin the operator-console
// shape for empty, active, blocked, and narrow-terminal snapshots.

const T0 = 1_750_000_000_000;

function fakeSession(
  over: Partial<ControlSession> & { session_id: string },
): ControlSession {
  return {
    session_id: over.session_id,
    provider: over.provider ?? 'fake',
    capabilities: over.capabilities ?? ['register', 'mailbox'],
    state: over.state ?? 'active',
    label: over.label ?? null,
    workdir: over.workdir ?? null,
    pid: over.pid ?? null,
    metadata: over.metadata ?? null,
    registered_at: over.registered_at ?? T0,
    last_seen_at: over.last_seen_at ?? T0,
  };
}

function fakeEvent(over: Partial<ControlEvent> & { id: number; session_id: string }): ControlEvent {
  return {
    id: over.id,
    session_id: over.session_id,
    event_type: over.event_type ?? 'session_updated',
    source_session_id: over.source_session_id ?? null,
    target_session_id: over.target_session_id ?? null,
    payload: over.payload ?? {},
    created_at: over.created_at ?? T0,
  };
}

function fakeMessage(
  over: Partial<ControlMessage> & { message_id: string; source_session_id: string; target_session_id: string },
): ControlMessage {
  return {
    message_id: over.message_id,
    source_session_id: over.source_session_id,
    target_session_id: over.target_session_id,
    sender_kind: over.sender_kind ?? 'human',
    content: over.content ?? 'hello there',
    content_hash: over.content_hash ?? 'a'.repeat(64),
    status: over.status ?? 'queued',
    redaction: over.redaction ?? { applied: false, rules: [] },
    fail_reason: over.fail_reason ?? null,
    expires_at: over.expires_at ?? null,
    created_at: over.created_at ?? T0,
    updated_at: over.updated_at ?? T0,
  };
}

function fakeGrant(
  over: Partial<ControlGrant> & { grant_id: string; source_session_id: string; target_session_id: string },
): ControlGrant {
  return {
    grant_id: over.grant_id,
    source_session_id: over.source_session_id,
    target_session_id: over.target_session_id,
    max_messages: over.max_messages ?? 5,
    used_messages: over.used_messages ?? 0,
    expires_at: over.expires_at ?? T0 + 60_000,
    created_at: over.created_at ?? T0,
    revoked_at: over.revoked_at ?? null,
  };
}

function fakeControl(parts: Partial<ControlSnapshot>): ControlSnapshot {
  return {
    generated_at: parts.generated_at ?? T0,
    sessions: parts.sessions ?? [],
    selected_session: parts.selected_session ?? null,
    events: parts.events ?? [],
    inbox: parts.inbox ?? [],
    grants: parts.grants ?? [],
    pending_actions: parts.pending_actions ?? [],
    blocked: parts.blocked ?? [],
    audit: parts.audit ?? [],
    providers: parts.providers ?? [],
  };
}

describe('buildCommandCentralView — render shape (pure, no provider calls)', () => {
  test('empty snapshot renders empty-state guidance in every pane', () => {
    const view = buildCommandCentralView(fakeControl({}), { width: 160 });
    assert.equal(view.narrow, false);
    assert.equal(view.rail.length, 0);
    assert.ok(view.rail_empty, 'rail must offer empty-state guidance');
    assert.ok(view.main.empty, 'main pane must explain there is no selection');
    assert.equal(view.main.events.length, 0);
    assert.equal(view.inbox.length, 0);
    assert.equal(view.grants.length, 0);
    assert.equal(view.pending.length, 0);
    assert.equal(view.audit.length, 0);
    assert.ok(view.status.includes('sessions 0'));
    assert.ok(view.hints.includes('q'), 'hints must document the quit key');
  });

  test('active snapshot maps sessions to badge rail rows with selection and queue rollups', () => {
    const a = fakeSession({
      session_id: 'sess-active',
      state: 'active',
      label: 'worker A',
      capabilities: ['register', 'observe', 'mailbox'],
    });
    const b = fakeSession({ session_id: 'sess-idle', state: 'idle', provider: 'codex' });
    const view = buildCommandCentralView(
      fakeControl({
        sessions: [a, b],
        selected_session: a,
        events: [
          fakeEvent({ id: 1, session_id: 'sess-active', event_type: 'session_registered', created_at: T0 - 5000 }),
          fakeEvent({ id: 2, session_id: 'sess-active', event_type: 'message_enqueued', created_at: T0 - 1000 }),
        ],
        inbox: [
          fakeMessage({ message_id: 'm1', source_session_id: 'sess-idle', target_session_id: 'sess-active' }),
        ],
        grants: [
          fakeGrant({ grant_id: 'g1', source_session_id: 'sess-idle', target_session_id: 'sess-active', used_messages: 2, max_messages: 5 }),
        ],
      }),
      { width: 160 },
    );

    assert.equal(view.rail.length, 2);
    assert.deepEqual(view.rail.map((r) => r.badge), ['ACT', 'IDL']);
    assert.equal(view.rail[0]!.selected, true);
    assert.equal(view.rail[1]!.selected, false);
    assert.equal(view.rail[0]!.queued, 1, 'inbox items targeting the session roll up on its rail row');
    assert.equal(view.rail[0]!.title, 'worker A');
    assert.ok(view.main.header.includes('sess-active'));
    assert.ok(view.main.header.includes('ACT'));
    assert.ok(view.main.badges.includes('mbx'), 'capability badges use compact codes');
    assert.ok(view.main.badges.includes('obs'));
    assert.equal(view.main.empty, null);
    assert.equal(view.main.events.length, 2);
    assert.ok(view.main.events[0]!.includes('session_registered'));
    assert.ok(view.main.events[1]!.includes('message_enqueued'));
    assert.equal(view.inbox.length, 1);
    assert.ok(view.inbox[0]!.includes('sess-idle'), 'inbox lines show the source session');
    assert.equal(view.grants.length, 1);
    assert.ok(view.grants[0]!.includes('2/5'), 'grant lines show used/max budget');
    assert.ok(view.status.includes('sessions 2'));
    assert.ok(view.status.includes('1 act'));
    assert.ok(view.status.includes('inbox 1'));
  });

  test('blocked sessions are flagged on the rail and counted in the status strip', () => {
    const x = fakeSession({ session_id: 'sess-x' });
    const view = buildCommandCentralView(
      fakeControl({
        sessions: [x],
        selected_session: x,
        blocked: [
          fakeEvent({ id: 9, session_id: 'sess-x', event_type: 'message_blocked', payload: { reason: 'grant_required' } }),
        ],
      }),
      { width: 160 },
    );
    assert.equal(view.rail[0]!.blocked, true);
    assert.ok(view.status.includes('blocked 1'));
  });

  test('narrow terminals flip to the stacked layout', () => {
    const wide = buildCommandCentralView(fakeControl({}), { width: 160 });
    const narrow = buildCommandCentralView(fakeControl({}), { width: 60 });
    assert.equal(wide.narrow, false);
    assert.equal(narrow.narrow, true);
  });

  test('event pane is display-capped to the newest lines', () => {
    const sel = fakeSession({ session_id: 'sess-busy' });
    const events: ControlEvent[] = [];
    for (let i = 0; i < 17; i++) {
      events.push(fakeEvent({ id: i + 1, session_id: 'sess-busy', event_type: 'session_updated', created_at: T0 - (17 - i) * 1000 }));
    }
    events.push(fakeEvent({ id: 99, session_id: 'sess-busy', event_type: 'session_ended', created_at: T0 }));
    const view = buildCommandCentralView(
      fakeControl({ sessions: [sel], selected_session: sel, events }),
      { width: 160 },
    );
    assert.equal(view.main.events.length, 12, 'event pane caps at PANE_ROWS.events');
    assert.ok(view.main.events[view.main.events.length - 1]!.includes('session_ended'), 'cap keeps the NEWEST events');
  });

  test('pending actions render request ids; audit strip is bounded newest first', () => {
    const sel = fakeSession({ session_id: 'sess-p' });
    const audit: ControlEvent[] = [];
    for (let i = 0; i < 6; i++) {
      audit.push(
        fakeEvent({
          id: 50 - i,
          session_id: 'sess-p',
          event_type: i === 0 ? 'grant_issued' : 'session_updated',
          created_at: T0 - i * 1000,
        }),
      );
    }
    const view = buildCommandCentralView(
      fakeControl({
        sessions: [sel],
        selected_session: sel,
        pending_actions: [
          fakeEvent({ id: 70, session_id: 'sess-p', event_type: 'control_requested', payload: { request_id: 'req-9', action: 'send' } }),
        ],
        audit,
      }),
      { width: 160 },
    );
    assert.equal(view.pending.length, 1);
    assert.ok(view.pending[0]!.includes('req-9'));
    assert.equal(view.audit.length, 4, 'audit strip caps at PANE_ROWS.audit');
    assert.ok(view.audit[0]!.includes('grant_issued'), 'audit stays newest first');
  });

  test('hints document the ":" command palette key', () => {
    const view = buildCommandCentralView(fakeControl({}), { width: 160 });
    assert.ok(view.hints.includes(':'), 'palette key must be discoverable from the hints line');
  });
});

// ─── Command palette actions through the broker (08-07 Task 1, D-13) ────────
//
// The palette executor calls the SAME shared action functions as the
// `relay session ...` CLI: same broker policy, same audit events, same
// RelayError codes. Fixtures are fake-provider sessions in the shared
// :memory: control store — no TTY, no Ink, no provider network calls.

let uidCounter = 0;
function uid(prefix: string): string {
  uidCounter += 1;
  return `${prefix}-t${uidCounter}`;
}

interface PaletteRig {
  store: ControlSessionStore;
  broker: ControlBroker;
  registry: ControlAdapterRegistry;
  fake: FakeControlAdapter;
  deps: { store: ControlSessionStore; broker: ControlBroker; registry: ControlAdapterRegistry };
}

function paletteRig(): PaletteRig {
  const store = new ControlSessionStore();
  const broker = new ControlBroker(store);
  const registry = new ControlAdapterRegistry(store, broker);
  const fake = new FakeControlAdapter();
  registry.register(fake);
  return { store, broker, registry, fake, deps: { store, broker, registry } };
}

function registerControl(
  store: ControlSessionStore,
  session_id: string,
  capabilities: readonly ControlCapability[],
  state: ControlSessionState = 'active',
): void {
  store.upsertSession({ session_id, provider: 'fake', capabilities, state }, T0);
}

describe('parsePaletteCommand', () => {
  test('tokenizes action and args, tolerating extra whitespace', () => {
    const parsed = parsePaletteCommand('  send  sess-a   hello   world ');
    assert.deepEqual(parsed, { ok: true, action: 'send', args: ['sess-a', 'hello', 'world'] });
  });

  test('empty input is rejected with usage guidance', () => {
    const parsed = parsePaletteCommand('   ');
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.match(parsed.error, /send|usage/i);
  });

  test('unknown verbs are rejected and the error names the valid commands', () => {
    const parsed = parsePaletteCommand('frobnicate x');
    assert.equal(parsed.ok, false);
    if (!parsed.ok) {
      assert.match(parsed.error, /frobnicate/);
      assert.match(parsed.error, /send/);
      assert.match(parsed.error, /pause/);
    }
  });
});

describe('executePaletteCommand — broker-routed palette actions (D-13)', () => {
  test('send queues through the broker and delivers via the adapter', async () => {
    const rig = paletteRig();
    const target = uid('pal-send');
    registerControl(rig.store, target, ['register', 'mailbox']);
    const result = await executePaletteCommand(`send ${target} hello from palette`, {
      deps: rig.deps,
    });
    assert.equal(result.ok, true, `expected ok, got: ${JSON.stringify(result)}`);
    const inbox = rig.fake.getInbox(target);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]!.content, 'hello from palette');
    assert.equal(inbox[0]!.sender_kind, 'human');
    assert.equal(inbox[0]!.source_session_id, DEFAULT_HUMAN_SOURCE);
    const events = rig.store.tailEvents(target);
    assert.equal(events.filter((e) => e.event_type === 'message_enqueued').length, 1);
    assert.equal(events.filter((e) => e.event_type === 'message_delivered').length, 1);
  });

  test('send to a target with no delivery capability fails with CONTROL_DELIVERY_UNSUPPORTED', async () => {
    const rig = paletteRig();
    const target = uid('pal-nocap');
    registerControl(rig.store, target, ['register', 'observe']);
    const result = await executePaletteCommand(`send ${target} hi`, { deps: rig.deps });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'CONTROL_DELIVERY_UNSUPPORTED');
  });

  test('send to an unregistered session fails with CONTROL_SESSION_NOT_FOUND', async () => {
    const rig = paletteRig();
    const result = await executePaletteCommand(`send ${uid('pal-ghost')} hi`, { deps: rig.deps });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'CONTROL_SESSION_NOT_FOUND');
  });

  test('send without content is INVALID_ARGS', async () => {
    const rig = paletteRig();
    const target = uid('pal-empty');
    registerControl(rig.store, target, ['register', 'mailbox']);
    const result = await executePaletteCommand(`send ${target}`, { deps: rig.deps });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'INVALID_ARGS');
  });

  test('inspect returns a summary and selects the session', async () => {
    const rig = paletteRig();
    const id = uid('pal-insp');
    registerControl(rig.store, id, ['register', 'mailbox']);
    const result = await executePaletteCommand(`inspect ${id}`, { deps: rig.deps });
    assert.equal(result.ok, true, `expected ok, got: ${JSON.stringify(result)}`);
    if (result.ok) {
      assert.ok(result.message.includes(id));
      assert.equal(result.select_session_id, id);
    }
  });

  test('inspect with no argument falls back to the selected session', async () => {
    const rig = paletteRig();
    const id = uid('pal-insp-sel');
    registerControl(rig.store, id, ['register', 'mailbox']);
    const result = await executePaletteCommand('inspect', {
      deps: rig.deps,
      selected_session_id: id,
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.select_session_id, id);
  });

  test('inspect of an unknown session fails with CONTROL_SESSION_NOT_FOUND', async () => {
    const rig = paletteRig();
    const result = await executePaletteCommand(`inspect ${uid('pal-missing')}`, { deps: rig.deps });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'CONTROL_SESSION_NOT_FOUND');
  });

  test('tail reports the event count and selects the session', async () => {
    const rig = paletteRig();
    const id = uid('pal-tail');
    registerControl(rig.store, id, ['register', 'mailbox']);
    rig.store.appendEvent({ session_id: id, event_type: 'session_registered', payload: {} }, T0);
    rig.store.appendEvent({ session_id: id, event_type: 'session_updated', payload: {} }, T0 + 1);
    const result = await executePaletteCommand(`tail ${id}`, { deps: rig.deps });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.match(result.message, /2 event/);
      assert.equal(result.select_session_id, id);
    }
  });

  test('grant issues a TTL-bound budgeted grant with the same audit event as the CLI', async () => {
    const rig = paletteRig();
    const source = uid('pal-gs');
    const target = uid('pal-gt');
    registerControl(rig.store, source, ['register', 'tool_call', 'mailbox']);
    registerControl(rig.store, target, ['register', 'mailbox']);
    const result = await executePaletteCommand(`grant ${source} ${target} 10m 3`, {
      deps: rig.deps,
    });
    assert.equal(result.ok, true, `expected ok, got: ${JSON.stringify(result)}`);
    const grant = rig.store.getGrant(source, target);
    assert.ok(grant, 'grant persisted');
    assert.equal(grant.max_messages, 3);
    assert.equal(grant.expires_at - grant.created_at, 600_000);
    const issued = rig.store.tailEvents(source).filter((e) => e.event_type === 'grant_issued');
    assert.equal(issued.length, 1);
    assert.equal(issued[0]!.payload['grant_id'], grant.grant_id);
  });

  test('grant defaults match the CLI defaults (15m TTL, 10 messages)', async () => {
    const rig = paletteRig();
    const source = uid('pal-gds');
    const target = uid('pal-gdt');
    registerControl(rig.store, source, ['register', 'mailbox']);
    registerControl(rig.store, target, ['register', 'mailbox']);
    const result = await executePaletteCommand(`grant ${source} ${target}`, { deps: rig.deps });
    assert.equal(result.ok, true);
    const grant = rig.store.getGrant(source, target);
    assert.ok(grant);
    assert.equal(grant.max_messages, 10);
    assert.equal(grant.expires_at - grant.created_at, 900_000);
  });

  test('grant for an unknown source fails with CONTROL_SESSION_NOT_FOUND', async () => {
    const rig = paletteRig();
    const target = uid('pal-gkt');
    registerControl(rig.store, target, ['register', 'mailbox']);
    const result = await executePaletteCommand(`grant ${uid('pal-gks')} ${target}`, {
      deps: rig.deps,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'CONTROL_SESSION_NOT_FOUND');
  });

  test('revoke revokes the grant and appends grant_revoked', async () => {
    const rig = paletteRig();
    const source = uid('pal-rs');
    const target = uid('pal-rt');
    registerControl(rig.store, source, ['register', 'mailbox']);
    registerControl(rig.store, target, ['register', 'mailbox']);
    const grant = rig.store.grant(
      { source_session_id: source, target_session_id: target, ttl_ms: 60_000, max_messages: 5 },
      Date.now(),
    );
    const result = await executePaletteCommand(`revoke ${grant.grant_id}`, { deps: rig.deps });
    assert.equal(result.ok, true);
    const revoked = rig.store.tailEvents(source).filter((e) => e.event_type === 'grant_revoked');
    assert.equal(revoked.length, 1);
    const check = rig.broker.checkGrant(source, target, Date.now());
    assert.equal(check.allowed, false);
  });

  test('revoke of an unknown grant fails with RUN_NOT_FOUND', async () => {
    const rig = paletteRig();
    const result = await executePaletteCommand(`revoke ${uid('pal-rmiss')}`, { deps: rig.deps });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'RUN_NOT_FOUND');
  });

  test('delegate frames the task and delivers to a tool_call-capable target', async () => {
    const rig = paletteRig();
    const target = uid('pal-del');
    registerControl(rig.store, target, ['register', 'mailbox', 'tool_call']);
    const result = await executePaletteCommand(`delegate ${target} review the failing build`, {
      deps: rig.deps,
    });
    assert.equal(result.ok, true, `expected ok, got: ${JSON.stringify(result)}`);
    const inbox = rig.fake.getInbox(target);
    assert.equal(inbox.length, 1);
    assert.ok(inbox[0]!.content.includes('review the failing build'));
    assert.ok(inbox[0]!.content.includes('[delegated task]'), 'delegation is visibly framed');
    const enqueued = rig.store.tailEvents(target).filter((e) => e.event_type === 'message_enqueued');
    assert.equal(enqueued.length, 1, 'delegation flows through the brokered audit path');
  });

  test('delegate to a session without tool_call fails clearly and is audited (D-01)', async () => {
    const rig = paletteRig();
    const target = uid('pal-del-nocap');
    registerControl(rig.store, target, ['register', 'mailbox']);
    const result = await executePaletteCommand(`delegate ${target} do the thing`, {
      deps: rig.deps,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'CONTROL_DELIVERY_UNSUPPORTED');
      assert.match(result.message, /tool_call/);
    }
    const blocked = rig.store
      .tailEvents(DEFAULT_HUMAN_SOURCE)
      .filter((e) => e.event_type === 'message_blocked' && e.target_session_id === target);
    assert.equal(blocked.length, 1, 'refused delegation is audited like other denials');
    assert.equal(rig.fake.getInbox(target).length, 0, 'nothing was delivered');
  });

  test('pause flips an interrupt-capable active session to idle with an audit event', async () => {
    const rig = paletteRig();
    const id = uid('pal-pause');
    registerControl(rig.store, id, ['register', 'mailbox', 'interrupt']);
    const result = await executePaletteCommand(`pause ${id}`, { deps: rig.deps });
    assert.equal(result.ok, true, `expected ok, got: ${JSON.stringify(result)}`);
    assert.equal(rig.store.getSession(id)?.state, 'idle');
    const updated = rig.store
      .tailEvents(id)
      .filter((e) => e.event_type === 'session_updated' && e.payload['action'] === 'pause');
    assert.equal(updated.length, 1);
  });

  test('pause without the interrupt capability fails clearly (D-01)', async () => {
    const rig = paletteRig();
    const id = uid('pal-pause-nocap');
    registerControl(rig.store, id, ['register', 'mailbox']);
    const result = await executePaletteCommand(`pause ${id}`, { deps: rig.deps });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'CONTROL_DELIVERY_UNSUPPORTED');
      assert.match(result.message, /interrupt/);
    }
    assert.equal(rig.store.getSession(id)?.state, 'active', 'state unchanged on refusal');
  });

  test('pause of an unregistered session fails with CONTROL_SESSION_NOT_FOUND', async () => {
    const rig = paletteRig();
    const result = await executePaletteCommand(`pause ${uid('pal-pause-miss')}`, {
      deps: rig.deps,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'CONTROL_SESSION_NOT_FOUND');
  });

  test('pause of an already-idle session is INVALID_ARGS', async () => {
    const rig = paletteRig();
    const id = uid('pal-pause-idle');
    registerControl(rig.store, id, ['register', 'mailbox', 'interrupt'], 'idle');
    const result = await executePaletteCommand(`pause ${id}`, { deps: rig.deps });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'INVALID_ARGS');
  });

  test('pause falls back to the selected session when no argument is given', async () => {
    const rig = paletteRig();
    const id = uid('pal-pause-sel');
    registerControl(rig.store, id, ['register', 'mailbox', 'interrupt']);
    const result = await executePaletteCommand('pause', {
      deps: rig.deps,
      selected_session_id: id,
    });
    assert.equal(result.ok, true);
    assert.equal(rig.store.getSession(id)?.state, 'idle');
  });

  test('resume flips a resume_send-capable idle session back to active', async () => {
    const rig = paletteRig();
    const id = uid('pal-resume');
    registerControl(rig.store, id, ['register', 'mailbox', 'resume_send'], 'idle');
    const result = await executePaletteCommand(`resume ${id}`, { deps: rig.deps });
    assert.equal(result.ok, true, `expected ok, got: ${JSON.stringify(result)}`);
    assert.equal(rig.store.getSession(id)?.state, 'active');
    const updated = rig.store
      .tailEvents(id)
      .filter((e) => e.event_type === 'session_updated' && e.payload['action'] === 'resume');
    assert.equal(updated.length, 1);
  });

  test('resume without the resume_send capability fails clearly (D-01)', async () => {
    const rig = paletteRig();
    const id = uid('pal-resume-nocap');
    registerControl(rig.store, id, ['register', 'mailbox'], 'idle');
    const result = await executePaletteCommand(`resume ${id}`, { deps: rig.deps });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'CONTROL_DELIVERY_UNSUPPORTED');
      assert.match(result.message, /resume_send/);
    }
    assert.equal(rig.store.getSession(id)?.state, 'idle', 'state unchanged on refusal');
  });

  test('palette failures and CLI failures carry the same RelayError code', async () => {
    const rig = paletteRig();
    const target = uid('pal-eq');
    registerControl(rig.store, target, ['register', 'observe']);
    const palette = await executePaletteCommand(`send ${target} hi`, { deps: rig.deps });
    assert.equal(palette.ok, false);
    const cap = makeIO();
    const code = await executeSessionCommand(
      { action: 'send', positionals: [target, 'hi'], json: true },
      cap.io,
      rig.deps,
    );
    assert.equal(code, 1);
    if (!palette.ok) {
      assert.ok(
        cap.stderr.join('').includes(palette.code),
        'CLI stderr names the same RelayError code the palette surfaced',
      );
    }
  });
});

// ─── Inbox + grant approval queue (08-07 Task 2, D-14) ──────────────────────
//
// Pending model requests are visible in Command Central; the human approves
// or denies through the broker grant APIs — TTL, budget, source, target, and
// audit events all flow through the same policy path. Models cannot approve
// their own requests (covered at the broker layer in broker.test.ts); here we
// pin the operator surface: visibility, expiry markers, and palette routing.

describe('Command Central approval queue (D-14)', () => {
  function approvalRig(): PaletteRig & { source: string; target: string; request_id: string } {
    const rig = paletteRig();
    const source = uid('apv-src');
    const target = uid('apv-tgt');
    registerControl(rig.store, source, ['register', 'tool_call', 'mailbox']);
    registerControl(rig.store, target, ['register', 'mailbox']);
    const requested = rig.broker.requestGrant(
      { source_session_id: source, target_session_id: target, ttl_ms: 60_000, max_messages: 2 },
      Date.now(),
    );
    const request_id = requested.payload['request_id'] as string;
    return { ...rig, source, target, request_id };
  }

  test('pending requests render expired markers from the approval window', () => {
    const sel = fakeSession({ session_id: 'sess-exp' });
    const view = buildCommandCentralView(
      fakeControl({
        sessions: [sel],
        selected_session: sel,
        pending_actions: [
          fakeEvent({
            id: 80,
            session_id: 'sess-exp',
            event_type: 'control_requested',
            payload: { request_id: 'req-fresh', action: 'grant', expires_at: T0 + 60_000 },
          }),
          fakeEvent({
            id: 81,
            session_id: 'sess-exp',
            event_type: 'control_requested',
            payload: { request_id: 'req-stale', action: 'grant', expires_at: T0 - 1_000 },
          }),
        ],
      }),
      { width: 160 },
    );
    assert.equal(view.pending.length, 2);
    assert.ok(!view.pending[0]!.includes('exp!'), 'unexpired requests carry no marker');
    assert.ok(view.pending[1]!.includes('exp!'), 'expired requests are marked for the operator');
  });

  test('palette approve issues the grant through the broker with full audit', async () => {
    const rig = approvalRig();
    const result = await executePaletteCommand(`approve ${rig.request_id}`, { deps: rig.deps });
    assert.equal(result.ok, true, `expected ok, got: ${JSON.stringify(result)}`);
    const grant = rig.store.getGrant(rig.source, rig.target);
    assert.ok(grant, 'grant issued through the broker');
    assert.equal(grant.max_messages, 2, 'requested budget carried into the grant');
    const events = rig.store.tailEvents(rig.source);
    const approved = events.filter((e) => e.event_type === 'control_approved');
    assert.equal(approved.length, 1);
    assert.equal(approved[0]!.payload['approved_by'], 'human');
    assert.equal(events.filter((e) => e.event_type === 'grant_issued').length, 1);
  });

  test('palette deny resolves the request without issuing a grant', async () => {
    const rig = approvalRig();
    const result = await executePaletteCommand(`deny ${rig.request_id} not today`, {
      deps: rig.deps,
    });
    assert.equal(result.ok, true, `expected ok, got: ${JSON.stringify(result)}`);
    assert.equal(rig.store.getGrant(rig.source, rig.target), undefined, 'no grant issued');
    const state = rig.broker.getControlRequest(rig.request_id);
    assert.ok(state);
    assert.equal(state.status, 'denied');
    assert.equal(state.resolution?.payload['reason'], 'not today');
  });

  test('palette approve of an unknown request surfaces RUN_NOT_FOUND', async () => {
    const rig = paletteRig();
    const result = await executePaletteCommand(`approve ${uid('apv-miss')}`, { deps: rig.deps });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'RUN_NOT_FOUND');
  });

  test('approved requests leave the shared snapshot pending queue', async () => {
    const rig = approvalRig();
    const before = gatherControlSnapshot({ store: rig.store });
    assert.ok(
      before.pending_actions.some((e) => e.payload['request_id'] === rig.request_id),
      'pending request visible in Command Central before approval',
    );
    await executePaletteCommand(`approve ${rig.request_id}`, { deps: rig.deps });
    const after = gatherControlSnapshot({ store: rig.store });
    assert.ok(
      !after.pending_actions.some((e) => e.payload['request_id'] === rig.request_id),
      'approved request no longer pending',
    );
  });
});
