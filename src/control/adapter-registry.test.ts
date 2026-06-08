/**
 * Phase 8 / Plan 02 / Task 2 — adapter registry + deterministic fake adapter.
 *
 * Covers ControlAdapterRegistry registration (duplicate rejection),
 * capability-based send routing (preference-ordered overlap of session ∩
 * adapter capabilities), unsupported-operation RelayError output, and fake
 * A→B / B→A bidirectional delivery through the SAME broker + registry path
 * real adapters will use (D-01, D-03, CONTROL-01, CONTROL-03).
 *
 * The fake adapter is pure in-memory: no filesystem, no network, no
 * randomness. Tests share a single :memory: DB connection; unique
 * session/message IDs per test avoid cross-test bleed.
 */

process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';

import { ControlSessionStore } from './session-store.js';
import { ControlBroker } from './broker.js';
import type { ControlCapability } from './types.js';
import { ControlAdapterRegistry, createControlAdapterRegistry } from './adapter-registry.js';
import { FakeControlAdapter } from './adapters/fake.js';

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-r${counter}`;
}

function errCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code ?? 'NO_CODE';
  }
  return 'NO_THROW';
}

async function errCodeAsync(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return (err as { code?: string }).code ?? 'NO_CODE';
  }
  return 'NO_THROW';
}

const T0 = 1_770_000_000_000; // fixed epoch-ms base for deterministic clocks

function makeRig(): {
  store: ControlSessionStore;
  broker: ControlBroker;
  registry: ControlAdapterRegistry;
} {
  const store = new ControlSessionStore();
  const broker = new ControlBroker(store);
  return { store, broker, registry: new ControlAdapterRegistry(store, broker) };
}

function registerSession(
  store: ControlSessionStore,
  session_id: string,
  capabilities: readonly ControlCapability[],
): void {
  store.upsertSession({ session_id, provider: 'fake', capabilities }, T0);
}

// ─── Registration ───────────────────────────────────────────────────────────

describe('ControlAdapterRegistry — registration', () => {
  test('register + get returns the adapter; unknown providers return undefined', () => {
    const { registry } = makeRig();
    const adapter = new FakeControlAdapter();
    registry.register(adapter);
    assert.equal(registry.get('fake'), adapter);
    assert.equal(registry.get('codex'), undefined);
  });

  test('registering a second adapter for the same provider is rejected', () => {
    const { registry } = makeRig();
    registry.register(new FakeControlAdapter());
    const code = errCode(() => registry.register(new FakeControlAdapter()));
    assert.equal(code, 'CONTROL_ADAPTER_DUPLICATE');
  });

  test('list returns all registered adapters', () => {
    const { registry } = makeRig();
    const adapter = new FakeControlAdapter();
    registry.register(adapter);
    assert.deepEqual([...registry.list()], [adapter]);
  });

  test('createControlAdapterRegistry returns a working registry', () => {
    const registry = createControlAdapterRegistry();
    assert.ok(registry instanceof ControlAdapterRegistry);
  });
});

// ─── Routing and unsupported operations ─────────────────────────────────────

describe('ControlAdapterRegistry.deliverQueued — routing', () => {
  test('unregistered target session is refused with CONTROL_SESSION_NOT_FOUND', async () => {
    const { registry } = makeRig();
    registry.register(new FakeControlAdapter());
    const code = await errCodeAsync(() => registry.deliverQueued(uid('ghost'), T0 + 1));
    assert.equal(code, 'CONTROL_SESSION_NOT_FOUND');
  });

  test('a session whose provider has no adapter is refused with PROVIDER_NOT_CONFIGURED', async () => {
    const { store, registry } = makeRig();
    const target = uid('tgt');
    registerSession(store, target, ['register', 'mailbox']);
    const code = await errCodeAsync(() => registry.deliverQueued(target, T0 + 1));
    assert.equal(code, 'PROVIDER_NOT_CONFIGURED');
  });

  test('no shared delivery capability is refused with CONTROL_DELIVERY_UNSUPPORTED', async () => {
    const { store, registry } = makeRig();
    registry.register(new FakeControlAdapter(['register', 'tool_call'])); // no delivery capability
    const target = uid('tgt');
    registerSession(store, target, ['register', 'mailbox']);
    const code = await errCodeAsync(() => registry.deliverQueued(target, T0 + 1));
    assert.equal(code, 'CONTROL_DELIVERY_UNSUPPORTED');
  });

  test('an eligible session with an empty queue yields an empty report', async () => {
    const { store, registry } = makeRig();
    registry.register(new FakeControlAdapter());
    const target = uid('tgt');
    registerSession(store, target, ['register', 'mailbox']);
    const reports = await registry.deliverQueued(target, T0 + 1);
    assert.deepEqual([...reports], []);
  });

  test('routing uses the strongest shared delivery capability', async () => {
    const { store, broker, registry } = makeRig();
    registry.register(new FakeControlAdapter(['register', 'mailbox', 'live_stdin']));
    const target = uid('tgt');
    registerSession(store, target, ['register', 'mailbox', 'live_stdin']);
    broker.sendMessage(
      { source_session_id: uid('human'), target_session_id: target, sender_kind: 'human', content: 'strong path' },
      T0 + 1,
    );
    const reports = await registry.deliverQueued(target, T0 + 2);
    assert.equal(reports.length, 1);
    assert.equal(reports[0]!.ok, true);
    assert.equal(reports[0]!.capability, 'live_stdin');
    const attempts = store.listDeliveryAttempts(reports[0]!.message_id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.capability, 'live_stdin');
  });
});

// ─── Bidirectional delivery through the universal path ──────────────────────

describe('fake A→B / B→A delivery through broker + registry', () => {
  test('A→B: queued message reaches the fake inbox with full audit trail', async () => {
    const { store, broker, registry } = makeRig();
    const fake = new FakeControlAdapter();
    registry.register(fake);
    const a = uid('sess-a');
    const b = uid('sess-b');
    registerSession(store, a, ['register', 'mailbox', 'tool_call']);
    registerSession(store, b, ['register', 'mailbox', 'tool_call']);

    const sent = broker.sendMessage(
      { source_session_id: a, target_session_id: b, sender_kind: 'human', content: 'hello b' },
      T0 + 1,
    );
    const reports = await registry.deliverQueued(b, T0 + 2);

    assert.equal(reports.length, 1);
    assert.deepEqual(
      { message_id: reports[0]!.message_id, ok: reports[0]!.ok, capability: reports[0]!.capability },
      { message_id: sent.message_id, ok: true, capability: 'mailbox' },
    );
    const inbox = fake.getInbox(b);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]!.content, 'hello b');
    assert.equal(inbox[0]!.source_session_id, a);
    const stored = store.getMessage(sent.message_id);
    assert.ok(stored);
    assert.equal(stored.status, 'delivered');
    const attempts = store.listDeliveryAttempts(sent.message_id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.attempt_number, 1);
    assert.equal(attempts[0]!.status, 'success');
    const delivered = store.tailEvents(b).filter((e) => e.event_type === 'message_delivered');
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]!.payload['message_id'], sent.message_id);
  });

  test('messages flow bidirectionally (A→B then B→A) through the same path', async () => {
    const { store, broker, registry } = makeRig();
    const fake = new FakeControlAdapter();
    registry.register(fake);
    const a = uid('sess-a');
    const b = uid('sess-b');
    registerSession(store, a, ['register', 'mailbox', 'tool_call']);
    registerSession(store, b, ['register', 'mailbox', 'tool_call']);

    broker.sendMessage(
      { source_session_id: a, target_session_id: b, sender_kind: 'human', content: 'ping from a' },
      T0 + 1,
    );
    await registry.deliverQueued(b, T0 + 2);
    broker.sendMessage(
      { source_session_id: b, target_session_id: a, sender_kind: 'human', content: 'pong from b' },
      T0 + 3,
    );
    await registry.deliverQueued(a, T0 + 4);

    const inboxB = fake.getInbox(b);
    const inboxA = fake.getInbox(a);
    assert.equal(inboxB.length, 1);
    assert.equal(inboxB[0]!.content, 'ping from a');
    assert.equal(inboxA.length, 1);
    assert.equal(inboxA[0]!.content, 'pong from b');
  });

  test('a granted llm send is delivered end-to-end through the same path', async () => {
    const { store, broker, registry } = makeRig();
    const fake = new FakeControlAdapter();
    registry.register(fake);
    const a = uid('llm-a');
    const b = uid('llm-b');
    registerSession(store, a, ['register', 'mailbox', 'tool_call']);
    registerSession(store, b, ['register', 'mailbox', 'tool_call']);
    store.grant({ source_session_id: a, target_session_id: b, ttl_ms: 60_000, max_messages: 2 }, T0);

    const sent = broker.sendMessage(
      { source_session_id: a, target_session_id: b, sender_kind: 'llm', content: 'agent handoff' },
      T0 + 1,
    );
    const reports = await registry.deliverQueued(b, T0 + 2);

    assert.equal(reports.length, 1);
    assert.equal(reports[0]!.ok, true);
    assert.equal(fake.getInbox(b)[0]!.message_id, sent.message_id);
    const stored = store.getMessage(sent.message_id);
    assert.ok(stored);
    assert.equal(stored.status, 'delivered');
  });

  test('multiple queued messages are delivered oldest-first', async () => {
    const { store, broker, registry } = makeRig();
    const fake = new FakeControlAdapter();
    registry.register(fake);
    const target = uid('tgt');
    registerSession(store, target, ['register', 'mailbox']);
    const source = uid('human');
    broker.sendMessage(
      { source_session_id: source, target_session_id: target, sender_kind: 'human', content: 'first message' },
      T0 + 1,
    );
    broker.sendMessage(
      { source_session_id: source, target_session_id: target, sender_kind: 'human', content: 'second message' },
      T0 + 2,
    );
    const reports = await registry.deliverQueued(target, T0 + 3);
    assert.equal(reports.length, 2);
    assert.deepEqual(
      fake.getInbox(target).map((m) => m.content),
      ['first message', 'second message'],
    );
  });
});

// ─── Failure paths ──────────────────────────────────────────────────────────

describe('ControlAdapterRegistry.deliverQueued — failure handling', () => {
  test('a failing delivery marks the message failed with a recorded attempt and event', async () => {
    const { store, broker, registry } = makeRig();
    const fake = new FakeControlAdapter();
    registry.register(fake);
    const target = uid('tgt');
    registerSession(store, target, ['register', 'mailbox']);
    const sent = broker.sendMessage(
      { source_session_id: uid('human'), target_session_id: target, sender_kind: 'human', content: 'doomed' },
      T0 + 1,
    );
    fake.failNext('mailbox rejected the message');

    const reports = await registry.deliverQueued(target, T0 + 2);
    assert.equal(reports.length, 1);
    assert.equal(reports[0]!.ok, false);
    assert.equal(reports[0]!.detail, 'mailbox rejected the message');

    const stored = store.getMessage(sent.message_id);
    assert.ok(stored);
    assert.equal(stored.status, 'failed');
    assert.equal(stored.fail_reason, 'mailbox rejected the message');
    const attempts = store.listDeliveryAttempts(sent.message_id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.status, 'failure');
    const failed = store.tailEvents(target).filter((e) => e.event_type === 'message_failed');
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.payload['message_id'], sent.message_id);
    assert.equal(fake.getInbox(target).length, 0);
  });

  test('an adapter that throws is contained: message failed, attempt recorded', async () => {
    const { store, broker, registry } = makeRig();
    const fake = new FakeControlAdapter();
    registry.register(fake);
    const target = uid('tgt');
    registerSession(store, target, ['register', 'mailbox']);
    const sent = broker.sendMessage(
      { source_session_id: uid('human'), target_session_id: target, sender_kind: 'human', content: 'kaboom' },
      T0 + 1,
    );
    fake.throwNext('adapter exploded');

    const reports = await registry.deliverQueued(target, T0 + 2);
    assert.equal(reports.length, 1);
    assert.equal(reports[0]!.ok, false);
    assert.ok(reports[0]!.detail?.includes('adapter exploded'));

    const stored = store.getMessage(sent.message_id);
    assert.ok(stored);
    assert.equal(stored.status, 'failed');
    const attempts = store.listDeliveryAttempts(sent.message_id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.status, 'failure');
  });

  test('failure injection is one-shot: the next delivery succeeds', async () => {
    const { store, broker, registry } = makeRig();
    const fake = new FakeControlAdapter();
    registry.register(fake);
    const target = uid('tgt');
    registerSession(store, target, ['register', 'mailbox']);
    const source = uid('human');
    broker.sendMessage(
      { source_session_id: source, target_session_id: target, sender_kind: 'human', content: 'will fail' },
      T0 + 1,
    );
    fake.failNext('transient outage');
    await registry.deliverQueued(target, T0 + 2);

    broker.sendMessage(
      { source_session_id: source, target_session_id: target, sender_kind: 'human', content: 'will succeed' },
      T0 + 3,
    );
    const reports = await registry.deliverQueued(target, T0 + 4);
    assert.equal(reports.length, 1);
    assert.equal(reports[0]!.ok, true);
    assert.deepEqual(
      fake.getInbox(target).map((m) => m.content),
      ['will succeed'],
    );
  });
});

// ─── Fake adapter contract (D-01) ───────────────────────────────────────────

describe('FakeControlAdapter', () => {
  test('declares its provider and reports capabilities per instance (D-01)', () => {
    const fake = new FakeControlAdapter(['register', 'mailbox']);
    assert.equal(fake.provider, 'fake');
    assert.deepEqual([...fake.describeCapabilities()], ['register', 'mailbox']);
    assert.equal(fake.supports('mailbox'), true);
    assert.equal(fake.supports('live_stdin'), false);
  });

  test('getInbox returns an empty list for unknown sessions', () => {
    const fake = new FakeControlAdapter();
    assert.deepEqual([...fake.getInbox(uid('nobody'))], []);
  });

  test('two adapter instances have isolated in-memory inboxes', async () => {
    const { store, broker, registry } = makeRig();
    const wired = new FakeControlAdapter();
    const bystander = new FakeControlAdapter();
    registry.register(wired);
    const target = uid('tgt');
    registerSession(store, target, ['register', 'mailbox']);
    broker.sendMessage(
      { source_session_id: uid('human'), target_session_id: target, sender_kind: 'human', content: 'isolated' },
      T0 + 1,
    );
    await registry.deliverQueued(target, T0 + 2);
    assert.equal(wired.getInbox(target).length, 1);
    assert.equal(bystander.getInbox(target).length, 0);
  });
});
