/**
 * Phase 8 / Plan 01 / Task 1 — universal control types and capability taxonomy.
 *
 * Pins the D-01 contract: control capabilities are an explicit CLOSED set
 * reported per adapter, never inferred from provider names. Also pins the
 * boundary schemas: malformed sessions and LLM sends missing source, target,
 * or content must be rejected at the Zod boundary (D-05, CONTROL-01).
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  CONTROL_CAPABILITIES,
  CONTROL_PROVIDERS,
  CONTROL_SESSION_STATES,
  CONTROL_MESSAGE_STATUSES,
  CONTROL_SENDER_KINDS,
  CONTROL_EVENT_TYPES,
  DELIVERY_ATTEMPT_STATUSES,
  MAX_CONTROL_CONTENT_CHARS,
  ControlCapabilitySchema,
  ControlProviderSchema,
  ControlSessionStateSchema,
  ControlMessageStatusSchema,
  ControlSessionInputSchema,
  ControlSessionSchema,
  ControlSendInputSchema,
  ControlEventInputSchema,
  ControlGrantInputSchema,
  DeliveryAttemptInputSchema,
  type ControlAdapter,
  type ControlCapability,
  type ControlMessage,
  type ControlSession,
  type DeliveryOutcome,
} from './types.js';

// ─── Capability taxonomy (D-01) ─────────────────────────────────────────────

describe('control capability taxonomy', () => {
  test('closed set contains exactly the 11 RESEARCH.md capabilities in order', () => {
    assert.deepEqual(
      [...CONTROL_CAPABILITIES],
      [
        'register',
        'observe',
        'tail',
        'context_inject',
        'mailbox',
        'resume_send',
        'live_stdin',
        'interrupt',
        'fork',
        'spawn',
        'tool_call',
      ],
    );
  });

  test('schema accepts every declared capability', () => {
    for (const cap of CONTROL_CAPABILITIES) {
      assert.equal(
        ControlCapabilitySchema.safeParse(cap).success,
        true,
        `capability "${cap}" must parse`,
      );
    }
  });

  test('schema rejects capabilities outside the closed set', () => {
    for (const bad of ['mind_control', '', 'REGISTER', 'live-stdin', 'stdin']) {
      assert.equal(
        ControlCapabilitySchema.safeParse(bad).success,
        false,
        `"${bad}" must be rejected`,
      );
    }
  });
});

// ─── Providers and session states (CONTROL-01) ──────────────────────────────

describe('control providers and session states', () => {
  test('providers cover exactly the six CONTROL-01 surfaces', () => {
    assert.deepEqual(
      [...CONTROL_PROVIDERS],
      ['claude-code', 'codex', 'lmstudio', 'openrouter', 'anthropic', 'fake'],
    );
  });

  test('provider schema rejects unknown providers', () => {
    for (const bad of ['gemini', '', 'cc', 'Claude-Code']) {
      assert.equal(ControlProviderSchema.safeParse(bad).success, false);
    }
  });

  test('session states are a closed set', () => {
    assert.deepEqual([...CONTROL_SESSION_STATES], ['active', 'idle', 'ended']);
  });

  test('session state schema rejects unknown states', () => {
    for (const bad of ['running', 'paused', '', 'ACTIVE']) {
      assert.equal(ControlSessionStateSchema.safeParse(bad).success, false);
    }
  });

  test('message statuses are a closed set', () => {
    assert.deepEqual(
      [...CONTROL_MESSAGE_STATUSES],
      ['queued', 'delivered', 'acknowledged', 'failed', 'expired'],
    );
  });

  test('message status schema rejects unknown statuses', () => {
    for (const bad of ['pending', 'sent', '', 'QUEUED']) {
      assert.equal(ControlMessageStatusSchema.safeParse(bad).success, false);
    }
  });

  test('sender kinds distinguish human and llm initiators (D-04)', () => {
    assert.deepEqual([...CONTROL_SENDER_KINDS], ['human', 'llm']);
  });

  test('delivery attempt statuses are a closed set', () => {
    assert.deepEqual([...DELIVERY_ATTEMPT_STATUSES], ['success', 'failure']);
  });

  test('event types cover session, message, grant, delivery, and control lifecycles (D-05, D-14)', () => {
    assert.deepEqual(
      [...CONTROL_EVENT_TYPES],
      [
        'session_registered',
        'session_updated',
        'session_ended',
        'message_enqueued',
        'message_blocked',
        'message_delivered',
        'message_acknowledged',
        'message_failed',
        'message_expired',
        'grant_issued',
        'grant_revoked',
        'delivery_attempted',
        'control_requested',
        'control_approved',
        'control_denied',
        'control_executed',
      ],
    );
  });
});

// ─── Session boundary schema (CONTROL-01) ───────────────────────────────────

function validSessionInput(): Record<string, unknown> {
  return {
    session_id: 'sess-1',
    provider: 'lmstudio',
    capabilities: ['register', 'observe', 'tool_call'],
    label: 'qwen agentic loop',
    workdir: '/tmp/project',
    metadata: { transcript_path: '/tmp/t.jsonl' },
  };
}

describe('ControlSessionInputSchema boundary validation', () => {
  test('valid session input parses with state defaulting to active', () => {
    const parsed = ControlSessionInputSchema.parse(validSessionInput());
    assert.equal(parsed.session_id, 'sess-1');
    assert.equal(parsed.provider, 'lmstudio');
    assert.equal(parsed.state, 'active');
    assert.deepEqual([...parsed.capabilities], ['register', 'observe', 'tool_call']);
  });

  test('parsed session input is frozen (immutability)', () => {
    const parsed = ControlSessionInputSchema.parse(validSessionInput());
    assert.equal(Object.isFrozen(parsed), true);
  });

  test('rejects session missing session_id', () => {
    const input = validSessionInput();
    delete input['session_id'];
    assert.equal(ControlSessionInputSchema.safeParse(input).success, false);
  });

  test('rejects session with empty session_id', () => {
    const input = { ...validSessionInput(), session_id: '' };
    assert.equal(ControlSessionInputSchema.safeParse(input).success, false);
  });

  test('rejects session with unknown provider', () => {
    const input = { ...validSessionInput(), provider: 'skynet' };
    assert.equal(ControlSessionInputSchema.safeParse(input).success, false);
  });

  test('rejects session with capability outside the closed set', () => {
    const input = { ...validSessionInput(), capabilities: ['register', 'mind_control'] };
    assert.equal(ControlSessionInputSchema.safeParse(input).success, false);
  });

  test('rejects session with empty capability set (D-01: adapters must report capabilities)', () => {
    const input = { ...validSessionInput(), capabilities: [] };
    assert.equal(ControlSessionInputSchema.safeParse(input).success, false);
  });

  test('rejects session with capabilities as non-array', () => {
    const input = { ...validSessionInput(), capabilities: 'register' };
    assert.equal(ControlSessionInputSchema.safeParse(input).success, false);
  });

  test('rejects session with unknown extra keys (strict)', () => {
    const input = { ...validSessionInput(), is_admin: true };
    assert.equal(ControlSessionInputSchema.safeParse(input).success, false);
  });

  test('rejects session with non-JSON metadata values', () => {
    const input = { ...validSessionInput(), metadata: { cb: () => 'nope' } };
    assert.equal(ControlSessionInputSchema.safeParse(input).success, false);
  });

  test('full ControlSessionSchema rejects malformed capability payloads', () => {
    const full = {
      session_id: 'sess-1',
      provider: 'codex',
      capabilities: ['not_a_capability'],
      state: 'active',
      label: null,
      workdir: null,
      pid: null,
      metadata: null,
      registered_at: 1,
      last_seen_at: 1,
    };
    assert.equal(ControlSessionSchema.safeParse(full).success, false);
  });
});

// ─── Send boundary schema (D-04/D-05) ───────────────────────────────────────

function validSendInput(): Record<string, unknown> {
  return {
    source_session_id: 'sess-a',
    target_session_id: 'sess-b',
    sender_kind: 'llm',
    content: 'please run the tests',
  };
}

describe('ControlSendInputSchema boundary validation', () => {
  test('valid send input parses', () => {
    const parsed = ControlSendInputSchema.parse(validSendInput());
    assert.equal(parsed.source_session_id, 'sess-a');
    assert.equal(parsed.target_session_id, 'sess-b');
    assert.equal(parsed.sender_kind, 'llm');
    assert.equal(parsed.content, 'please run the tests');
  });

  test('rejects send missing source', () => {
    const input = validSendInput();
    delete input['source_session_id'];
    assert.equal(ControlSendInputSchema.safeParse(input).success, false);
  });

  test('rejects send missing target', () => {
    const input = validSendInput();
    delete input['target_session_id'];
    assert.equal(ControlSendInputSchema.safeParse(input).success, false);
  });

  test('rejects send missing content', () => {
    const input = validSendInput();
    delete input['content'];
    assert.equal(ControlSendInputSchema.safeParse(input).success, false);
  });

  test('rejects send with empty content', () => {
    const input = { ...validSendInput(), content: '' };
    assert.equal(ControlSendInputSchema.safeParse(input).success, false);
  });

  test('rejects send with oversized content', () => {
    const input = { ...validSendInput(), content: 'x'.repeat(MAX_CONTROL_CONTENT_CHARS + 1) };
    assert.equal(ControlSendInputSchema.safeParse(input).success, false);
  });

  test('rejects send with invalid sender_kind', () => {
    const input = { ...validSendInput(), sender_kind: 'system' };
    assert.equal(ControlSendInputSchema.safeParse(input).success, false);
  });

  test('rejects send with malformed content_hash', () => {
    const input = { ...validSendInput(), content_hash: 'not-a-sha256' };
    assert.equal(ControlSendInputSchema.safeParse(input).success, false);
  });

  test('rejects send with unknown extra keys (strict)', () => {
    const input = { ...validSendInput(), bypass_policy: true };
    assert.equal(ControlSendInputSchema.safeParse(input).success, false);
  });
});

// ─── Event / grant / delivery-attempt boundary schemas ──────────────────────

describe('ControlEventInputSchema boundary validation', () => {
  test('valid event input parses with payload defaulting to empty object', () => {
    const parsed = ControlEventInputSchema.parse({
      session_id: 'sess-a',
      event_type: 'session_registered',
    });
    assert.deepEqual(parsed.payload, {});
  });

  test('rejects unknown event_type', () => {
    const result = ControlEventInputSchema.safeParse({
      session_id: 'sess-a',
      event_type: 'mystery_event',
    });
    assert.equal(result.success, false);
  });

  test('rejects non-JSON payload values', () => {
    const result = ControlEventInputSchema.safeParse({
      session_id: 'sess-a',
      event_type: 'message_enqueued',
      payload: { when: new Date() },
    });
    assert.equal(result.success, false);
  });
});

describe('ControlGrantInputSchema boundary validation (D-04)', () => {
  test('valid grant input parses', () => {
    const parsed = ControlGrantInputSchema.parse({
      source_session_id: 'sess-a',
      target_session_id: 'sess-b',
      ttl_ms: 60_000,
      max_messages: 5,
    });
    assert.equal(parsed.ttl_ms, 60_000);
    assert.equal(parsed.max_messages, 5);
  });

  test('rejects non-positive ttl_ms', () => {
    for (const ttl of [0, -1, 1.5]) {
      const result = ControlGrantInputSchema.safeParse({
        source_session_id: 'a',
        target_session_id: 'b',
        ttl_ms: ttl,
        max_messages: 5,
      });
      assert.equal(result.success, false, `ttl_ms=${ttl} must be rejected`);
    }
  });

  test('rejects max_messages below 1', () => {
    const result = ControlGrantInputSchema.safeParse({
      source_session_id: 'a',
      target_session_id: 'b',
      ttl_ms: 1000,
      max_messages: 0,
    });
    assert.equal(result.success, false);
  });
});

describe('DeliveryAttemptInputSchema boundary validation (D-05)', () => {
  test('valid delivery attempt parses', () => {
    const parsed = DeliveryAttemptInputSchema.parse({
      message_id: 'msg-1',
      capability: 'mailbox',
      status: 'success',
    });
    assert.equal(parsed.capability, 'mailbox');
  });

  test('rejects delivery attempt with unknown capability', () => {
    const result = DeliveryAttemptInputSchema.safeParse({
      message_id: 'msg-1',
      capability: 'carrier_pigeon',
      status: 'success',
    });
    assert.equal(result.success, false);
  });

  test('rejects delivery attempt with unknown status', () => {
    const result = DeliveryAttemptInputSchema.safeParse({
      message_id: 'msg-1',
      capability: 'mailbox',
      status: 'maybe',
    });
    assert.equal(result.success, false);
  });
});

// ─── ControlAdapter contract (D-01) ─────────────────────────────────────────

function makeAdapter(provider: ControlSession['provider'], caps: readonly ControlCapability[]): ControlAdapter {
  return {
    provider,
    describeCapabilities(): readonly ControlCapability[] {
      return caps;
    },
    supports(capability: ControlCapability): boolean {
      return caps.includes(capability);
    },
    deliver(_message: ControlMessage, _session: ControlSession): Promise<DeliveryOutcome> {
      return Promise.resolve({ ok: true, capability: 'mailbox' });
    },
  };
}

describe('ControlAdapter capability reporting (D-01)', () => {
  test('capabilities come from the adapter declaration, not the provider name', () => {
    // Two adapters for the SAME provider with DIFFERENT capability sets:
    // supports() must reflect each declaration independently.
    const ambient = makeAdapter('claude-code', ['register', 'observe', 'mailbox', 'context_inject']);
    const owned = makeAdapter('claude-code', ['register', 'observe', 'mailbox', 'resume_send', 'fork']);

    assert.equal(ambient.supports('resume_send'), false);
    assert.equal(owned.supports('resume_send'), true);
    assert.equal(ambient.supports('mailbox'), true);
    assert.equal(owned.supports('fork'), true);
    assert.equal(ambient.supports('live_stdin'), false);
    assert.equal(owned.supports('live_stdin'), false);
  });

  test('describeCapabilities returns the declared closed-set members', () => {
    const adapter = makeAdapter('fake', ['register', 'mailbox']);
    assert.deepEqual([...adapter.describeCapabilities()], ['register', 'mailbox']);
  });

  test('deliver resolves a DeliveryOutcome naming the capability used', async () => {
    const adapter = makeAdapter('fake', ['register', 'mailbox']);
    const session = ControlSessionSchema.parse({
      session_id: 'sess-b',
      provider: 'fake',
      capabilities: ['register', 'mailbox'],
      state: 'active',
      label: null,
      workdir: null,
      pid: null,
      metadata: null,
      registered_at: 1,
      last_seen_at: 1,
    });
    const message = {
      message_id: 'msg-1',
      source_session_id: 'sess-a',
      target_session_id: 'sess-b',
      sender_kind: 'human',
      content: 'hello',
      content_hash: 'a'.repeat(64),
      status: 'queued',
      redaction: { applied: false, rules: [] },
      fail_reason: null,
      expires_at: null,
      created_at: 1,
      updated_at: 1,
    } as const satisfies ControlMessage;
    const outcome = await adapter.deliver(message, session);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.capability, 'mailbox');
  });
});
