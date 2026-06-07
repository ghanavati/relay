/**
 * Phase 8 / Plan 06 / Task 1 — broker-backed ControlSnapshot read model.
 *
 * gatherControlSnapshot reads ONLY through ControlSessionStore helpers with
 * explicit limits (D-12: no TUI-owned SQL, no unbounded SELECTs) and returns
 * an immutable ControlSnapshot: session roster, selected session, bounded
 * event tail, queued inbox, active grants, pending control actions, blocked
 * events, audit items, and provider status summaries (CONTROL-11).
 *
 * Tests share one :memory: connection (module-level _db cache in db.ts);
 * control tables are wiped between tests because the snapshot reads globally.
 */

process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';

import { getDb } from '../runtime/store/db.js';
import { ControlSessionStore } from './session-store.js';
import { emptyControlSnapshot, gatherControlSnapshot } from './read-model.js';

const T0 = 1_750_000_000_000; // fixed epoch-ms base for deterministic clocks

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

const CONTROL_TABLES = [
  'control_delivery_attempts',
  'control_grants',
  'control_mailbox',
  'control_events',
  'control_sessions',
] as const;

/** Snapshot reads are global — wipe control rows so each test is exact. */
function wipeControlTables(): void {
  const db = getDb();
  for (const table of CONTROL_TABLES) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
}

function register(
  store: ControlSessionStore,
  session_id: string,
  provider: string,
  t: number,
  state: 'active' | 'idle' | 'ended' = 'active',
): void {
  store.upsertSession(
    { session_id, provider, capabilities: ['register', 'mailbox'], state },
    t,
  );
}

// ─── emptyControlSnapshot ───────────────────────────────────────────────────

describe('emptyControlSnapshot', () => {
  test('returns a frozen snapshot with empty collections and null selection', () => {
    const snap = emptyControlSnapshot(T0);
    assert.equal(snap.generated_at, T0);
    assert.equal(snap.sessions.length, 0);
    assert.equal(snap.selected_session, null);
    assert.equal(snap.events.length, 0);
    assert.equal(snap.inbox.length, 0);
    assert.equal(snap.grants.length, 0);
    assert.equal(snap.pending_actions.length, 0);
    assert.equal(snap.blocked.length, 0);
    assert.equal(snap.audit.length, 0);
    assert.equal(snap.providers.length, 0);
    assert.equal(Object.isFrozen(snap), true);
    assert.equal(Object.isFrozen(snap.sessions), true);
    assert.equal(Object.isFrozen(snap.audit), true);
  });
});

// ─── Empty store ────────────────────────────────────────────────────────────

describe('gatherControlSnapshot — empty store', () => {
  beforeEach(wipeControlTables);

  test('empty store yields empty roster, null selection, and empty panes', () => {
    const store = new ControlSessionStore();
    const snap = gatherControlSnapshot({ store, now: T0 });
    assert.equal(snap.generated_at, T0);
    assert.equal(snap.sessions.length, 0);
    assert.equal(snap.selected_session, null);
    assert.equal(snap.events.length, 0);
    assert.equal(snap.inbox.length, 0);
    assert.equal(snap.grants.length, 0);
    assert.equal(snap.pending_actions.length, 0);
    assert.equal(snap.blocked.length, 0);
    assert.equal(snap.audit.length, 0);
    assert.equal(snap.providers.length, 0);
  });

  test('snapshot object and collections are frozen (immutability)', () => {
    const store = new ControlSessionStore();
    register(store, uid('sess'), 'fake', T0);
    const snap = gatherControlSnapshot({ store, now: T0 + 1 });
    assert.equal(Object.isFrozen(snap), true);
    assert.equal(Object.isFrozen(snap.sessions), true);
    assert.equal(Object.isFrozen(snap.inbox), true);
    assert.equal(Object.isFrozen(snap.grants), true);
    assert.equal(Object.isFrozen(snap.pending_actions), true);
    assert.equal(Object.isFrozen(snap.blocked), true);
    assert.equal(Object.isFrozen(snap.audit), true);
    assert.equal(Object.isFrozen(snap.providers), true);
    assert.equal(Object.isFrozen(snap.providers[0] ?? {}), true);
  });
});

// ─── Roster and selection ───────────────────────────────────────────────────

