/**
 * Phase 8 / Plan 03 / Task 2 — LLM-facing Relay control tools.
 *
 * Covers the five OpenAI-compatible tool declarations + handlers
 * (relay_session_list / relay_session_inspect / relay_session_send /
 * relay_inbox_read / relay_inbox_ack), caller session scoping (source is
 * ALWAYS the caller; inbox access is caller-only), grant enforcement through
 * the broker (D-04 default-deny, budgets), the lmstudio-agentic run control
 * session lifecycle (D-08, CONTROL-07), and dispatch through
 * LmStudioAgenticRunner's existing extraToolHandlers path (CONTROL-05).
 *
 * Tests share a single :memory: DB connection. Unique session ids per test
 * avoid cross-test bleed.
 */

process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';

import { ControlSessionStore } from './session-store.js';
import { ControlBroker } from './broker.js';
import type { ControlCapability, ControlProvider } from './types.js';
import type { ToolCall } from '../workers/types.js';
import { executeToolCall } from '../workers/lmstudio-agentic.js';
import {
  CONTROL_TOOL_DEFS,
  createControlSessionForRun,
  endControlSessionForRun,
  registerControlTools,
  toNamedToolHandlers,
  type ControlToolHandler,
} from './tools.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-t${counter}`;
}

const T0 = 1_780_500_000_000; // fixed epoch-ms base for deterministic clocks

const EXPECTED_TOOL_NAMES = [
  'relay_session_list',
  'relay_session_inspect',
  'relay_session_send',
  'relay_inbox_read',
  'relay_inbox_ack',
] as const;

function makeRig(): { store: ControlSessionStore; broker: ControlBroker } {
  const store = new ControlSessionStore();
  return { store, broker: new ControlBroker(store) };
}

function registerSession(
  store: ControlSessionStore,
  session_id: string,
  capabilities: readonly ControlCapability[],
  provider: ControlProvider = 'fake',
): void {
  store.upsertSession({ session_id, provider, capabilities }, T0);
}

function handlerByName(handlers: readonly ControlToolHandler[], name: string): ControlToolHandler {
  const handler = handlers.find((h) => h.def.function.name === name);
  assert.ok(handler, `handler ${name} must be registered`);
  return handler;
}

// dist/control/tools.test.js → repo root is ../../
async function readSourceFile(relpath: string): Promise<string> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const here = new URL('.', import.meta.url).pathname;
  const root = path.resolve(here, '..', '..');
  return fs.readFile(path.join(root, relpath), 'utf-8');
}

// ─── Tool declarations ──────────────────────────────────────────────────────

describe('control tool definitions', () => {
  test('CONTROL_TOOL_DEFS declares the five OpenAI-compatible tools', () => {
    assert.equal(CONTROL_TOOL_DEFS.length, 5);
    const names = CONTROL_TOOL_DEFS.map((d) => d.function.name);
    assert.deepEqual(names, [...EXPECTED_TOOL_NAMES]);
    for (const def of CONTROL_TOOL_DEFS) {
      assert.equal(def.type, 'function');
      assert.ok(def.function.description, `${def.function.name} needs a model-facing description`);
      const params = def.function.parameters as {
        type: string;
        additionalProperties?: boolean;
      };
      assert.equal(params.type, 'object');
      assert.equal(params.additionalProperties, false, `${def.function.name} must reject unknown keys`);
    }
  });

  test('registerControlTools returns one handler per def, names aligned', () => {
    const { store, broker } = makeRig();
    const handlers = registerControlTools(uid('caller'), { store, broker });
    assert.equal(handlers.length, 5);
    assert.deepEqual(
      handlers.map((h) => h.def.function.name),
      [...EXPECTED_TOOL_NAMES],
    );
  });
});

// ─── relay_session_list ─────────────────────────────────────────────────────

