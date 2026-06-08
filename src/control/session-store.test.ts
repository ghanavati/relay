/**
 * Phase 8 / Plan 01 / Task 2 — synchronous SQLite control store.
 *
 * Covers the five v4 tables (control_sessions, control_events,
 * control_mailbox, control_grants, control_delivery_attempts) and the
 * ControlSessionStore surface: upsertSession, getSession, listSessions,
 * appendEvent, tailEvents, enqueueMessage, getQueuedMessages, delivery
 * status transitions, grant, revoke, getGrant (D-02, D-05, CONTROL-02).
 *
 * Tests share a single :memory: DB connection (module-level _db cache in
 * db.ts). Unique session/message IDs per test avoid cross-test bleed.
 */

process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { getDb } from '../runtime/store/db.js';
import { readSchemaVersion } from '../runtime/store/schema-version.js';
import { ControlSessionStore } from './session-store.js';

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

function errCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code ?? 'NO_CODE';
  }
  return 'NO_THROW';
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

const T0 = 1_750_000_000_000; // fixed epoch-ms base for deterministic clocks

function registerPair(store: ControlSessionStore): { a: string; b: string } {
  const a = uid('sess-a');
  const b = uid('sess-b');
  store.upsertSession(
    { session_id: a, provider: 'lmstudio', capabilities: ['register', 'mailbox', 'tool_call'] },
    T0,
  );
  store.upsertSession(
    { session_id: b, provider: 'claude-code', capabilities: ['register', 'mailbox', 'context_inject'] },
    T0,
  );
  return { a, b };
}

// ─── Migration (v4) ─────────────────────────────────────────────────────────