describe('gatherControlSnapshot — roster and selection', () => {
  beforeEach(wipeControlTables);

  test('roster is ordered by last_seen_at DESC and bounded by limits.sessions', () => {
    const store = new ControlSessionStore();
    register(store, 's-old', 'codex', T0);
    register(store, 's-mid', 'lmstudio', T0 + 1000);
    register(store, 's-new', 'fake', T0 + 2000);
    const snap = gatherControlSnapshot({ store, now: T0 + 3000, limits: { sessions: 2 } });
    assert.deepEqual(
      snap.sessions.map((s) => s.session_id),
      ['s-new', 's-mid'],
    );
  });

  test('default selection is the most recently seen session', () => {
    const store = new ControlSessionStore();
    register(store, 's-old', 'codex', T0);
    register(store, 's-new', 'fake', T0 + 1000);
    const snap = gatherControlSnapshot({ store, now: T0 + 2000 });
    assert.equal(snap.selected_session?.session_id, 's-new');
  });

  test('explicit selected_session_id wins over the default', () => {
    const store = new ControlSessionStore();
    register(store, 's-old', 'codex', T0);
    register(store, 's-new', 'fake', T0 + 1000);
    const snap = gatherControlSnapshot({ store, now: T0 + 2000, selected_session_id: 's-old' });
    assert.equal(snap.selected_session?.session_id, 's-old');
  });

  test('explicit selection outside the bounded roster is still resolved', () => {
    const store = new ControlSessionStore();
    register(store, 's-old', 'codex', T0);
    register(store, 's-new', 'fake', T0 + 1000);
    const snap = gatherControlSnapshot({
      store,
      now: T0 + 2000,
      selected_session_id: 's-old',
      limits: { sessions: 1 },
    });
    assert.deepEqual(snap.sessions.map((s) => s.session_id), ['s-new']);
    assert.equal(snap.selected_session?.session_id, 's-old');
  });

  test('unknown selected_session_id yields null selection and empty tail', () => {
    const store = new ControlSessionStore();
    register(store, 's-a', 'fake', T0);
    store.appendEvent({ session_id: 's-a', event_type: 'session_registered', payload: {} }, T0);
    const snap = gatherControlSnapshot({ store, now: T0 + 1, selected_session_id: 'no-such' });
    assert.equal(snap.selected_session, null);
    assert.equal(snap.events.length, 0);
  });
});

// ─── Bounded event tail ─────────────────────────────────────────────────────

describe('gatherControlSnapshot — bounded event tail', () => {
  beforeEach(wipeControlTables);

  test('tail holds only the selected session events, newest N, chronological', () => {
    const store = new ControlSessionStore();
    register(store, 's-a', 'fake', T0);
    register(store, 's-b', 'codex', T0);
    for (let i = 0; i < 8; i++) {
      store.appendEvent(
        { session_id: 's-a', event_type: 'session_updated', payload: { seq: i } },
        T0 + i,
      );
    }
    store.appendEvent({ session_id: 's-b', event_type: 'session_registered', payload: {} }, T0 + 99);

    const snap = gatherControlSnapshot({
      store,
      now: T0 + 100,
      selected_session_id: 's-a',
      limits: { events: 5 },
    });
    assert.equal(snap.events.length, 5);
    assert.ok(snap.events.every((e) => e.session_id === 's-a'));
    // Newest five of eight → seq 3..7, in chronological (ascending) order.
    assert.deepEqual(
      snap.events.map((e) => e.payload['seq']),
      [3, 4, 5, 6, 7],
    );
    for (let i = 1; i < snap.events.length; i++) {
      assert.ok(snap.events[i]!.id > snap.events[i - 1]!.id);
    }
  });
});

// ─── Queued inbox ───────────────────────────────────────────────────────────