describe('relay_session_list', () => {
  test('lists registered sessions with safe fields only', async () => {
    const { store, broker } = makeRig();
    const caller = uid('list-caller');
    const peer = uid('list-peer');
    registerSession(store, caller, ['mailbox', 'tool_call']);
    store.upsertSession(
      {
        session_id: peer,
        provider: 'fake',
        capabilities: ['mailbox'],
        workdir: '/private/secret-project',
        pid: 4242,
        metadata: { secret: 'do-not-leak' },
      },
      T0,
    );
    const handlers = registerControlTools(caller, { store, broker });
    const result = (await handlerByName(handlers, 'relay_session_list').handle({})) as {
      ok: boolean;
      sessions: Array<Record<string, unknown>>;
    };
    assert.equal(result.ok, true);
    const row = result.sessions.find((s) => s['session_id'] === peer);
    assert.ok(row, 'peer session listed');
    assert.equal(row['provider'], 'fake');
    assert.deepEqual(row['capabilities'], ['mailbox']);
    assert.ok(!('workdir' in row), 'workdir must not leak to models');
    assert.ok(!('pid' in row), 'pid must not leak to models');
    assert.ok(!('metadata' in row), 'metadata must not leak to models');
  });
});

// ─── relay_session_inspect ──────────────────────────────────────────────────

describe('relay_session_inspect', () => {
  test('returns session summary, queued count, and caller grant status', async () => {
    const { store, broker } = makeRig();
    const caller = uid('insp-caller');
    const target = uid('insp-target');
    registerSession(store, caller, ['mailbox', 'tool_call']);
    registerSession(store, target, ['mailbox']);
    const handlers = registerControlTools(caller, { store, broker });
    const inspect = handlerByName(handlers, 'relay_session_inspect');

    const before = (await inspect.handle({ session_id: target })) as {
      ok: boolean;
      session: { session_id: string };
      queued_count: number;
      grant: { allowed: boolean; reason?: string };
    };
    assert.equal(before.ok, true);
    assert.equal(before.session.session_id, target);
    assert.equal(before.queued_count, 0);
    assert.equal(before.grant.allowed, false);
    assert.equal(before.grant.reason, 'no_grant');

    store.grant(
      { source_session_id: caller, target_session_id: target, ttl_ms: 60_000, max_messages: 5 },
      Date.now(),
    );
    const after = (await inspect.handle({ session_id: target })) as {
      ok: boolean;
      grant: { allowed: boolean };
    };
    assert.equal(after.grant.allowed, true);
  });

  test('unknown session returns ok:false CONTROL_SESSION_NOT_FOUND', async () => {
    const { store, broker } = makeRig();
    const caller = uid('insp-c2');
    registerSession(store, caller, ['mailbox', 'tool_call']);
    const handlers = registerControlTools(caller, { store, broker });
    const result = (await handlerByName(handlers, 'relay_session_inspect').handle({
      session_id: uid('insp-missing'),
    })) as { ok: boolean; code: string };
    assert.equal(result.ok, false);
    assert.equal(result.code, 'CONTROL_SESSION_NOT_FOUND');
  });
});

// ─── relay_session_send ─────────────────────────────────────────────────────