describe('v4 migration — control tables', () => {
  test('all five control tables exist after store init', () => {
    new ControlSessionStore();
    const tables = (
      getDb()
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'control_%' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    assert.deepEqual(tables, [
      'control_delivery_attempts',
      'control_events',
      'control_grants',
      'control_mailbox',
      'control_sessions',
    ]);
  });

  test('schema version is stamped at 4', () => {
    new ControlSessionStore();
    assert.equal(readSchemaVersion(getDb()), 4);
  });
});

// ─── Sessions (CONTROL-01) ──────────────────────────────────────────────────

describe('ControlSessionStore — session registry', () => {
  test('upsertSession inserts with default active state and stamped timestamps', () => {
    const store = new ControlSessionStore();
    const id = uid('sess');
    const session = store.upsertSession(
      {
        session_id: id,
        provider: 'codex',
        capabilities: ['register', 'observe', 'mailbox'],
        label: 'codex cli',
        workdir: '/tmp/proj',
      },
      T0,
    );
    assert.equal(session.session_id, id);
    assert.equal(session.provider, 'codex');
    assert.equal(session.state, 'active');
    assert.deepEqual([...session.capabilities], ['register', 'observe', 'mailbox']);
    assert.equal(session.label, 'codex cli');
    assert.equal(session.workdir, '/tmp/proj');
    assert.equal(session.registered_at, T0);
    assert.equal(session.last_seen_at, T0);
  });

  test('returned session objects are frozen (immutability)', () => {
    const store = new ControlSessionStore();
    const id = uid('sess');
    const session = store.upsertSession(
      { session_id: id, provider: 'fake', capabilities: ['register'] },
      T0,
    );
    assert.equal(Object.isFrozen(session), true);
    const fetched = store.getSession(id);
    assert.ok(fetched);
    assert.equal(Object.isFrozen(fetched), true);
  });

  test('upsertSession update preserves registered_at and bumps last_seen_at', () => {
    const store = new ControlSessionStore();
    const id = uid('sess');
    store.upsertSession({ session_id: id, provider: 'lmstudio', capabilities: ['register'] }, T0);
    const updated = store.upsertSession(
      {
        session_id: id,
        provider: 'lmstudio',
        capabilities: ['register', 'tool_call'],
        state: 'idle',
        label: 'renamed',
      },
      T0 + 5_000,
    );
    assert.equal(updated.registered_at, T0);
    assert.equal(updated.last_seen_at, T0 + 5_000);
    assert.equal(updated.state, 'idle');
    assert.equal(updated.label, 'renamed');
    assert.deepEqual([...updated.capabilities], ['register', 'tool_call']);
  });

  test('upsertSession deduplicates repeated capabilities', () => {
    const store = new ControlSessionStore();
    const id = uid('sess');
    const session = store.upsertSession(
      { session_id: id, provider: 'fake', capabilities: ['register', 'register', 'mailbox'] },
      T0,
    );
    assert.deepEqual([...session.capabilities], ['register', 'mailbox']);
  });

  test('upsertSession rejects malformed input with INVALID_ARGS', () => {
    const store = new ControlSessionStore();
    assert.equal(
      errCode(() => store.upsertSession({ provider: 'fake', capabilities: ['register'] }, T0)),
      'INVALID_ARGS',
      'missing session_id',
    );
    assert.equal(
      errCode(() =>
        store.upsertSession({ session_id: uid('s'), provider: 'fake', capabilities: ['mind_control'] }, T0),
      ),
      'INVALID_ARGS',
      'unknown capability',
    );
    assert.equal(
      errCode(() => store.upsertSession({ session_id: uid('s'), provider: 'fake', capabilities: [] }, T0)),
      'INVALID_ARGS',
      'empty capability set',
    );
    assert.equal(
      errCode(() =>
        store.upsertSession({ session_id: uid('s'), provider: 'skynet', capabilities: ['register'] }, T0),
      ),
      'INVALID_ARGS',
      'unknown provider',
    );
  });

  test('getSession returns undefined for unknown id', () => {
    const store = new ControlSessionStore();
    assert.equal(store.getSession(uid('missing')), undefined);
  });

  test('getSession rejects rows whose capabilities JSON is not valid JSON', () => {
    const store = new ControlSessionStore();
    const id = uid('sess');
    store.upsertSession({ session_id: id, provider: 'fake', capabilities: ['register'] }, T0);
    getDb().prepare('UPDATE control_sessions SET capabilities_json = ? WHERE session_id = ?').run('{nope', id);
    assert.equal(errCode(() => store.getSession(id)), 'CONFIG_ERROR');
  });

  test('getSession rejects rows whose capabilities JSON holds non-taxonomy values', () => {
    const store = new ControlSessionStore();
    const id = uid('sess');
    store.upsertSession({ session_id: id, provider: 'fake', capabilities: ['register'] }, T0);
    getDb()
      .prepare('UPDATE control_sessions SET capabilities_json = ? WHERE session_id = ?')
      .run(JSON.stringify(['mind_control']), id);
    assert.equal(errCode(() => store.getSession(id)), 'CONFIG_ERROR');
  });

  test('listSessions filters by provider and state', () => {
    const store = new ControlSessionStore();
    const provider = 'openrouter';
    const active = uid('sess-or');
    const ended = uid('sess-or');
    store.upsertSession({ session_id: active, provider, capabilities: ['register', 'resume_send'] }, T0);
    store.upsertSession(
      { session_id: ended, provider, capabilities: ['register'], state: 'ended' },
      T0,
    );

    const byProvider = store.listSessions({ provider });
    const ids = byProvider.map((s) => s.session_id);
    assert.ok(ids.includes(active) && ids.includes(ended));
    for (const s of byProvider) assert.equal(s.provider, provider);

    const activeOnly = store.listSessions({ provider, state: 'active' });
    assert.deepEqual(activeOnly.map((s) => s.session_id), [active]);
  });
});

// ─── Events (CONTROL-02, D-05) ──────────────────────────────────────────────

describe('ControlSessionStore — append-ordered events and tail', () => {
  test('appendEvent returns the stored event with monotonic id and payload round-trip', () => {
    const store = new ControlSessionStore();
    const { a, b } = registerPair(store);
    const event = store.appendEvent(
      {
        session_id: a,
        event_type: 'message_enqueued',
        source_session_id: a,
        target_session_id: b,
        payload: { content_hash: 'abc', note: 42 },
      },
      T0,
    );
    assert.ok(event.id >= 1);
    assert.equal(event.event_type, 'message_enqueued');
    assert.equal(event.source_session_id, a);
    assert.equal(event.target_session_id, b);
    assert.deepEqual(event.payload, { content_hash: 'abc', note: 42 });
    assert.equal(event.created_at, T0);
    assert.equal(Object.isFrozen(event), true);
  });

  test('appendEvent rejects unknown event types with INVALID_ARGS', () => {
    const store = new ControlSessionStore();
    const { a } = registerPair(store);
    assert.equal(
      errCode(() => store.appendEvent({ session_id: a, event_type: 'mystery' }, T0)),
      'INVALID_ARGS',
    );
  });

  test('tailEvents returns session events ordered by id with cursor and limit', () => {
    const store = new ControlSessionStore();
    const { a, b } = registerPair(store);
    const e1 = store.appendEvent({ session_id: a, event_type: 'session_registered' }, T0);
    const e2 = store.appendEvent({ session_id: a, event_type: 'message_enqueued' }, T0 + 1);
    const e3 = store.appendEvent({ session_id: a, event_type: 'message_delivered' }, T0 + 2);
    store.appendEvent({ session_id: b, event_type: 'session_registered' }, T0 + 3);

    const all = store.tailEvents(a);
    assert.deepEqual(all.map((e) => e.id), [e1.id, e2.id, e3.id]);

    const afterFirst = store.tailEvents(a, { after_id: e1.id });
    assert.deepEqual(afterFirst.map((e) => e.id), [e2.id, e3.id]);

    const limited = store.tailEvents(a, { limit: 2 });
    assert.deepEqual(limited.map((e) => e.id), [e1.id, e2.id]);
  });
});

// ─── Mailbox (D-04/D-05/D-06) ───────────────────────────────────────────────

describe('ControlSessionStore — mailbox enqueue and queue reads', () => {
  test('enqueueMessage stores a queued message with computed sha256 content hash', () => {
    const store = new ControlSessionStore();
    const { a, b } = registerPair(store);
    const message = store.enqueueMessage(
      { source_session_id: a, target_session_id: b, sender_kind: 'llm', content: 'run the tests' },
      T0,
    );
    assert.equal(message.status, 'queued');
    assert.equal(message.content_hash, sha256('run the tests'));
    assert.deepEqual(message.redaction, { applied: false, rules: [] });
    assert.equal(message.created_at, T0);
    assert.equal(message.updated_at, T0);
    assert.equal(Object.isFrozen(message), true);
  });

  test('enqueueMessage honors an explicit broker-supplied content hash', () => {
    const store = new ControlSessionStore();
    const { a, b } = registerPair(store);
    const explicit = sha256('normalized form');
    const message = store.enqueueMessage(
      {
        source_session_id: a,
        target_session_id: b,
        sender_kind: 'human',
        content: 'Normalized   FORM',
        content_hash: explicit,
        redaction: { applied: true, rules: ['secret-scrub'] },
      },
      T0,
    );
    assert.equal(message.content_hash, explicit);
    assert.deepEqual(message.redaction, { applied: true, rules: ['secret-scrub'] });
  });

  test('enqueueMessage rejects sends missing source, target, or content', () => {
    const store = new ControlSessionStore();
    const { a, b } = registerPair(store);
    assert.equal(
      errCode(() => store.enqueueMessage({ target_session_id: b, sender_kind: 'llm', content: 'x' }, T0)),
      'INVALID_ARGS',
    );
    assert.equal(
      errCode(() => store.enqueueMessage({ source_session_id: a, sender_kind: 'llm', content: 'x' }, T0)),
      'INVALID_ARGS',
    );
    assert.equal(
      errCode(() =>
        store.enqueueMessage({ source_session_id: a, target_session_id: b, sender_kind: 'llm' }, T0),
      ),
      'INVALID_ARGS',
    );
  });

  test('enqueueMessage rejects duplicate message ids', () => {
    const store = new ControlSessionStore();
    const { a, b } = registerPair(store);
    const message_id = uid('msg');
    store.enqueueMessage(
      { message_id, source_session_id: a, target_session_id: b, sender_kind: 'human', content: 'one' },
      T0,
    );
    assert.equal(
      errCode(() =>
        store.enqueueMessage(
          { message_id, source_session_id: a, target_session_id: b, sender_kind: 'human', content: 'two' },
          T0,
        ),
      ),
      'INVALID_ARGS',
    );
  });

  test('getQueuedMessages returns only queued, unexpired messages for the target in order', () => {
    const store = new ControlSessionStore();
    const { a, b } = registerPair(store);
    const m1 = store.enqueueMessage(
      { source_session_id: a, target_session_id: b, sender_kind: 'llm', content: 'first' },
      T0,
    );
    const m2 = store.enqueueMessage(
      { source_session_id: a, target_session_id: b, sender_kind: 'llm', content: 'second' },
      T0 + 1,
    );
    // Different target — must not appear.
    store.enqueueMessage(
      { source_session_id: b, target_session_id: a, sender_kind: 'llm', content: 'other-direction' },
      T0 + 2,
    );
    // Already expired at read time — must not appear.
    store.enqueueMessage(
      {
        source_session_id: a,
        target_session_id: b,
        sender_kind: 'llm',
        content: 'stale',
        expires_at: T0 + 5,
      },
      T0 + 3,
    );

    const queued = store.getQueuedMessages(b, T0 + 10);
    assert.deepEqual(queued.map((m) => m.message_id), [m1.message_id, m2.message_id]);
  });
});

describe('ControlSessionStore — delivery status transitions', () => {
  test('queued → delivered → acknowledged transitions update status and updated_at', () => {
    const store = new ControlSessionStore();
    const { a, b } = registerPair(store);
    const m = store.enqueueMessage(
      { source_session_id: a, target_session_id: b, sender_kind: 'human', content: 'hi' },
      T0,
    );
    const delivered = store.markDelivered(m.message_id, T0 + 10);
    assert.equal(delivered.status, 'delivered');
    assert.equal(delivered.updated_at, T0 + 10);

    const acked = store.markAcknowledged(m.message_id, T0 + 20);
    assert.equal(acked.status, 'acknowledged');
    assert.equal(acked.updated_at, T0 + 20);
  });

  test('markFailed records the failure reason and removes the message from the queue', () => {
    const store = new ControlSessionStore();
    const { a, b } = registerPair(store);
    const m = store.enqueueMessage(
      { source_session_id: a, target_session_id: b, sender_kind: 'human', content: 'doomed' },
      T0,
    );
    const failed = store.markFailed(m.message_id, 'adapter unreachable', T0 + 10);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.fail_reason, 'adapter unreachable');
    assert.equal(
      store.getQueuedMessages(b, T0 + 20).some((q) => q.message_id === m.message_id),
      false,
    );
  });

  test('markExpired moves a queued message to expired', () => {
    const store = new ControlSessionStore();
    const { a, b } = registerPair(store);
    const m = store.enqueueMessage(
      { source_session_id: a, target_session_id: b, sender_kind: 'llm', content: 'ttl', expires_at: T0 + 5 },
      T0,
    );
    const expired = store.markExpired(m.message_id, T0 + 10);
    assert.equal(expired.status, 'expired');
  });

  test('illegal transitions are rejected with INVALID_ARGS', () => {
    const store = new ControlSessionStore();
    const { a, b } = registerPair(store);
    const m = store.enqueueMessage(
      { source_session_id: a, target_session_id: b, sender_kind: 'human', content: 'strict' },
      T0,
    );
    // queued → acknowledged skips delivery.
    assert.equal(errCode(() => store.markAcknowledged(m.message_id, T0 + 1)), 'INVALID_ARGS');

    store.markDelivered(m.message_id, T0 + 2);
    store.markAcknowledged(m.message_id, T0 + 3);
    // acknowledged is terminal.
    assert.equal(errCode(() => store.markFailed(m.message_id, 'too late', T0 + 4)), 'INVALID_ARGS');
    assert.equal(errCode(() => store.markDelivered(m.message_id, T0 + 5)), 'INVALID_ARGS');
  });

  test('transitions on unknown messages report not-found', () => {
    const store = new ControlSessionStore();
    assert.equal(errCode(() => store.markDelivered(uid('missing-msg'), T0)), 'RUN_NOT_FOUND');
  });
});