describe('gatherControlSnapshot — queued inbox', () => {
  beforeEach(wipeControlTables);

  test('inbox lists queued unexpired messages across targets, oldest first, bounded', () => {
    const store = new ControlSessionStore();
    register(store, 's-a', 'fake', T0);
    register(store, 's-b', 'codex', T0);
    register(store, 's-c', 'lmstudio', T0);

    const q1 = store.enqueueMessage(
      { source_session_id: 's-a', target_session_id: 's-b', sender_kind: 'human', content: 'first' },
      T0,
    );
    const q2 = store.enqueueMessage(
      { source_session_id: 's-a', target_session_id: 's-c', sender_kind: 'human', content: 'second' },
      T0 + 10,
    );
    const q3 = store.enqueueMessage(
      { source_session_id: 's-b', target_session_id: 's-a', sender_kind: 'human', content: 'third' },
      T0 + 20,
    );
    // Delivered — excluded from the queue.
    const d = store.enqueueMessage(
      { source_session_id: 's-a', target_session_id: 's-b', sender_kind: 'human', content: 'done' },
      T0 + 5,
    );
    store.markDelivered(d.message_id, T0 + 6);
    // Expired by timestamp — excluded.
    store.enqueueMessage(
      {
        source_session_id: 's-a',
        target_session_id: 's-b',
        sender_kind: 'human',
        content: 'stale',
        expires_at: T0 + 50,
      },
      T0 + 1,
    );

    const all = gatherControlSnapshot({ store, now: T0 + 100 });
    assert.deepEqual(
      all.inbox.map((m) => m.message_id),
      [q1.message_id, q2.message_id, q3.message_id],
    );

    const bounded = gatherControlSnapshot({ store, now: T0 + 100, limits: { inbox: 2 } });
    assert.deepEqual(
      bounded.inbox.map((m) => m.message_id),
      [q1.message_id, q2.message_id],
    );
  });
});

// ─── Active grants ──────────────────────────────────────────────────────────

describe('gatherControlSnapshot — active grants', () => {
  beforeEach(wipeControlTables);

  test('grants pane shows non-revoked unexpired grants, newest first, bounded', () => {
    const store = new ControlSessionStore();
    register(store, 's-a', 'fake', T0);
    register(store, 's-b', 'codex', T0);
    register(store, 's-c', 'lmstudio', T0);

    const g1 = store.grant(
      { source_session_id: 's-a', target_session_id: 's-b', ttl_ms: 60_000, max_messages: 5 },
      T0,
    );
    const g2 = store.grant(
      { source_session_id: 's-b', target_session_id: 's-a', ttl_ms: 60_000, max_messages: 5 },
      T0 + 100,
    );
    // Expired at gather time — excluded.
    store.grant(
      { source_session_id: 's-a', target_session_id: 's-c', ttl_ms: 10, max_messages: 5 },
      T0,
    );
    // Revoked — excluded.
    const revoked = store.grant(
      { source_session_id: 's-c', target_session_id: 's-a', ttl_ms: 60_000, max_messages: 5 },
      T0 + 200,
    );
    store.revoke(revoked.grant_id, T0 + 300);

    const snap = gatherControlSnapshot({ store, now: T0 + 1000 });
    assert.deepEqual(
      snap.grants.map((g) => g.grant_id),
      [g2.grant_id, g1.grant_id],
    );

    const bounded = gatherControlSnapshot({ store, now: T0 + 1000, limits: { grants: 1 } });
    assert.deepEqual(bounded.grants.map((g) => g.grant_id), [g2.grant_id]);
  });
});

// ─── Pending control actions (D-14) ─────────────────────────────────────────

describe('gatherControlSnapshot — pending control actions', () => {
  beforeEach(wipeControlTables);

  test('control_requested without a terminal event is pending', () => {
    const store = new ControlSessionStore();
    register(store, 's-a', 'fake', T0);
    store.appendEvent(
      {
        session_id: 's-a',
        event_type: 'control_requested',
        payload: { request_id: 'req-1', action: 'send' },
      },
      T0,
    );
    const snap = gatherControlSnapshot({ store, now: T0 + 10 });
    assert.equal(snap.pending_actions.length, 1);
    assert.equal(snap.pending_actions[0]!.payload['request_id'], 'req-1');
  });

  test('control_requested resolved by a terminal event with the same request_id is not pending', () => {
    const store = new ControlSessionStore();
    register(store, 's-a', 'fake', T0);
    store.appendEvent(
      {
        session_id: 's-a',
        event_type: 'control_requested',
        payload: { request_id: 'req-1', action: 'send' },
      },
      T0,
    );
    store.appendEvent(
      {
        session_id: 's-a',
        event_type: 'control_requested',
        payload: { request_id: 'req-2', action: 'interrupt' },
      },
      T0 + 1,
    );
    store.appendEvent(
      { session_id: 's-a', event_type: 'control_executed', payload: { request_id: 'req-1' } },
      T0 + 2,
    );
    store.appendEvent(
      { session_id: 's-a', event_type: 'control_denied', payload: { request_id: 'req-2' } },
      T0 + 3,
    );
    store.appendEvent(
      {
        session_id: 's-a',
        event_type: 'control_requested',
        payload: { request_id: 'req-3', action: 'spawn' },
      },
      T0 + 4,
    );
    const snap = gatherControlSnapshot({ store, now: T0 + 10 });
    assert.deepEqual(
      snap.pending_actions.map((e) => e.payload['request_id']),
      ['req-3'],
    );
  });

  test('requested events without a request_id stay visible as pending', () => {
    const store = new ControlSessionStore();
    register(store, 's-a', 'fake', T0);
    store.appendEvent(
      { session_id: 's-a', event_type: 'control_requested', payload: { action: 'send' } },
      T0,
    );
    const snap = gatherControlSnapshot({ store, now: T0 + 10 });
    assert.equal(snap.pending_actions.length, 1);
  });
});