describe('relay_session_send', () => {
  test('default-deny without a grant (D-04): ok:false CONTROL_GRANT_REQUIRED, nothing queued', async () => {
    const { store, broker } = makeRig();
    const caller = uid('send-c1');
    const target = uid('send-t1');
    registerSession(store, caller, ['mailbox', 'tool_call']);
    registerSession(store, target, ['mailbox']);
    const handlers = registerControlTools(caller, { store, broker });
    const result = (await handlerByName(handlers, 'relay_session_send').handle({
      target_session_id: target,
      content: 'unauthorized hello',
    })) as { ok: boolean; code: string };
    assert.equal(result.ok, false);
    assert.equal(result.code, 'CONTROL_GRANT_REQUIRED');
    assert.equal(store.getQueuedMessages(target).length, 0, 'denied send must not queue');
  });

  test('granted send queues an llm message sourced from the caller', async () => {
    const { store, broker } = makeRig();
    const caller = uid('send-c2');
    const target = uid('send-t2');
    registerSession(store, caller, ['mailbox', 'tool_call']);
    registerSession(store, target, ['mailbox']);
    store.grant(
      { source_session_id: caller, target_session_id: target, ttl_ms: 60_000, max_messages: 5 },
      Date.now(),
    );
    const handlers = registerControlTools(caller, { store, broker });
    const result = (await handlerByName(handlers, 'relay_session_send').handle({
      target_session_id: target,
      content: 'authorized hello',
    })) as { ok: boolean; message_id: string; status: string };
    assert.equal(result.ok, true);
    assert.equal(result.status, 'queued');
    const message = store.getMessage(result.message_id);
    assert.ok(message);
    assert.equal(message.sender_kind, 'llm');
    assert.equal(message.source_session_id, caller, 'source is ALWAYS the caller session');
    assert.equal(message.target_session_id, target);
  });

  test('source spoofing is rejected: unknown source_session_id key → INVALID_ARGS', async () => {
    const { store, broker } = makeRig();
    const caller = uid('send-c3');
    const target = uid('send-t3');
    registerSession(store, caller, ['mailbox', 'tool_call']);
    registerSession(store, target, ['mailbox']);
    const handlers = registerControlTools(caller, { store, broker });
    const result = (await handlerByName(handlers, 'relay_session_send').handle({
      target_session_id: target,
      content: 'spoofed',
      source_session_id: uid('send-spoof'),
    })) as { ok: boolean; code: string };
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INVALID_ARGS');
  });

  test('self-send returns ok:false CONTROL_SELF_SEND_BLOCKED', async () => {
    const { store, broker } = makeRig();
    const caller = uid('send-c4');
    registerSession(store, caller, ['mailbox', 'tool_call']);
    const handlers = registerControlTools(caller, { store, broker });
    const result = (await handlerByName(handlers, 'relay_session_send').handle({
      target_session_id: caller,
      content: 'echo to self',
    })) as { ok: boolean; code: string };
    assert.equal(result.ok, false);
    assert.equal(result.code, 'CONTROL_SELF_SEND_BLOCKED');
  });

  test('grant budget is enforced: third send on a 2-message grant is denied', async () => {
    const { store, broker } = makeRig();
    const caller = uid('send-c5');
    const target = uid('send-t5');
    registerSession(store, caller, ['mailbox', 'tool_call']);
    registerSession(store, target, ['mailbox']);
    store.grant(
      { source_session_id: caller, target_session_id: target, ttl_ms: 60_000, max_messages: 2 },
      Date.now(),
    );
    const handlers = registerControlTools(caller, { store, broker });
    const send = handlerByName(handlers, 'relay_session_send');
    const r1 = (await send.handle({ target_session_id: target, content: 'first message' })) as { ok: boolean };
    const r2 = (await send.handle({ target_session_id: target, content: 'second message' })) as { ok: boolean };
    const r3 = (await send.handle({ target_session_id: target, content: 'third message' })) as {
      ok: boolean;
      code: string;
    };
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.equal(r3.ok, false);
    assert.equal(r3.code, 'CONTROL_BUDGET_EXHAUSTED');
  });
});

// ─── relay_inbox_read ───────────────────────────────────────────────────────

describe('relay_inbox_read', () => {
  test('returns the caller queued messages and marks them delivered', async () => {
    const { store, broker } = makeRig();
    const caller = uid('read-c1');
    registerSession(store, caller, ['mailbox', 'tool_call']);
    const sent = broker.sendMessage(
      {
        source_session_id: 'human:cli',
        target_session_id: caller,
        sender_kind: 'human',
        content: 'please summarize your progress',
      },
      Date.now(),
    );
    const handlers = registerControlTools(caller, { store, broker });
    const result = (await handlerByName(handlers, 'relay_inbox_read').handle({})) as {
      ok: boolean;
      messages: Array<{ message_id: string; source_session_id: string; content: string }>;
    };
    assert.equal(result.ok, true);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0]?.message_id, sent.message_id);
    assert.equal(result.messages[0]?.content, 'please summarize your progress');
    assert.equal(store.getMessage(sent.message_id)?.status, 'delivered');
    const attempts = store.listDeliveryAttempts(sent.message_id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.capability, 'mailbox');
    assert.equal(attempts[0]?.status, 'success');
  });

  test('scoping: messages for other sessions are not visible', async () => {
    const { store, broker } = makeRig();
    const caller = uid('read-c2');
    const other = uid('read-o2');
    registerSession(store, caller, ['mailbox', 'tool_call']);
    registerSession(store, other, ['mailbox']);
    broker.sendMessage(
      {
        source_session_id: 'human:cli',
        target_session_id: other,
        sender_kind: 'human',
        content: 'for the other session only',
      },
      Date.now(),
    );
    const handlers = registerControlTools(caller, { store, broker });
    const result = (await handlerByName(handlers, 'relay_inbox_read').handle({})) as {
      ok: boolean;
      messages: unknown[];
    };
    assert.equal(result.ok, true);
    assert.equal(result.messages.length, 0);
    assert.equal(store.getQueuedMessages(other).length, 1, 'other inbox untouched');
  });

  test('second read returns empty (messages already delivered)', async () => {
    const { store, broker } = makeRig();
    const caller = uid('read-c3');
    registerSession(store, caller, ['mailbox', 'tool_call']);
    broker.sendMessage(
      {
        source_session_id: 'human:cli',
        target_session_id: caller,
        sender_kind: 'human',
        content: 'one-shot delivery',
      },
      Date.now(),
    );
    const handlers = registerControlTools(caller, { store, broker });
    const read = handlerByName(handlers, 'relay_inbox_read');
    const first = (await read.handle({})) as { messages: unknown[] };
    const second = (await read.handle({})) as { messages: unknown[] };
    assert.equal(first.messages.length, 1);
    assert.equal(second.messages.length, 0);
  });
});