// ─── Grants (D-04) ──────────────────────────────────────────────────────────

describe('ControlSessionStore — grants, revocation, and budgets', () => {
  test('grant issues a TTL-bound budgeted grant and getGrant returns it', () => {
    const store = new ControlSessionStore();
    const { a, b } = registerPair(store);
    const g = store.grant(
      { source_session_id: a, target_session_id: b, ttl_ms: 60_000, max_messages: 3 },
      T0,
    );
    assert.equal(g.expires_at, T0 + 60_000);
    assert.equal(g.max_messages, 3);
    assert.equal(g.used_messages, 0);
    assert.equal(g.revoked_at, null);
    assert.equal(Object.isFrozen(g), true);

    const fetched = store.getGrant(a, b);
    assert.ok(fetched);
    assert.equal(fetched.grant_id, g.grant_id);
  });

  test('getGrant returns undefined when no grant exists for the pair', () => {
    const store = new ControlSessionStore();
    const { a, b } = registerPair(store);
    assert.equal(store.getGrant(a, b), undefined);
  });

  test('grant rejects malformed input with INVALID_ARGS', () => {
    const store = new ControlSessionStore();
    const { a, b } = registerPair(store);
    assert.equal(
      errCode(() => store.grant({ source_session_id: a, target_session_id: b, ttl_ms: 0, max_messages: 1 }, T0)),
      'INVALID_ARGS',
    );
  });

  test('revoke stamps revoked_at and getGrant no longer returns the grant', () => {
    const store = new ControlSessionStore();
    const { a, b } = registerPair(store);
    const g = store.grant(
      { source_session_id: a, target_session_id: b, ttl_ms: 60_000, max_messages: 3 },
      T0,
    );
    const revoked = store.revoke(g.grant_id, T0 + 100);
    assert.equal(revoked.revoked_at, T0 + 100);
    assert.equal(store.getGrant(a, b), undefined);
  });

  test('revoke on unknown grant reports not-found', () => {
    const store = new ControlSessionStore();
    assert.equal(errCode(() => store.revoke(uid('missing-grant'), T0)), 'RUN_NOT_FOUND');
  });

  test('incrementGrantUsage consumes budget and refuses past the cap (D-04)', () => {
    const store = new ControlSessionStore();
    const { a, b } = registerPair(store);
    const g = store.grant(
      { source_session_id: a, target_session_id: b, ttl_ms: 60_000, max_messages: 2 },
      T0,
    );
    assert.equal(store.incrementGrantUsage(g.grant_id, T0 + 1), true);
    assert.equal(store.incrementGrantUsage(g.grant_id, T0 + 2), true);
    assert.equal(store.incrementGrantUsage(g.grant_id, T0 + 3), false, 'budget exhausted');
    const after = store.getGrant(a, b);
    assert.ok(after);
    assert.equal(after.used_messages, 2);
  });

  test('incrementGrantUsage refuses expired and revoked grants', () => {
    const store = new ControlSessionStore();
    const { a, b } = registerPair(store);
    const g = store.grant(
      { source_session_id: a, target_session_id: b, ttl_ms: 1_000, max_messages: 5 },
      T0,
    );
    assert.equal(store.incrementGrantUsage(g.grant_id, T0 + 2_000), false, 'expired (TTL passed)');

    const g2 = store.grant(
      { source_session_id: a, target_session_id: b, ttl_ms: 60_000, max_messages: 5 },
      T0,
    );
    store.revoke(g2.grant_id, T0 + 1);
    assert.equal(store.incrementGrantUsage(g2.grant_id, T0 + 2), false, 'revoked');
  });
});