// ─── Blocked events and audit ───────────────────────────────────────────────

describe('gatherControlSnapshot — blocked and audit panes', () => {
  beforeEach(wipeControlTables);

  test('blocked pane lists recent message_blocked events newest first, bounded', () => {
    const store = new ControlSessionStore();
    register(store, 's-a', 'fake', T0);
    for (let i = 0; i < 3; i++) {
      store.appendEvent(
        {
          session_id: 's-a',
          event_type: 'message_blocked',
          payload: { reason: 'grant_required', seq: i },
        },
        T0 + i,
      );
    }
    store.appendEvent({ session_id: 's-a', event_type: 'session_updated', payload: {} }, T0 + 99);

    const snap = gatherControlSnapshot({ store, now: T0 + 100, limits: { blocked: 2 } });
    assert.equal(snap.blocked.length, 2);
    assert.ok(snap.blocked.every((e) => e.event_type === 'message_blocked'));
    // Newest first → seq 2 then seq 1.
    assert.deepEqual(snap.blocked.map((e) => e.payload['seq']), [2, 1]);
  });

  test('audit lists recent events across sessions newest first, bounded', () => {
    const store = new ControlSessionStore();
    register(store, 's-a', 'fake', T0);
    register(store, 's-b', 'codex', T0);
    store.appendEvent({ session_id: 's-a', event_type: 'session_registered', payload: { seq: 0 } }, T0);
    store.appendEvent({ session_id: 's-b', event_type: 'session_registered', payload: { seq: 1 } }, T0 + 1);
    store.appendEvent({ session_id: 's-a', event_type: 'message_enqueued', payload: { seq: 2 } }, T0 + 2);
    store.appendEvent({ session_id: 's-b', event_type: 'message_delivered', payload: { seq: 3 } }, T0 + 3);

    const snap = gatherControlSnapshot({ store, now: T0 + 10, limits: { audit: 3 } });
    assert.deepEqual(snap.audit.map((e) => e.payload['seq']), [3, 2, 1]);
  });
});

// ─── Provider status summaries ──────────────────────────────────────────────

describe('gatherControlSnapshot — provider status summaries', () => {
  beforeEach(wipeControlTables);

  test('summaries roll up session counts by provider and state', () => {
    const store = new ControlSessionStore();
    register(store, uid('lm'), 'lmstudio', T0, 'active');
    register(store, uid('lm'), 'lmstudio', T0 + 1, 'active');
    register(store, uid('lm'), 'lmstudio', T0 + 2, 'ended');
    register(store, uid('cx'), 'codex', T0 + 3, 'idle');

    const snap = gatherControlSnapshot({ store, now: T0 + 10 });
    assert.deepEqual(
      snap.providers.map((p) => ({ ...p })),
      [
        { provider: 'codex', total: 1, active: 0, idle: 1, ended: 0 },
        { provider: 'lmstudio', total: 3, active: 2, idle: 0, ended: 1 },
      ],
    );
  });

  test('summaries count ALL sessions even when the roster is bounded below the total', () => {
    const store = new ControlSessionStore();
    register(store, uid('fk'), 'fake', T0, 'active');
    register(store, uid('fk'), 'fake', T0 + 1, 'active');
    register(store, uid('fk'), 'fake', T0 + 2, 'idle');

    const snap = gatherControlSnapshot({ store, now: T0 + 10, limits: { sessions: 1 } });
    assert.equal(snap.sessions.length, 1);
    assert.deepEqual(
      snap.providers.map((p) => ({ ...p })),
      [{ provider: 'fake', total: 3, active: 2, idle: 1, ended: 0 }],
    );
  });
});