// ─── relay_inbox_ack ────────────────────────────────────────────────────────

describe('relay_inbox_ack', () => {
  test('acknowledges an own delivered message and appends the audit event', async () => {
    const { store, broker } = makeRig();
    const caller = uid('ack-c1');
    registerSession(store, caller, ['mailbox', 'tool_call']);
    const sent = broker.sendMessage(
      {
        source_session_id: 'human:cli',
        target_session_id: caller,
        sender_kind: 'human',
        content: 'ack me',
      },
      Date.now(),
    );
    const handlers = registerControlTools(caller, { store, broker });
    await handlerByName(handlers, 'relay_inbox_read').handle({});
    const result = (await handlerByName(handlers, 'relay_inbox_ack').handle({
      message_id: sent.message_id,
    })) as { ok: boolean; status: string };
    assert.equal(result.ok, true);
    assert.equal(result.status, 'acknowledged');
    assert.equal(store.getMessage(sent.message_id)?.status, 'acknowledged');
    const events = store
      .tailEvents(caller)
      .filter((e) => e.event_type === 'message_acknowledged');
    assert.equal(events.length, 1);
  });

  test('scoping: cannot ack a message targeted at another session', async () => {
    const { store, broker } = makeRig();
    const caller = uid('ack-c2');
    const other = uid('ack-o2');
    registerSession(store, caller, ['mailbox', 'tool_call']);
    registerSession(store, other, ['mailbox']);
    const sent = broker.sendMessage(
      {
        source_session_id: 'human:cli',
        target_session_id: other,
        sender_kind: 'human',
        content: 'not yours to ack',
      },
      Date.now(),
    );
    const handlers = registerControlTools(caller, { store, broker });
    const result = (await handlerByName(handlers, 'relay_inbox_ack').handle({
      message_id: sent.message_id,
    })) as { ok: boolean };
    assert.equal(result.ok, false);
    assert.equal(store.getMessage(sent.message_id)?.status, 'queued', 'foreign message untouched');
  });

  test('unknown message_id returns ok:false', async () => {
    const { store, broker } = makeRig();
    const caller = uid('ack-c3');
    registerSession(store, caller, ['mailbox', 'tool_call']);
    const handlers = registerControlTools(caller, { store, broker });
    const result = (await handlerByName(handlers, 'relay_inbox_ack').handle({
      message_id: uid('ack-missing'),
    })) as { ok: boolean };
    assert.equal(result.ok, false);
  });
});

// ─── Run-scoped control session lifecycle (D-08, CONTROL-07) ───────────────

describe('createControlSessionForRun / endControlSessionForRun', () => {
  test('registers a truthful lmstudio control session and audits it', () => {
    const store = new ControlSessionStore();
    const run_id = uid('run');
    const session = createControlSessionForRun(
      { run_id, workdir: '/tmp/proj', model: 'qwen/qwen3-coder-next', label: 'fix tests' },
      store,
    );
    assert.equal(session.session_id, run_id);
    assert.equal(session.provider, 'lmstudio');
    assert.equal(session.state, 'active');
    assert.equal(session.label, 'fix tests');
    assert.equal(session.workdir, '/tmp/proj');
    assert.deepEqual(
      [...session.capabilities].sort(),
      ['mailbox', 'observe', 'register', 'tail', 'tool_call'],
      'capabilities reflect what is actually wired',
    );
    assert.ok(
      !session.capabilities.includes('live_stdin') && !session.capabilities.includes('context_inject'),
      'no capability overclaims (D-01)',
    );
    const events = store.tailEvents(run_id).filter((e) => e.event_type === 'session_registered');
    assert.equal(events.length, 1);
  });

  test('endControlSessionForRun marks the session ended and audits it', () => {
    const store = new ControlSessionStore();
    const run_id = uid('run-end');
    createControlSessionForRun({ run_id, workdir: '/tmp/proj' }, store);
    const ended = endControlSessionForRun(run_id, store);
    assert.ok(ended);
    assert.equal(ended.state, 'ended');
    const events = store.tailEvents(run_id).filter((e) => e.event_type === 'session_ended');
    assert.equal(events.length, 1);
  });

  test('endControlSessionForRun on an unknown session returns undefined', () => {
    const store = new ControlSessionStore();
    assert.equal(endControlSessionForRun(uid('run-missing'), store), undefined);
  });
});

