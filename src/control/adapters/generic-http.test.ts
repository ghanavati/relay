/**
 * Phase 8 / Plan 04 / Task 3 — transcript-backed HTTP sessions.
 *
 * D-10 / CONTROL-09: OpenRouter and Anthropic sessions are Relay-stored
 * transcripts. `resume_send` = append the queued message as a user turn, make
 * a NEW provider request carrying the FULL transcript, persist user+assistant
 * turns. Provider errors become FAILED delivery events; sessions without a
 * configured model are refused — no hardcoded model fallbacks anywhere.
 *
 * No real network: globalThis.fetch is stubbed exactly like the existing
 * worker tests, which means the default completer exercises the REAL
 * OpenRouterRunner / AnthropicRunner request construction end-to-end.
 */

process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';

import { ControlSessionStore } from '../session-store.js';
import { ControlBroker } from '../broker.js';
import { ControlAdapterRegistry } from '../adapter-registry.js';
import {
  TranscriptHttpControlAdapter,
  TRANSCRIPT_SESSION_CAPABILITIES,
  type TranscriptProvider,
} from './generic-http.js';
import { GenericHttpRunner, type ChatTurn } from '../../workers/generic-http-runner.js';
import { AnthropicRunner } from '../../workers/anthropic.js';

const T0 = 1_780_200_000_000;

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-gh${counter}`;
}

function errCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code ?? 'NO_CODE';
  }
  return 'NO_THROW';
}

// ─── fetch capture harness (mirrors src/workers/*.test.ts) ──────────────────

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

type Responder = (req: CapturedRequest) => unknown;

function openRouterReply(text: string): unknown {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: text } }],
      usage: { total_tokens: 5, prompt_tokens: 3, completion_tokens: 2 },
    }),
  };
}

function anthropicReply(text: string): unknown {
  return {
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text }],
      usage: { input_tokens: 3, output_tokens: 2 },
    }),
  };
}

describe('transcript-backed HTTP sessions (openrouter + anthropic)', () => {
  let savedFetch: typeof fetch | undefined;
  let savedOR: string | undefined;
  let savedAnth: string | undefined;
  let captured: CapturedRequest[];

  function stubFetch(responder: Responder): void {
    (globalThis as { fetch?: typeof fetch }).fetch = (async (
      input: unknown,
      init?: { headers?: Record<string, string>; body?: unknown },
    ) => {
      const req: CapturedRequest = {
        url: String(input),
        headers: init?.headers ?? {},
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      };
      captured.push(req);
      const out = responder(req);
      if (out instanceof Error) throw out;
      return out as Response;
    }) as typeof fetch;
  }

  beforeEach(() => {
    savedFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    savedOR = process.env['OPENROUTER_API_KEY'];
    savedAnth = process.env['ANTHROPIC_API_KEY'];
    process.env['OPENROUTER_API_KEY'] = 'sk-or-test';
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';
    captured = [];
    stubFetch(() => {
      throw new Error('fetch not stubbed for this test');
    });
  });

  afterEach(() => {
    if (savedFetch) (globalThis as { fetch?: typeof fetch }).fetch = savedFetch;
    if (savedOR === undefined) delete process.env['OPENROUTER_API_KEY'];
    else process.env['OPENROUTER_API_KEY'] = savedOR;
    if (savedAnth === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = savedAnth;
  });

  function makeRig(provider: TranscriptProvider): {
    store: ControlSessionStore;
    broker: ControlBroker;
    registry: ControlAdapterRegistry;
    adapter: TranscriptHttpControlAdapter;
  } {
    const store = new ControlSessionStore();
    const broker = new ControlBroker(store);
    const registry = new ControlAdapterRegistry(store, broker);
    const adapter = new TranscriptHttpControlAdapter(provider, store, undefined, 5_000);
    registry.register(adapter);
    return { store, broker, registry, adapter };
  }

  // ── Session creation (D-10) ───────────────────────────────────────────────

  describe('createSession', () => {
    test('registers an idle transcript session with truthful non-live capabilities', () => {
      const { store, adapter } = makeRig('openrouter');
      const sessionId = uid('or');
      const session = adapter.createSession(
        { session_id: sessionId, model: 'vendor/some-model', label: 'analysis' },
        T0,
      );

      assert.equal(session.provider, 'openrouter');
      assert.equal(session.state, 'idle', 'D-10: stored transcript sessions are idle, not live');
      assert.equal(session.metadata?.['model'], 'vendor/some-model');
      assert.deepEqual([...session.capabilities], ['register', 'observe', 'tail', 'resume_send']);
      assert.deepEqual(
        [...TRANSCRIPT_SESSION_CAPABILITIES],
        ['register', 'observe', 'tail', 'resume_send'],
      );

      assert.equal(adapter.supports('resume_send'), true);
      assert.equal(adapter.supports('live_stdin'), false, 'no live process — no live_stdin');
      assert.equal(adapter.supports('interrupt'), false);
      assert.equal(adapter.supports('mailbox'), false);

      assert.deepEqual([...adapter.getTranscript(sessionId)], []);
      assert.equal(store.tailEvents(sessionId)[0]?.event_type, 'session_registered');
    });

    test('optional system prompt becomes the first transcript turn', () => {
      const { adapter } = makeRig('anthropic');
      const sessionId = uid('an');
      adapter.createSession({ session_id: sessionId, model: 'claude-test', system: 'be terse' }, T0);
      assert.deepEqual(
        [...adapter.getTranscript(sessionId)],
        [{ role: 'system', content: 'be terse' }],
      );
    });

    test('model is required — sessions cannot be created without one', () => {
      const { adapter } = makeRig('openrouter');
      assert.equal(errCode(() => adapter.createSession({ session_id: uid('or') }, T0)), 'INVALID_ARGS');
    });

    test('re-creating an existing session is refused (would wipe its transcript)', () => {
      const { adapter } = makeRig('openrouter');
      const sessionId = uid('or');
      adapter.createSession({ session_id: sessionId, model: 'vendor/m' }, T0);
      assert.equal(
        errCode(() => adapter.createSession({ session_id: sessionId, model: 'vendor/m2' }, T0 + 1)),
        'INVALID_ARGS',
      );
    });
  });

  // ── resume_send continuation (openrouter) ─────────────────────────────────

  describe('resume_send — Relay transcript continuation', () => {
    test('first send posts the user turn, persists user+assistant, marks delivered', async () => {
      const { store, broker, registry, adapter } = makeRig('openrouter');
      const sessionId = uid('or');
      adapter.createSession({ session_id: sessionId, model: 'vendor/some-model' }, T0);

      stubFetch(() => openRouterReply('reply-one'));

      const message = broker.sendMessage(
        {
          source_session_id: uid('human'),
          target_session_id: sessionId,
          sender_kind: 'human',
          content: 'first question',
        },
        T0 + 1,
      );

      const reports = await registry.deliverQueued(sessionId, T0 + 2);
      assert.equal(reports.length, 1);
      assert.equal(reports[0]?.ok, true);
      assert.equal(reports[0]?.capability, 'resume_send');

      assert.equal(captured.length, 1, 'exactly one provider request');
      assert.match(captured[0]!.url, /openrouter\.ai\/api\/v1\/chat\/completions/);
      assert.equal(captured[0]!.body['model'], 'vendor/some-model');
      assert.deepEqual(captured[0]!.body['messages'], [
        { role: 'user', content: 'first question' },
      ]);

      assert.deepEqual(
        [...adapter.getTranscript(sessionId)],
        [
          { role: 'user', content: 'first question' },
          { role: 'assistant', content: 'reply-one' },
        ],
      );
      assert.equal(store.getMessage(message.message_id)?.status, 'delivered');
      const attempts = store.listDeliveryAttempts(message.message_id);
      assert.equal(attempts[0]?.capability, 'resume_send');
      assert.equal(attempts[0]?.status, 'success');
    });

    test('follow-up send carries the FULL prior transcript to the provider', async () => {
      const { broker, registry, adapter } = makeRig('openrouter');
      const sessionId = uid('or');
      adapter.createSession({ session_id: sessionId, model: 'vendor/some-model' }, T0);

      stubFetch(() => openRouterReply('reply-one'));
      broker.sendMessage(
        {
          source_session_id: uid('human'),
          target_session_id: sessionId,
          sender_kind: 'human',
          content: 'first question',
        },
        T0 + 1,
      );
      await registry.deliverQueued(sessionId, T0 + 2);

      stubFetch(() => openRouterReply('reply-two'));
      broker.sendMessage(
        {
          source_session_id: uid('human'),
          target_session_id: sessionId,
          sender_kind: 'human',
          content: 'second question',
        },
        T0 + 3,
      );
      await registry.deliverQueued(sessionId, T0 + 4);

      const lastRequest = captured[captured.length - 1]!;
      assert.deepEqual(lastRequest.body['messages'], [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'reply-one' },
        { role: 'user', content: 'second question' },
      ]);
      assert.equal(adapter.getTranscript(sessionId).length, 4);
    });
  });

  // ── Provider errors → failed delivery events ──────────────────────────────

  describe('provider failures', () => {
    test('HTTP 500 becomes a failed delivery with a message_failed audit event; transcript untouched', async () => {
      const { store, broker, registry, adapter } = makeRig('openrouter');
      const sessionId = uid('or');
      adapter.createSession({ session_id: sessionId, model: 'vendor/some-model' }, T0);

      stubFetch(() => ({
        ok: false,
        status: 500,
        text: async () => 'upstream exploded',
      }));

      const message = broker.sendMessage(
        {
          source_session_id: uid('human'),
          target_session_id: sessionId,
          sender_kind: 'human',
          content: 'doomed question',
        },
        T0 + 1,
      );

      const reports = await registry.deliverQueued(sessionId, T0 + 2);
      assert.equal(reports[0]?.ok, false);
      assert.equal(reports[0]?.capability, 'resume_send');
      assert.match(reports[0]?.detail ?? '', /500/);

      const stored = store.getMessage(message.message_id);
      assert.equal(stored?.status, 'failed');
      assert.match(stored?.fail_reason ?? '', /500/);
      assert.deepEqual([...adapter.getTranscript(sessionId)], [], 'failed turn must not persist');

      const events = store.tailEvents(sessionId).map((e) => e.event_type);
      assert.ok(events.includes('message_failed'), `expected message_failed in ${events.join(',')}`);
    });

    test('network failure (fetch throws) becomes a failed delivery, transcript untouched', async () => {
      const { store, broker, registry, adapter } = makeRig('openrouter');
      const sessionId = uid('or');
      adapter.createSession({ session_id: sessionId, model: 'vendor/some-model' }, T0);

      stubFetch(() => new Error('ECONNREFUSED'));

      const message = broker.sendMessage(
        {
          source_session_id: uid('human'),
          target_session_id: sessionId,
          sender_kind: 'human',
          content: 'unreachable question',
        },
        T0 + 1,
      );

      const reports = await registry.deliverQueued(sessionId, T0 + 2);
      assert.equal(reports[0]?.ok, false);
      assert.equal(store.getMessage(message.message_id)?.status, 'failed');
      assert.equal(adapter.getTranscript(sessionId).length, 0);
    });

    test('missing OPENROUTER_API_KEY refuses delivery without any provider request', async () => {
      const { store, broker, registry, adapter } = makeRig('openrouter');
      const sessionId = uid('or');
      adapter.createSession({ session_id: sessionId, model: 'vendor/some-model' }, T0);

      const message = broker.sendMessage(
        {
          source_session_id: uid('human'),
          target_session_id: sessionId,
          sender_kind: 'human',
          content: 'no key question',
        },
        T0 + 1,
      );

      delete process.env['OPENROUTER_API_KEY'];
      const reports = await registry.deliverQueued(sessionId, T0 + 2);
      assert.equal(reports[0]?.ok, false);
      assert.match(reports[0]?.detail ?? '', /OPENROUTER_API_KEY/);
      assert.equal(captured.length, 0, 'no provider request without credentials');
      assert.equal(store.getMessage(message.message_id)?.status, 'failed');
    });
  });

  // ── No hardcoded model fallbacks ──────────────────────────────────────────

  describe('no hardcoded model fallbacks', () => {
    test('a session without a configured model refuses delivery and never calls the provider', async () => {
      const { store, broker, registry } = makeRig('openrouter');
      const sessionId = uid('or');
      // Bypass createSession (which requires model) to simulate a session
      // whose metadata lost its model — the adapter must refuse, not guess.
      store.upsertSession(
        {
          session_id: sessionId,
          provider: 'openrouter',
          capabilities: TRANSCRIPT_SESSION_CAPABILITIES,
          state: 'idle',
          metadata: { transcript: [] },
        },
        T0,
      );

      const message = broker.sendMessage(
        {
          source_session_id: uid('human'),
          target_session_id: sessionId,
          sender_kind: 'human',
          content: 'model-less question',
        },
        T0 + 1,
      );

      const reports = await registry.deliverQueued(sessionId, T0 + 2);
      assert.equal(reports[0]?.ok, false);
      assert.match(reports[0]?.detail ?? '', /model/);
      assert.match(reports[0]?.detail ?? '', /refusing to guess|no hardcoded/i);
      assert.equal(captured.length, 0, 'a fallback model must never be invented');
      assert.equal(store.getMessage(message.message_id)?.status, 'failed');
    });
  });

  // ── Anthropic flavor ──────────────────────────────────────────────────────

  describe('anthropic transcript sessions', () => {
    test('system turn maps to the top-level system field; user turn goes to messages', async () => {
      const { store, broker, registry, adapter } = makeRig('anthropic');
      const sessionId = uid('an');
      adapter.createSession(
        { session_id: sessionId, model: 'claude-test-model', system: 'be terse' },
        T0,
      );

      stubFetch(() => anthropicReply('short answer'));

      const message = broker.sendMessage(
        {
          source_session_id: uid('human'),
          target_session_id: sessionId,
          sender_kind: 'human',
          content: 'hi there',
        },
        T0 + 1,
      );

      const reports = await registry.deliverQueued(sessionId, T0 + 2);
      assert.equal(reports[0]?.ok, true);
      assert.equal(reports[0]?.capability, 'resume_send');

      assert.equal(captured.length, 1);
      assert.match(captured[0]!.url, /api\.anthropic\.com\/v1\/messages/);
      assert.equal(captured[0]!.headers['x-api-key'], 'sk-ant-test');
      assert.equal(captured[0]!.body['model'], 'claude-test-model');
      assert.equal(captured[0]!.body['system'], 'be terse');
      assert.deepEqual(captured[0]!.body['messages'], [{ role: 'user', content: 'hi there' }]);

      assert.deepEqual(
        [...adapter.getTranscript(sessionId)],
        [
          { role: 'system', content: 'be terse' },
          { role: 'user', content: 'hi there' },
          { role: 'assistant', content: 'short answer' },
        ],
      );
      assert.equal(store.getMessage(message.message_id)?.status, 'delivered');
    });

    test('missing ANTHROPIC_API_KEY refuses delivery without any provider request', async () => {
      const { broker, registry, adapter } = makeRig('anthropic');
      const sessionId = uid('an');
      adapter.createSession({ session_id: sessionId, model: 'claude-test-model' }, T0);

      broker.sendMessage(
        {
          source_session_id: uid('human'),
          target_session_id: sessionId,
          sender_kind: 'human',
          content: 'no key',
        },
        T0 + 1,
      );

      delete process.env['ANTHROPIC_API_KEY'];
      const reports = await registry.deliverQueued(sessionId, T0 + 2);
      assert.equal(reports[0]?.ok, false);
      assert.match(reports[0]?.detail ?? '', /ANTHROPIC_API_KEY/);
      assert.equal(captured.length, 0);
    });
  });

  // ── Direct runner units (multi-turn transport) ────────────────────────────

  describe('GenericHttpRunner.runMessages', () => {
    test('posts the messages array as-is with stream:false', async () => {
      stubFetch(() => openRouterReply('ok'));
      const runner = new GenericHttpRunner({
        providerName: 'test',
        getUrl: () => 'http://localhost:9999/v1/chat/completions',
        getHeaders: () => ({}),
        requiresModel: true,
      });

      const turns: ChatTurn[] = [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
      ];
      const result = await runner.runMessages(turns, { model: 'm-test', timeout_ms: 5_000 });
      assert.equal(result.status, 'success');
      assert.equal(result.output, 'ok');
      assert.equal(captured[0]!.body['model'], 'm-test');
      assert.equal(captured[0]!.body['stream'], false);
      assert.deepEqual(captured[0]!.body['messages'], turns);
    });

    test('responses request format is refused with UNSUPPORTED (no silent degrade)', async () => {
      const runner = new GenericHttpRunner({
        providerName: 'test',
        getUrl: () => 'http://localhost:9999/v1/responses',
        getHeaders: () => ({}),
        requiresModel: true,
        requestFormat: 'responses',
      });

      const result = await runner.runMessages([{ role: 'user', content: 'q' }], {
        model: 'm-test',
        timeout_ms: 5_000,
      });
      assert.equal(result.status, 'error');
      assert.equal(result.error?.code, 'UNSUPPORTED');
      assert.equal(captured.length, 0);
    });

    test('empty model is refused with INVALID_ARGS before any request', async () => {
      const runner = new GenericHttpRunner({
        providerName: 'test',
        getUrl: () => 'http://localhost:9999/v1/chat/completions',
        getHeaders: () => ({}),
        requiresModel: true,
      });
      const result = await runner.runMessages([{ role: 'user', content: 'q' }], {
        model: '   ',
        timeout_ms: 5_000,
      });
      assert.equal(result.status, 'error');
      assert.equal(result.error?.code, 'INVALID_ARGS');
      assert.equal(captured.length, 0);
    });
  });

  describe('AnthropicRunner.runMessages', () => {
    test('maps system turns to the top-level system field, preserving user/assistant order', async () => {
      stubFetch(() => anthropicReply('mapped'));
      const runner = new AnthropicRunner();
      const result = await runner.runMessages(
        [
          { role: 'system', content: 'sys-a' },
          { role: 'user', content: 'q1' },
          { role: 'assistant', content: 'a1' },
          { role: 'user', content: 'q2' },
        ],
        { model: 'claude-test', timeout_ms: 5_000 },
      );
      assert.equal(result.status, 'success');
      assert.equal(captured[0]!.body['system'], 'sys-a');
      assert.deepEqual(captured[0]!.body['messages'], [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
      ]);
    });

    test('transcript with only system turns is refused with INVALID_ARGS', async () => {
      const runner = new AnthropicRunner();
      const result = await runner.runMessages([{ role: 'system', content: 'sys only' }], {
        model: 'claude-test',
        timeout_ms: 5_000,
      });
      assert.equal(result.status, 'error');
      assert.equal(result.error?.code, 'INVALID_ARGS');
      assert.equal(captured.length, 0);
    });
  });
});