// ─── Delivery attempts (D-05) ───────────────────────────────────────────────

describe('ControlSessionStore — delivery attempt audit', () => {
  test('recordDeliveryAttempt auto-increments attempt_number per message', () => {
    const store = new ControlSessionStore();
    const { a, b } = registerPair(store);
    const m = store.enqueueMessage(
      { source_session_id: a, target_session_id: b, sender_kind: 'human', content: 'retry me' },
      T0,
    );
    const first = store.recordDeliveryAttempt(
      { message_id: m.message_id, capability: 'mailbox', status: 'failure', detail: 'timeout' },
      T0 + 1,
    );
    const second = store.recordDeliveryAttempt(
      { message_id: m.message_id, capability: 'mailbox', status: 'success' },
      T0 + 2,
    );
    assert.equal(first.attempt_number, 1);
    assert.equal(second.attempt_number, 2);
    assert.equal(first.detail, 'timeout');
    assert.equal(second.detail, null);

    const attempts = store.listDeliveryAttempts(m.message_id);
    assert.deepEqual(attempts.map((x) => x.attempt_number), [1, 2]);
    assert.equal(Object.isFrozen(attempts[0]), true);
  });

  test('recordDeliveryAttempt rejects attempts for unknown messages', () => {
    const store = new ControlSessionStore();
    assert.equal(
      errCode(() =>
        store.recordDeliveryAttempt(
          { message_id: uid('missing-msg'), capability: 'mailbox', status: 'success' },
          T0,
        ),
      ),
      'RUN_NOT_FOUND',
    );
  });

  test('recordDeliveryAttempt rejects capabilities outside the closed set', () => {
    const store = new ControlSessionStore();
    const { a, b } = registerPair(store);
    const m = store.enqueueMessage(
      { source_session_id: a, target_session_id: b, sender_kind: 'human', content: 'x' },
      T0,
    );
    assert.equal(
      errCode(() =>
        store.recordDeliveryAttempt(
          { message_id: m.message_id, capability: 'carrier_pigeon', status: 'success' },
          T0,
        ),
      ),
      'INVALID_ARGS',
    );
  });
});

// ─── Synchronous semantics ──────────────────────────────────────────────────

describe('ControlSessionStore — synchronous better-sqlite3 semantics', () => {
  test('store methods return values, never Promises', () => {
    const store = new ControlSessionStore();
    const { a, b } = registerPair(store);
    const session = store.upsertSession(
      { session_id: uid('sync'), provider: 'fake', capabilities: ['register'] },
      T0,
    );
    const message = store.enqueueMessage(
      { source_session_id: a, target_session_id: b, sender_kind: 'human', content: 'sync' },
      T0,
    );
    const events = store.tailEvents(a);
    for (const value of [session, message, events]) {
      assert.equal(value instanceof Promise, false);
    }
  });
});