// ─── Worker dispatch integration (CONTROL-05) ───────────────────────────────

describe('extraToolHandlers dispatch integration', () => {
  test('toNamedToolHandlers maps names and keeps handlers invocable', async () => {
    const { store, broker } = makeRig();
    const caller = uid('named-c');
    registerSession(store, caller, ['mailbox', 'tool_call']);
    const named = toNamedToolHandlers(registerControlTools(caller, { store, broker }));
    assert.deepEqual(
      named.map((n) => n.name),
      [...EXPECTED_TOOL_NAMES],
    );
    const list = named.find((n) => n.name === 'relay_session_list');
    assert.ok(list);
    const result = (await list.handle({}, { workdir: '/tmp/x', pat: '' })) as { ok: boolean };
    assert.equal(result.ok, true);
  });

  test('relay_session_send flows through executeToolCall and returns the policy denial', async () => {
    const { store, broker } = makeRig();
    const caller = uid('etc-c');
    const target = uid('etc-t');
    registerSession(store, caller, ['mailbox', 'tool_call']);
    registerSession(store, target, ['mailbox']);
    const named = toNamedToolHandlers(registerControlTools(caller, { store, broker }));
    const call: ToolCall = {
      id: 'ctl_call_1',
      type: 'function',
      function: {
        name: 'relay_session_send',
        arguments: JSON.stringify({ target_session_id: target, content: 'through the loop' }),
      },
    };
    const out = await executeToolCall(
      call,
      '/tmp/work',
      async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      named,
    );
    assert.equal(out.role, 'tool');
    assert.equal(out.tool_call_id, 'ctl_call_1');
    const body = JSON.parse(out.content) as { ok: boolean; code: string };
    assert.equal(body.ok, false);
    assert.equal(body.code, 'CONTROL_GRANT_REQUIRED', 'default-deny survives the worker dispatch path');
  });

  test('relay_inbox_read flows through executeToolCall end-to-end', async () => {
    const { store, broker } = makeRig();
    const caller = uid('etc-r');
    registerSession(store, caller, ['mailbox', 'tool_call']);
    broker.sendMessage(
      {
        source_session_id: 'human:cli',
        target_session_id: caller,
        sender_kind: 'human',
        content: 'loop-delivered note',
      },
      Date.now(),
    );
    const named = toNamedToolHandlers(registerControlTools(caller, { store, broker }));
    const call: ToolCall = {
      id: 'ctl_call_2',
      type: 'function',
      function: { name: 'relay_inbox_read', arguments: '{}' },
    };
    const out = await executeToolCall(
      call,
      '/tmp/work',
      async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      named,
    );
    const body = JSON.parse(out.content) as { ok: boolean; messages: Array<{ content: string }> };
    assert.equal(body.ok, true);
    assert.equal(body.messages[0]?.content, 'loop-delivered note');
  });
});

// ─── cmd-run / worker wiring (source-level smoke, mirrors T7) ───────────────

describe('cmd-run control wiring', () => {
  test('cmd-run creates a control session and merges control tools for lmstudio-agentic', async () => {
    const src = await readSourceFile('src/cli/cmd-run.ts');
    assert.match(src, /createControlSessionForRun/);
    assert.match(src, /registerControlTools/);
    assert.match(src, /toNamedToolHandlers/);
    assert.match(src, /CONTROL_TOOL_DEFS/);
    assert.match(src, /endControlSessionForRun/);
    assert.match(src, /import\(['"]\.\.\/control\/tools\.js['"]\)/);
  });

  test('NamedToolHandler.pat is optional so credential-less tools can register', async () => {
    const src = await readSourceFile('src/workers/lmstudio-agentic.ts');
    assert.match(src, /pat\?\s*:\s*string/);
  });
});
