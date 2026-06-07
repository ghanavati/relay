/**
 * Phase 8 / Plan 02 / Task 1 — policy-aware control broker.
 *
 * Covers ControlBroker.sendMessage policy (D-03/D-04: human sends to any
 * delivery-capable registered session, LLM sends default-deny without a
 * usable grant), grant TTL/budget enforcement with the budget decrement and
 * enqueue in ONE transaction, self-send blocking, normalized-content loop
 * detection, redaction before persistence (D-06), and audit events for
 * queued / blocked / delivered / failed (D-05, CONTROL-03/04/10).
 *
 * Tests share a single :memory: DB connection (module-level _db cache in
 * db.ts). Unique session/message IDs per test avoid cross-test bleed; loop
 * detection and budgets are pair-scoped so isolation holds.
 */

process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';

import { getDb } from '../runtime/store/db.js';
import { RELAY_ERROR_CODES, type ErrorCode } from '../errors.js';
import { ControlSessionStore } from './session-store.js';
import type { ControlCapability } from './types.js';
import {
  ControlBroker,
  createControlBroker,
  DELIVERY_CAPABILITY_PREFERENCE,
  LOOP_DETECTION_THRESHOLD,
  LOOP_DETECTION_WINDOW_MS,
  normalizeContent,
  normalizedContentHash,
  pickDeliveryCapability,
  redactControlContent,
} from './broker.js';

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-b${counter}`;
}

function errCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code ?? 'NO_CODE';
  }
  return 'NO_THROW';
}

const T0 = 1_760_000_000_000; // fixed epoch-ms base for deterministic clocks

function makeBroker(): { store: ControlSessionStore; broker: ControlBroker } {
  const store = new ControlSessionStore();
  return { store, broker: new ControlBroker(store) };
}

function registerSession(
  store: ControlSessionStore,
  session_id: string,
  capabilities: readonly ControlCapability[],
): void {
  store.upsertSession({ session_id, provider: 'fake', capabilities }, T0);
}

function blockedEvents(store: ControlSessionStore, session_id: string) {
  return store.tailEvents(session_id).filter((e) => e.event_type === 'message_blocked');
}

// ─── New error codes (errors.ts is owned by this plan) ─────────────────────

describe('control error codes', () => {
  test('all CONTROL_* codes are registered in RELAY_ERROR_CODES', () => {
    const expected: ErrorCode[] = [
      'CONTROL_SESSION_NOT_FOUND',
      'CONTROL_DELIVERY_UNSUPPORTED',
      'CONTROL_GRANT_REQUIRED',
      'CONTROL_GRANT_EXPIRED',
      'CONTROL_BUDGET_EXHAUSTED',
      'CONTROL_SELF_SEND_BLOCKED',
      'CONTROL_LOOP_DETECTED',
      'CONTROL_ADAPTER_DUPLICATE',
    ];
    for (const code of expected) {
      assert.ok(RELAY_ERROR_CODES.includes(code), `${code} missing from RELAY_ERROR_CODES`);
    }
  });
});

// ─── Normalization and hashing ──────────────────────────────────────────────

describe('normalized content hashing', () => {
  test('normalizeContent trims, collapses whitespace, and lowercases', () => {
    assert.equal(normalizeContent('  Hello \t  WORLD \n'), 'hello world');
  });

  test('normalizedContentHash equates whitespace/case variants', () => {
    assert.equal(normalizedContentHash('  Ping  Me '), normalizedContentHash('ping me'));
    assert.equal(normalizedContentHash('PING\nME'), normalizedContentHash('ping me'));
    assert.notEqual(normalizedContentHash('ping me'), normalizedContentHash('pong me'));
  });

  test('normalizedContentHash returns a lowercase sha256 hex digest', () => {
    assert.match(normalizedContentHash('x'), /^[a-f0-9]{64}$/);
  });
});

// ─── Redaction (D-06) ───────────────────────────────────────────────────────

describe('redactControlContent', () => {
  test('redacts known secret patterns and reports applied rules', () => {
    const result = redactControlContent('deploy key AKIAABCDEFGHIJKLMNOP done');
    assert.equal(result.content.includes('AKIAABCDEFGHIJKLMNOP'), false);
    assert.ok(result.content.includes('[REDACTED:AWS_KEY]'));
    assert.equal(result.redaction.applied, true);
    assert.ok(result.redaction.rules.includes('aws_key'));
  });

  test('clean content passes through with applied=false and no rules', () => {
    const result = redactControlContent('just a normal status update');
    assert.equal(result.content, 'just a normal status update');
    assert.equal(result.redaction.applied, false);
    assert.deepEqual([...result.redaction.rules], []);
  });
});

// ─── Delivery capability routing helpers ────────────────────────────────────

describe('delivery capability preference', () => {
  test('DELIVERY_CAPABILITY_PREFERENCE orders strongest to weakest', () => {
    assert.deepEqual(
      [...DELIVERY_CAPABILITY_PREFERENCE],
      ['live_stdin', 'resume_send', 'context_inject', 'mailbox'],
    );
  });

  test('pickDeliveryCapability picks the preference head of the overlap', () => {
    assert.equal(pickDeliveryCapability(['mailbox', 'live_stdin'], ['live_stdin', 'mailbox']), 'live_stdin');
    assert.equal(pickDeliveryCapability(['register', 'mailbox'], ['mailbox', 'tool_call']), 'mailbox');
  });

  test('pickDeliveryCapability returns undefined when there is no overlap', () => {
    assert.equal(pickDeliveryCapability(['mailbox'], ['live_stdin']), undefined);
    assert.equal(pickDeliveryCapability(['register', 'observe'], ['mailbox']), undefined);
  });
});

// ─── Human sends (D-04: user-initiated) ─────────────────────────────────────

describe('ControlBroker.sendMessage — human sends', () => {
  test('human send to a delivery-capable registered target queues the message', () => {
    const { store, broker } = makeBroker();
    const target = uid('tgt');
    registerSession(store, target, ['register', 'mailbox']);
    const source = uid('human'); // human sources need not be registered sessions
    const message = broker.sendMessage(
      { source_session_id: source, target_session_id: target, sender_kind: 'human', content: 'Hello Target' },
      T0 + 1,
    );
    assert.equal(message.status, 'queued');
    assert.equal(message.sender_kind, 'human');
    assert.equal(message.content, 'Hello Target');
    assert.equal(message.content_hash, normalizedContentHash('Hello Target'));
    assert.equal(Object.isFrozen(message), true);
    assert.ok(store.getMessage(message.message_id));
  });

  test('queued send appends a target-anchored message_enqueued audit event', () => {
    const { store, broker } = makeBroker();
    const target = uid('tgt');
    registerSession(store, target, ['register', 'mailbox']);
    const source = uid('human');
    const message = broker.sendMessage(
      { source_session_id: source, target_session_id: target, sender_kind: 'human', content: 'audit me' },
      T0 + 1,
    );
    const enqueued = store.tailEvents(target).filter((e) => e.event_type === 'message_enqueued');
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0]!.source_session_id, source);
    assert.equal(enqueued[0]!.target_session_id, target);
    assert.equal(enqueued[0]!.payload['message_id'], message.message_id);
    assert.equal(enqueued[0]!.payload['sender_kind'], 'human');
    assert.equal(enqueued[0]!.payload['content_hash'], message.content_hash);
  });

  test('human send to an unregistered target is blocked with CONTROL_SESSION_NOT_FOUND', () => {
    const { store, broker } = makeBroker();
    const source = uid('human');
    const target = uid('ghost');
    const code = errCode(() =>
      broker.sendMessage(
        { source_session_id: source, target_session_id: target, sender_kind: 'human', content: 'anyone there?' },
        T0 + 1,
      ),
    );
    assert.equal(code, 'CONTROL_SESSION_NOT_FOUND');
    const blocked = blockedEvents(store, source);
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0]!.payload['reason'], 'session_not_found');
    assert.equal(blocked[0]!.target_session_id, target);
  });

  test('human send to a target without any delivery capability is refused', () => {
    const { store, broker } = makeBroker();
    const target = uid('tgt');
    registerSession(store, target, ['register', 'observe']); // no delivery capability
    const source = uid('human');
    const code = errCode(() =>
      broker.sendMessage(
        { source_session_id: source, target_session_id: target, sender_kind: 'human', content: 'hello' },
        T0 + 1,
      ),
    );
    assert.equal(code, 'CONTROL_DELIVERY_UNSUPPORTED');
    const blocked = blockedEvents(store, source);
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0]!.payload['reason'], 'delivery_unsupported');
  });

  test('human sends are not loop-limited (D-04 scopes loop detection to llm sends)', () => {
    const { store, broker } = makeBroker();
    const target = uid('tgt');
    registerSession(store, target, ['register', 'mailbox']);
    const source = uid('human');
    for (let i = 1; i <= LOOP_DETECTION_THRESHOLD + 2; i += 1) {
      const message = broker.sendMessage(
        { source_session_id: source, target_session_id: target, sender_kind: 'human', content: 'continue' },
        T0 + i,
      );
      assert.equal(message.status, 'queued');
    }
  });

  test('a future expires_at is persisted on the queued message', () => {
    const { store, broker } = makeBroker();
    const target = uid('tgt');
    registerSession(store, target, ['register', 'mailbox']);
    const message = broker.sendMessage(
      {
        source_session_id: uid('human'),
        target_session_id: target,
        sender_kind: 'human',
        content: 'time-boxed',
        expires_at: T0 + 60_000,
      },
      T0 + 1,
    );
    assert.equal(message.expires_at, T0 + 60_000);
  });
});

// ─── Boundary validation ────────────────────────────────────────────────────

describe('ControlBroker.sendMessage — boundary validation', () => {
  test('malformed input throws INVALID_ARGS and appends no blocked event', () => {
    const { store, broker } = makeBroker();
    const source = uid('src');
    const code = errCode(() =>
      broker.sendMessage(
        { source_session_id: source, target_session_id: uid('tgt'), sender_kind: 'human' },
        T0 + 1,
      ),
    );
    assert.equal(code, 'INVALID_ARGS');
    assert.equal(store.tailEvents(source).length, 0);
  });

  test('caller-supplied content_hash is rejected (broker owns audit hashing)', () => {
    const { broker } = makeBroker();
    const code = errCode(() =>
      broker.sendMessage(
        {
          source_session_id: uid('src'),
          target_session_id: uid('tgt'),
          sender_kind: 'human',
          content: 'spoofed',
          content_hash: 'a'.repeat(64),
        },
        T0 + 1,
      ),
    );
    assert.equal(code, 'INVALID_ARGS');
  });

  test('caller-supplied redaction metadata is rejected (broker owns redaction)', () => {
    const { broker } = makeBroker();
    const code = errCode(() =>
      broker.sendMessage(
        {
          source_session_id: uid('src'),
          target_session_id: uid('tgt'),
          sender_kind: 'human',
          content: 'spoofed',
          redaction: { applied: true, rules: [] },
        },
        T0 + 1,
      ),
    );
    assert.equal(code, 'INVALID_ARGS');
  });

  test('expires_at at or before now is rejected as INVALID_ARGS', () => {
    const { store, broker } = makeBroker();
    const target = uid('tgt');
    registerSession(store, target, ['register', 'mailbox']);
    const code = errCode(() =>
      broker.sendMessage(
        {
          source_session_id: uid('src'),
          target_session_id: target,
          sender_kind: 'human',
          content: 'already stale',
          expires_at: T0,
        },
        T0,
      ),
    );
    assert.equal(code, 'INVALID_ARGS');
  });
});

// ─── Self-send blocking ─────────────────────────────────────────────────────

describe('ControlBroker.sendMessage — self-send blocking', () => {
  test('self-sends are blocked for human and llm senders', () => {
    const { store, broker } = makeBroker();
    const session = uid('self');
    registerSession(store, session, ['register', 'mailbox', 'tool_call']);
    const human = errCode(() =>
      broker.sendMessage(
        { source_session_id: session, target_session_id: session, sender_kind: 'human', content: 'echo' },
        T0 + 1,
      ),
    );
    const llm = errCode(() =>
      broker.sendMessage(
        { source_session_id: session, target_session_id: session, sender_kind: 'llm', content: 'echo' },
        T0 + 2,
      ),
    );
    assert.equal(human, 'CONTROL_SELF_SEND_BLOCKED');
    assert.equal(llm, 'CONTROL_SELF_SEND_BLOCKED');
    const blocked = blockedEvents(store, session);
    assert.equal(blocked.length, 2);
    assert.equal(blocked[0]!.payload['reason'], 'self_send');
    assert.equal(blocked[1]!.payload['reason'], 'self_send');
  });
});

// ─── LLM sends: default deny + grants (D-03/D-04) ───────────────────────────

describe('ControlBroker.sendMessage — llm default deny and grants', () => {
  function registerPair(store: ControlSessionStore): { source: string; target: string } {
    const source = uid('llm-src');
    const target = uid('llm-tgt');
    registerSession(store, source, ['register', 'tool_call', 'mailbox']);
    registerSession(store, target, ['register', 'mailbox']);
    return { source, target };
  }

  test('llm send without a grant is default-denied with CONTROL_GRANT_REQUIRED', () => {
    const { store, broker } = makeBroker();
    const { source, target } = registerPair(store);
    const code = errCode(() =>
      broker.sendMessage(
        { source_session_id: source, target_session_id: target, sender_kind: 'llm', content: 'let me in' },
        T0 + 1,
      ),
    );
    assert.equal(code, 'CONTROL_GRANT_REQUIRED');
    const blocked = blockedEvents(store, source);
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0]!.payload['reason'], 'grant_required');
  });

  test('llm send from an unregistered source session is blocked', () => {
    const { store, broker } = makeBroker();
    const target = uid('tgt');
    registerSession(store, target, ['register', 'mailbox']);
    const source = uid('ghost-llm');
    const code = errCode(() =>
      broker.sendMessage(
        { source_session_id: source, target_session_id: target, sender_kind: 'llm', content: 'hello' },
        T0 + 1,
      ),
    );
    assert.equal(code, 'CONTROL_SESSION_NOT_FOUND');
    const blocked = blockedEvents(store, source);
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0]!.payload['reason'], 'session_not_found');
  });

  test('llm send with a usable grant queues and decrements the budget', () => {
    const { store, broker } = makeBroker();
    const { source, target } = registerPair(store);
    store.grant(
      { source_session_id: source, target_session_id: target, ttl_ms: 60_000, max_messages: 3 },
      T0,
    );
    const message = broker.sendMessage(
      { source_session_id: source, target_session_id: target, sender_kind: 'llm', content: 'task update one' },
      T0 + 1,
    );
    assert.equal(message.status, 'queued');
    assert.equal(message.sender_kind, 'llm');
    const grant = store.getGrant(source, target);
    assert.ok(grant);
    assert.equal(grant.used_messages, 1);
  });

  test('llm send with an expired grant is denied with CONTROL_GRANT_EXPIRED', () => {
    const { store, broker } = makeBroker();
    const { source, target } = registerPair(store);
    store.grant(
      { source_session_id: source, target_session_id: target, ttl_ms: 1_000, max_messages: 3 },
      T0,
    );
    const code = errCode(() =>
      broker.sendMessage(
        { source_session_id: source, target_session_id: target, sender_kind: 'llm', content: 'too late' },
        T0 + 1_000, // expires_at = T0 + 1000; usable only while now < expires_at
      ),
    );
    assert.equal(code, 'CONTROL_GRANT_EXPIRED');
    const blocked = blockedEvents(store, source);
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0]!.payload['reason'], 'grant_expired');
  });

  test('llm sends beyond the message budget are denied with CONTROL_BUDGET_EXHAUSTED', () => {
    const { store, broker } = makeBroker();
    const { source, target } = registerPair(store);
    store.grant(
      { source_session_id: source, target_session_id: target, ttl_ms: 60_000, max_messages: 2 },
      T0,
    );
    broker.sendMessage(
      { source_session_id: source, target_session_id: target, sender_kind: 'llm', content: 'message one' },
      T0 + 1,
    );
    broker.sendMessage(
      { source_session_id: source, target_session_id: target, sender_kind: 'llm', content: 'message two' },
      T0 + 2,
    );
    const code = errCode(() =>
      broker.sendMessage(
        { source_session_id: source, target_session_id: target, sender_kind: 'llm', content: 'message three' },
        T0 + 3,
      ),
    );
    assert.equal(code, 'CONTROL_BUDGET_EXHAUSTED');
    const grant = store.getGrant(source, target);
    assert.ok(grant);
    assert.equal(grant.used_messages, 2);
    const blocked = blockedEvents(store, source);
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0]!.payload['reason'], 'budget_exhausted');
  });

  test('a revoked grant no longer authorizes llm sends', () => {
    const { store, broker } = makeBroker();
    const { source, target } = registerPair(store);
    const issued = store.grant(
      { source_session_id: source, target_session_id: target, ttl_ms: 60_000, max_messages: 3 },
      T0,
    );
    store.revoke(issued.grant_id, T0 + 1);
    const code = errCode(() =>
      broker.sendMessage(
        { source_session_id: source, target_session_id: target, sender_kind: 'llm', content: 'still here?' },
        T0 + 2,
      ),
    );
    assert.equal(code, 'CONTROL_GRANT_REQUIRED');
  });

  test('budget decrement and enqueue are one transaction — failed enqueue burns no budget', () => {
    const { store, broker } = makeBroker();
    const { source, target } = registerPair(store);
    store.grant(
      { source_session_id: source, target_session_id: target, ttl_ms: 60_000, max_messages: 5 },
      T0,
    );
    const message_id = uid('msg');
    broker.sendMessage(
      {
        message_id,
        source_session_id: source,
        target_session_id: target,
        sender_kind: 'llm',
        content: 'first send',
      },
      T0 + 1,
    );
    const duplicate = errCode(() =>
      broker.sendMessage(
        {
          message_id, // duplicate primary key → enqueue fails inside the txn
          source_session_id: source,
          target_session_id: target,
          sender_kind: 'llm',
          content: 'second send',
        },
        T0 + 2,
      ),
    );
    assert.equal(duplicate, 'INVALID_ARGS');
    const grant = store.getGrant(source, target);
    assert.ok(grant);
    assert.equal(grant.used_messages, 1); // increment rolled back with the failed enqueue
  });
});

// ─── checkGrant ─────────────────────────────────────────────────────────────

describe('ControlBroker.checkGrant', () => {
  test('returns no_grant when no grant exists for the pair', () => {
    const { broker } = makeBroker();
    const check = broker.checkGrant(uid('a'), uid('b'), T0);
    assert.deepEqual(check, { allowed: false, reason: 'no_grant' });
  });

  test('returns the grant when usable', () => {
    const { store, broker } = makeBroker();
    const source = uid('a');
    const target = uid('b');
    const issued = store.grant(
      { source_session_id: source, target_session_id: target, ttl_ms: 60_000, max_messages: 2 },
      T0,
    );
    const check = broker.checkGrant(source, target, T0 + 1);
    assert.equal(check.allowed, true);
    assert.ok(check.allowed && check.grant.grant_id === issued.grant_id);
  });

  test('returns expired when the TTL has passed', () => {
    const { store, broker } = makeBroker();
    const source = uid('a');
    const target = uid('b');
    store.grant(
      { source_session_id: source, target_session_id: target, ttl_ms: 1_000, max_messages: 2 },
      T0,
    );
    const check = broker.checkGrant(source, target, T0 + 1_000);
    assert.deepEqual(check, { allowed: false, reason: 'expired' });
  });

  test('returns exhausted when the budget is spent', () => {
    const { store, broker } = makeBroker();
    const source = uid('llm-src');
    const target = uid('llm-tgt');
    registerSession(store, source, ['register', 'tool_call']);
    registerSession(store, target, ['register', 'mailbox']);
    store.grant(
      { source_session_id: source, target_session_id: target, ttl_ms: 60_000, max_messages: 1 },
      T0,
    );
    broker.sendMessage(
      { source_session_id: source, target_session_id: target, sender_kind: 'llm', content: 'only one' },
      T0 + 1,
    );
    const check = broker.checkGrant(source, target, T0 + 2);
    assert.deepEqual(check, { allowed: false, reason: 'exhausted' });
  });

  test('returns no_grant after revocation', () => {
    const { store, broker } = makeBroker();
    const source = uid('a');
    const target = uid('b');
    const issued = store.grant(
      { source_session_id: source, target_session_id: target, ttl_ms: 60_000, max_messages: 2 },
      T0,
    );
    store.revoke(issued.grant_id, T0 + 1);
    const check = broker.checkGrant(source, target, T0 + 2);
    assert.deepEqual(check, { allowed: false, reason: 'no_grant' });
  });
});

// ─── Loop detection (D-04) ──────────────────────────────────────────────────

describe('ControlBroker.sendMessage — loop detection', () => {
  function grantedPair(
    store: ControlSessionStore,
    opts?: { max_messages?: number; ttl_ms?: number },
  ): { source: string; target: string } {
    const source = uid('loop-src');
    const target = uid('loop-tgt');
    registerSession(store, source, ['register', 'tool_call', 'mailbox']);
    registerSession(store, target, ['register', 'mailbox', 'tool_call']);
    store.grant(
      {
        source_session_id: source,
        target_session_id: target,
        ttl_ms: opts?.ttl_ms ?? LOOP_DETECTION_WINDOW_MS + 120_000,
        max_messages: opts?.max_messages ?? 20,
      },
      T0,
    );
    return { source, target };
  }

  test('an llm message repeating the same content past the threshold is blocked', () => {
    const { store, broker } = makeBroker();
    const { source, target } = grantedPair(store);
    for (let i = 1; i <= LOOP_DETECTION_THRESHOLD; i += 1) {
      broker.sendMessage(
        { source_session_id: source, target_session_id: target, sender_kind: 'llm', content: 'sync now' },
        T0 + i,
      );
    }
    const code = errCode(() =>
      broker.sendMessage(
        { source_session_id: source, target_session_id: target, sender_kind: 'llm', content: 'sync now' },
        T0 + LOOP_DETECTION_THRESHOLD + 1,
      ),
    );
    assert.equal(code, 'CONTROL_LOOP_DETECTED');
    const blocked = blockedEvents(store, source);
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0]!.payload['reason'], 'loop_detected');
    const grant = store.getGrant(source, target);
    assert.ok(grant);
    assert.equal(grant.used_messages, LOOP_DETECTION_THRESHOLD); // blocked send burned no budget
  });

  test('loop detection matches whitespace/case variants via normalized hashing', () => {
    const { store, broker } = makeBroker();
    const { source, target } = grantedPair(store);
    const variants = ['Sync   NOW', ' sync now ', 'SYNC\nNOW'];
    variants.forEach((content, i) => {
      broker.sendMessage(
        { source_session_id: source, target_session_id: target, sender_kind: 'llm', content },
        T0 + i + 1,
      );
    });
    const code = errCode(() =>
      broker.sendMessage(
        { source_session_id: source, target_session_id: target, sender_kind: 'llm', content: 'sync now' },
        T0 + 10,
      ),
    );
    assert.equal(code, 'CONTROL_LOOP_DETECTED');
  });

  test('loop counting is bidirectional per session pair (ping-pong)', () => {
    const { store, broker } = makeBroker();
    const a = uid('loop-a');
    const b = uid('loop-b');
    registerSession(store, a, ['register', 'tool_call', 'mailbox']);
    registerSession(store, b, ['register', 'tool_call', 'mailbox']);
    store.grant({ source_session_id: a, target_session_id: b, ttl_ms: 60_000, max_messages: 10 }, T0);
    store.grant({ source_session_id: b, target_session_id: a, ttl_ms: 60_000, max_messages: 10 }, T0);
    broker.sendMessage(
      { source_session_id: a, target_session_id: b, sender_kind: 'llm', content: 'ping' },
      T0 + 1,
    );
    broker.sendMessage(
      { source_session_id: a, target_session_id: b, sender_kind: 'llm', content: 'ping' },
      T0 + 2,
    );
    broker.sendMessage(
      { source_session_id: b, target_session_id: a, sender_kind: 'llm', content: 'ping' },
      T0 + 3,
    );
    const code = errCode(() =>
      broker.sendMessage(
        { source_session_id: b, target_session_id: a, sender_kind: 'llm', content: 'ping' },
        T0 + 4,
      ),
    );
    assert.equal(code, 'CONTROL_LOOP_DETECTED');
  });

  test('identical content outside the detection window is allowed again', () => {
    const { store, broker } = makeBroker();
    const { source, target } = grantedPair(store);
    for (let i = 1; i <= LOOP_DETECTION_THRESHOLD; i += 1) {
      broker.sendMessage(
        { source_session_id: source, target_session_id: target, sender_kind: 'llm', content: 'heartbeat' },
        T0 + i,
      );
    }
    const later = T0 + LOOP_DETECTION_WINDOW_MS + 60_000;
    const message = broker.sendMessage(
      { source_session_id: source, target_session_id: target, sender_kind: 'llm', content: 'heartbeat' },
      later,
    );
    assert.equal(message.status, 'queued');
  });

  test('different content from the same pair is unaffected by a loop block', () => {
    const { store, broker } = makeBroker();
    const { source, target } = grantedPair(store);
    for (let i = 1; i <= LOOP_DETECTION_THRESHOLD; i += 1) {
      broker.sendMessage(
        { source_session_id: source, target_session_id: target, sender_kind: 'llm', content: 'same thing' },
        T0 + i,
      );
    }
    assert.equal(
      errCode(() =>
        broker.sendMessage(
          { source_session_id: source, target_session_id: target, sender_kind: 'llm', content: 'same thing' },
          T0 + 10,
        ),
      ),
      'CONTROL_LOOP_DETECTED',
    );
    const message = broker.sendMessage(
      { source_session_id: source, target_session_id: target, sender_kind: 'llm', content: 'a fresh update' },
      T0 + 11,
    );
    assert.equal(message.status, 'queued');
  });
});

// ─── Redaction before persistence (D-06) ────────────────────────────────────

describe('ControlBroker.sendMessage — redaction before persistence', () => {
  test('secrets are redacted before the message row is written', () => {
    const { store, broker } = makeBroker();
    const target = uid('tgt');
    registerSession(store, target, ['register', 'mailbox']);
    const raw = 'rotate AKIAABCDEFGHIJKLMNOP before friday';
    const message = broker.sendMessage(
      { source_session_id: uid('human'), target_session_id: target, sender_kind: 'human', content: raw },
      T0 + 1,
    );
    assert.equal(message.content.includes('AKIAABCDEFGHIJKLMNOP'), false);
    assert.ok(message.content.includes('[REDACTED:AWS_KEY]'));
    assert.equal(message.redaction.applied, true);
    assert.ok(message.redaction.rules.includes('aws_key'));
    const expected = redactControlContent(raw);
    assert.equal(message.content_hash, normalizedContentHash(expected.content));
    const rawRow = getDb()
      .prepare('SELECT content FROM control_mailbox WHERE message_id = ?')
      .get(message.message_id) as { content: string };
    assert.equal(rawRow.content.includes('AKIAABCDEFGHIJKLMNOP'), false);
  });

  test('clean content records redaction applied=false with no rules', () => {
    const { store, broker } = makeBroker();
    const target = uid('tgt');
    registerSession(store, target, ['register', 'mailbox']);
    const message = broker.sendMessage(
      { source_session_id: uid('human'), target_session_id: target, sender_kind: 'human', content: 'plain note' },
      T0 + 1,
    );
    assert.equal(message.redaction.applied, false);
    assert.deepEqual([...message.redaction.rules], []);
  });

  test('blocked sends persist no content; the blocked event carries only the hash', () => {
    const { store, broker } = makeBroker();
    const source = uid('human');
    const target = uid('ghost');
    const raw = 'secret token=abcdefghijklmnopqrstuvwxyz123456 leaked';
    assert.equal(
      errCode(() =>
        broker.sendMessage(
          { source_session_id: source, target_session_id: target, sender_kind: 'human', content: raw },
          T0 + 1,
        ),
      ),
      'CONTROL_SESSION_NOT_FOUND',
    );
    const expected = redactControlContent(raw);
    const hash = normalizedContentHash(expected.content);
    const count = (
      getDb()
        .prepare('SELECT COUNT(*) AS n FROM control_mailbox WHERE content_hash = ?')
        .get(hash) as { n: number }
    ).n;
    assert.equal(count, 0);
    const blocked = blockedEvents(store, source);
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0]!.payload['content_hash'], hash);
    assert.equal('content' in blocked[0]!.payload, false);
  });
});

// ─── Delivered / failed audit wrappers (D-05) ───────────────────────────────

describe('ControlBroker.markDelivered / markFailed', () => {
  function queueOne(store: ControlSessionStore, broker: ControlBroker): {
    target: string;
    message_id: string;
  } {
    const target = uid('tgt');
    registerSession(store, target, ['register', 'mailbox']);
    const message = broker.sendMessage(
      { source_session_id: uid('human'), target_session_id: target, sender_kind: 'human', content: 'deliver me' },
      T0 + 1,
    );
    return { target, message_id: message.message_id };
  }

  test('markDelivered transitions the message and appends a target-anchored event', () => {
    const { store, broker } = makeBroker();
    const { target, message_id } = queueOne(store, broker);
    const message = broker.markDelivered(message_id, { capability: 'mailbox', now: T0 + 5 });
    assert.equal(message.status, 'delivered');
    const events = store.tailEvents(target).filter((e) => e.event_type === 'message_delivered');
    assert.equal(events.length, 1);
    assert.equal(events[0]!.payload['message_id'], message_id);
    assert.equal(events[0]!.payload['capability'], 'mailbox');
  });

  test('markFailed records the reason and appends a message_failed event', () => {
    const { store, broker } = makeBroker();
    const { target, message_id } = queueOne(store, broker);
    const message = broker.markFailed(message_id, 'adapter exploded', { now: T0 + 5 });
    assert.equal(message.status, 'failed');
    assert.equal(message.fail_reason, 'adapter exploded');
    const events = store.tailEvents(target).filter((e) => e.event_type === 'message_failed');
    assert.equal(events.length, 1);
    assert.equal(events[0]!.payload['message_id'], message_id);
    assert.equal(events[0]!.payload['reason'], 'adapter exploded');
  });

  test('markDelivered on an unknown message throws', () => {
    const { broker } = makeBroker();
    assert.equal(errCode(() => broker.markDelivered(uid('nope'), { now: T0 })), 'RUN_NOT_FOUND');
  });
});

// ─── Construction and synchrony ─────────────────────────────────────────────

describe('ControlBroker — construction', () => {
  test('createControlBroker returns a working broker', () => {
    const broker = createControlBroker();
    assert.ok(broker instanceof ControlBroker);
  });

  test('broker methods are synchronous (never return Promises)', () => {
    const { store, broker } = makeBroker();
    const target = uid('tgt');
    registerSession(store, target, ['register', 'mailbox']);
    const message = broker.sendMessage(
      { source_session_id: uid('human'), target_session_id: target, sender_kind: 'human', content: 'sync api' },
      T0 + 1,
    );
    assert.equal(message instanceof Promise, false);
    assert.equal(broker.checkGrant(uid('a'), uid('b'), T0) instanceof Promise, false);
    assert.equal(broker.markDelivered(message.message_id, { now: T0 + 2 }) instanceof Promise, false);
  });
});
