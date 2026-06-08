/**
 * Phase 8 / Plan 03 / Task 1 — `relay session ...` human control CLI.
 *
 * Covers executeSessionCommand for list / inspect / tail / send / grant /
 * revoke in JSON mode (plus a couple of human-mode renders), Zod CLI arg
 * validation (exit 2 on malformed input), the unsupported-target-capability
 * exit behavior (CONTROL_DELIVERY_UNSUPPORTED → exit 1), and routing through
 * store + broker + registry (D-03/D-13: the CLI uses the SAME broker policy
 * path as LLM tools — no parallel control implementation).
 *
 * Tests share a single :memory: DB connection (module-level cache in db.ts).
 * Unique session/grant IDs per test avoid cross-test bleed.
 */

process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';

import { ControlSessionStore } from '../control/session-store.js';
import { ControlBroker } from '../control/broker.js';
import { ControlAdapterRegistry } from '../control/adapter-registry.js';
import { FakeControlAdapter } from '../control/adapters/fake.js';
import type { ControlCapability, ControlProvider } from '../control/types.js';
import type { CliIO } from './commands.js';
import {
  executeSessionCommand,
  parseDurationMs,
  type SessionCommandOptions,
} from './cmd-session.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-s${counter}`;
}

const T0 = 1_780_000_000_000; // fixed epoch-ms base for deterministic clocks

interface CapturedIO {
  io: CliIO;
  stdout: string[];
  stderr: string[];
}

function makeIO(): CapturedIO {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { cwd: '/tmp', stdout: (m) => stdout.push(m), stderr: (m) => stderr.push(m) },
    stdout,
    stderr,
  };
}

function opts(
  action: string,
  positionals: readonly string[] = [],
  extra: Partial<SessionCommandOptions> = {},
): SessionCommandOptions {
  return { action, positionals, json: true, ...extra };
}

function makeRig(): {
  store: ControlSessionStore;
  broker: ControlBroker;
  registry: ControlAdapterRegistry;
  fake: FakeControlAdapter;
} {
  const store = new ControlSessionStore();
  const broker = new ControlBroker(store);
  const registry = new ControlAdapterRegistry(store, broker);
  const fake = new FakeControlAdapter();
  registry.register(fake);
  return { store, broker, registry, fake };
}

function registerSession(
  store: ControlSessionStore,
  session_id: string,
  capabilities: readonly ControlCapability[],
  provider: ControlProvider = 'fake',
): void {
  store.upsertSession({ session_id, provider, capabilities }, T0);
}

// dist/cli/cmd-session.test.js → repo root is ../../
async function readSourceFile(relpath: string): Promise<string> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const here = new URL('.', import.meta.url).pathname;
  const root = path.resolve(here, '..', '..');
  return fs.readFile(path.join(root, relpath), 'utf-8');
}

// ─── parseDurationMs ────────────────────────────────────────────────────────

describe('parseDurationMs', () => {
  test('parses s/m/h/d suffixes and bare milliseconds', () => {
    assert.equal(parseDurationMs('30s'), 30_000);
    assert.equal(parseDurationMs('10m'), 600_000);
    assert.equal(parseDurationMs('2h'), 7_200_000);
    assert.equal(parseDurationMs('1d'), 86_400_000);
    assert.equal(parseDurationMs('5000'), 5000);
  });

  test('rejects malformed durations', () => {
    for (const bad of ['', 'abc', '-5m', '0', '0m', '1.5x', 'm']) {
      assert.throws(() => parseDurationMs(bad), `expected throw for ${JSON.stringify(bad)}`);
    }
  });
});

// ─── relay session list ─────────────────────────────────────────────────────

describe('relay session list', () => {
  test('JSON: registered sessions appear with capabilities', async () => {
    const { store } = makeRig();
    const id = uid('list');
    registerSession(store, id, ['register', 'observe', 'mailbox']);
    const cap = makeIO();
    const code = await executeSessionCommand(opts('list'), cap.io);
    assert.equal(code, 0);
    const rows = JSON.parse(cap.stdout.join('')) as Array<{
      session_id: string;
      provider: string;
      state: string;
      capabilities: string[];
    }>;
    const row = rows.find((r) => r.session_id === id);
    assert.ok(row, 'registered session must be listed');
    assert.equal(row.provider, 'fake');
    assert.equal(row.state, 'active');
    assert.deepEqual([...row.capabilities].sort(), ['mailbox', 'observe', 'register']);
  });

  test('JSON: --provider filter narrows results', async () => {
    const { store } = makeRig();
    const fakeId = uid('prov-fake');
    const lmId = uid('prov-lm');
    registerSession(store, fakeId, ['mailbox']);
    registerSession(store, lmId, ['mailbox'], 'lmstudio');
    const cap = makeIO();
    const code = await executeSessionCommand(opts('list', [], { provider: 'lmstudio' }), cap.io);
    assert.equal(code, 0);
    const rows = JSON.parse(cap.stdout.join('')) as Array<{ session_id: string }>;
    assert.ok(rows.some((r) => r.session_id === lmId), 'lmstudio session listed');
    assert.ok(!rows.some((r) => r.session_id === fakeId), 'fake session filtered out');
  });

  test('JSON: --state filter narrows results', async () => {
    const { store } = makeRig();
    const activeId = uid('state-a');
    const endedId = uid('state-e');
    registerSession(store, activeId, ['mailbox']);
    store.upsertSession(
      { session_id: endedId, provider: 'fake', capabilities: ['mailbox'], state: 'ended' },
      T0,
    );
    const cap = makeIO();
    const code = await executeSessionCommand(opts('list', [], { state: 'ended' }), cap.io);
    assert.equal(code, 0);
    const rows = JSON.parse(cap.stdout.join('')) as Array<{ session_id: string }>;
    assert.ok(rows.some((r) => r.session_id === endedId), 'ended session listed');
    assert.ok(!rows.some((r) => r.session_id === activeId), 'active session filtered out');
  });

  test('invalid --provider exits 2 with usage error', async () => {
    const cap = makeIO();
    const code = await executeSessionCommand(opts('list', [], { provider: 'gemini' }), cap.io);
    assert.equal(code, 2);
    assert.match(cap.stderr.join(''), /provider/i);
  });

  test('human mode renders header and rows', async () => {
    const { store } = makeRig();
    const id = uid('human-list');
    registerSession(store, id, ['mailbox', 'tool_call']);
    const cap = makeIO();
    const code = await executeSessionCommand(opts('list', [], { json: false }), cap.io);
    assert.equal(code, 0);
    const out = cap.stdout.join('');
    assert.match(out, /session_id/);
    assert.match(out, /provider/);
    assert.match(out, /capabilities/);
    assert.ok(out.includes(id), 'row for registered session rendered');
  });
});

// ─── relay session inspect ──────────────────────────────────────────────────

describe('relay session inspect', () => {
  test('JSON: returns session, queued count, and recent events', async () => {
    const { store, broker } = makeRig();
    const target = uid('insp-t');
    registerSession(store, target, ['mailbox']);
    broker.sendMessage(
      { source_session_id: 'human:cli', target_session_id: target, sender_kind: 'human', content: 'hello there' },
      T0 + 1000,
    );
    const cap = makeIO();
    const code = await executeSessionCommand(opts('inspect', [target]), cap.io);
    assert.equal(code, 0);
    const body = JSON.parse(cap.stdout.join('')) as {
      session: { session_id: string; capabilities: string[] };
      queued_count: number;
      events: Array<{ event_type: string }>;
    };
    assert.equal(body.session.session_id, target);
    assert.deepEqual(body.session.capabilities, ['mailbox']);
    assert.equal(body.queued_count, 1);
    assert.ok(
      body.events.some((e) => e.event_type === 'message_enqueued'),
      'enqueue audit event surfaced',
    );
  });

  test('unknown session exits 1 with CONTROL_SESSION_NOT_FOUND', async () => {
    makeRig();
    const cap = makeIO();
    const code = await executeSessionCommand(opts('inspect', [uid('missing')]), cap.io);
    assert.equal(code, 1);
    assert.match(cap.stderr.join(''), /CONTROL_SESSION_NOT_FOUND/);
  });

  test('missing session_id exits 2', async () => {
    const cap = makeIO();
    const code = await executeSessionCommand(opts('inspect', []), cap.io);
    assert.equal(code, 2);
  });
});

// ─── relay session tail ─────────────────────────────────────────────────────

describe('relay session tail', () => {
  test('JSON: returns events in append order with monotonic ids', async () => {
    const { store } = makeRig();
    const id = uid('tail');
    registerSession(store, id, ['mailbox']);
    store.appendEvent({ session_id: id, event_type: 'session_registered', payload: {} }, T0);
    store.appendEvent({ session_id: id, event_type: 'session_updated', payload: {} }, T0 + 1);
    const cap = makeIO();
    const code = await executeSessionCommand(opts('tail', [id]), cap.io);
    assert.equal(code, 0);
    const events = JSON.parse(cap.stdout.join('')) as Array<{ id: number; event_type: string }>;
    assert.ok(events.length >= 2);
    const ids = events.map((e) => e.id);
    assert.deepEqual([...ids].sort((a, b) => a - b), ids, 'ids ascend');
    assert.equal(events.at(-1)?.event_type, 'session_updated');
  });

  test('--after acts as a cursor', async () => {
    const { store } = makeRig();
    const id = uid('tail-after');
    registerSession(store, id, ['mailbox']);
    const first = store.appendEvent({ session_id: id, event_type: 'session_registered', payload: {} }, T0);
    store.appendEvent({ session_id: id, event_type: 'session_ended', payload: {} }, T0 + 1);
    const cap = makeIO();
    const code = await executeSessionCommand(
      opts('tail', [id], { after: String(first.id) }),
      cap.io,
    );
    assert.equal(code, 0);
    const events = JSON.parse(cap.stdout.join('')) as Array<{ id: number; event_type: string }>;
    assert.ok(events.every((e) => e.id > first.id), 'cursor excludes earlier events');
    assert.ok(events.some((e) => e.event_type === 'session_ended'));
  });

  test('--limit caps the number of events', async () => {
    const { store } = makeRig();
    const id = uid('tail-limit');
    registerSession(store, id, ['mailbox']);
    for (let i = 0; i < 5; i++) {
      store.appendEvent({ session_id: id, event_type: 'session_updated', payload: { i } }, T0 + i);
    }
    const cap = makeIO();
    const code = await executeSessionCommand(opts('tail', [id], { limit: '2' }), cap.io);
    assert.equal(code, 0);
    const events = JSON.parse(cap.stdout.join('')) as unknown[];
    assert.equal(events.length, 2);
  });

  test('unknown session exits 1 with CONTROL_SESSION_NOT_FOUND', async () => {
    const cap = makeIO();
    const code = await executeSessionCommand(opts('tail', [uid('tail-missing')]), cap.io);
    assert.equal(code, 1);
    assert.match(cap.stderr.join(''), /CONTROL_SESSION_NOT_FOUND/);
  });

  test('non-numeric --after exits 2', async () => {
    const { store } = makeRig();
    const id = uid('tail-bad');
    registerSession(store, id, ['mailbox']);
    const cap = makeIO();
    const code = await executeSessionCommand(opts('tail', [id], { after: 'xyz' }), cap.io);
    assert.equal(code, 2);
  });
});

// ─── relay session send ─────────────────────────────────────────────────────

describe('relay session send', () => {
  test('human send queues for a mailbox-capable target (no adapter → stays queued)', async () => {
    const store = new ControlSessionStore();
    const target = uid('send-q');
    registerSession(store, target, ['mailbox']);
    const cap = makeIO();
    // No injected registry: default registry has no adapters → message stays queued.
    const code = await executeSessionCommand(opts('send', [target, 'ping', 'pong']), cap.io);
    assert.equal(code, 0);
    const body = JSON.parse(cap.stdout.join('')) as {
      message_id: string;
      status: string;
      target_session_id: string;
    };
    assert.equal(body.status, 'queued');
    assert.equal(body.target_session_id, target);
    const message = store.getMessage(body.message_id);
    assert.ok(message, 'message persisted');
    assert.equal(message.content, 'ping pong');
    assert.equal(message.sender_kind, 'human');
  });

  test('delivers through an injected registry + fake adapter', async () => {
    const { store, broker, registry, fake } = makeRig();
    const target = uid('send-d');
    registerSession(store, target, ['mailbox']);
    const cap = makeIO();
    const code = await executeSessionCommand(
      opts('send', [target, 'deliver me']),
      cap.io,
      { store, broker, registry },
    );
    assert.equal(code, 0);
    const body = JSON.parse(cap.stdout.join('')) as { message_id: string; status: string };
    assert.equal(body.status, 'delivered');
    const inbox = fake.getInbox(target);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]?.message_id, body.message_id);
  });

  test('adapter failure marks the message failed and exits 1', async () => {
    const { store, broker, registry, fake } = makeRig();
    const target = uid('send-f');
    registerSession(store, target, ['mailbox']);
    fake.failNext('fake adapter refused');
    const cap = makeIO();
    const code = await executeSessionCommand(
      opts('send', [target, 'will fail']),
      cap.io,
      { store, broker, registry },
    );
    assert.equal(code, 1);
    const body = JSON.parse(cap.stdout.join('')) as { message_id: string; status: string };
    assert.equal(body.status, 'failed');
    assert.equal(store.getMessage(body.message_id)?.status, 'failed');
  });

  test('target without any delivery capability exits 1 with CONTROL_DELIVERY_UNSUPPORTED', async () => {
    const store = new ControlSessionStore();
    const target = uid('send-nocap');
    registerSession(store, target, ['register', 'observe']);
    const cap = makeIO();
    const code = await executeSessionCommand(opts('send', [target, 'nope']), cap.io);
    assert.equal(code, 1);
    assert.match(cap.stderr.join(''), /CONTROL_DELIVERY_UNSUPPORTED/);
  });

  test('unknown target exits 1 with CONTROL_SESSION_NOT_FOUND', async () => {
    const cap = makeIO();
    const code = await executeSessionCommand(opts('send', [uid('send-missing'), 'hi']), cap.io);
    assert.equal(code, 1);
    assert.match(cap.stderr.join(''), /CONTROL_SESSION_NOT_FOUND/);
  });

  test('self-send (--from == target) exits 1 with CONTROL_SELF_SEND_BLOCKED', async () => {
    const store = new ControlSessionStore();
    const target = uid('send-self');
    registerSession(store, target, ['mailbox']);
    const cap = makeIO();
    const code = await executeSessionCommand(
      opts('send', [target, 'loop'], { from: target }),
      cap.io,
    );
    assert.equal(code, 1);
    assert.match(cap.stderr.join(''), /CONTROL_SELF_SEND_BLOCKED/);
  });

  test('missing content exits 2', async () => {
    const store = new ControlSessionStore();
    const target = uid('send-noc');
    registerSession(store, target, ['mailbox']);
    const cap = makeIO();
    const code = await executeSessionCommand(opts('send', [target]), cap.io);
    assert.equal(code, 2);
  });

  test('content is redacted before persistence (D-06)', async () => {
    const store = new ControlSessionStore();
    const target = uid('send-redact');
    registerSession(store, target, ['mailbox']);
    const cap = makeIO();
    const code = await executeSessionCommand(
      opts('send', [target, 'deploy key AKIAABCDEFGHIJKLMNOP done']),
      cap.io,
    );
    assert.equal(code, 0);
    const body = JSON.parse(cap.stdout.join('')) as { message_id: string };
    const message = store.getMessage(body.message_id);
    assert.ok(message);
    assert.equal(message.content.includes('AKIAABCDEFGHIJKLMNOP'), false);
    assert.equal(message.redaction.applied, true);
  });
});

// ─── relay session grant / revoke ───────────────────────────────────────────

describe('relay session grant', () => {
  test('issues a TTL-bound budgeted grant and appends grant_issued', async () => {
    const store = new ControlSessionStore();
    const source = uid('grant-s');
    const target = uid('grant-t');
    registerSession(store, source, ['mailbox', 'tool_call']);
    registerSession(store, target, ['mailbox']);
    const cap = makeIO();
    const code = await executeSessionCommand(
      opts('grant', [source, target], { ttl: '10m', maxMessages: '3' }),
      cap.io,
    );
    assert.equal(code, 0);
    const grant = JSON.parse(cap.stdout.join('')) as {
      grant_id: string;
      source_session_id: string;
      target_session_id: string;
      max_messages: number;
      expires_at: number;
      created_at: number;
    };
    assert.equal(grant.source_session_id, source);
    assert.equal(grant.target_session_id, target);
    assert.equal(grant.max_messages, 3);
    assert.equal(grant.expires_at - grant.created_at, 600_000);
    const events = store.tailEvents(source).filter((e) => e.event_type === 'grant_issued');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.target_session_id, target);
  });

  test('defaults: 15m TTL and 10-message budget', async () => {
    const store = new ControlSessionStore();
    const source = uid('grant-ds');
    const target = uid('grant-dt');
    registerSession(store, source, ['mailbox']);
    registerSession(store, target, ['mailbox']);
    const cap = makeIO();
    const code = await executeSessionCommand(opts('grant', [source, target]), cap.io);
    assert.equal(code, 0);
    const grant = JSON.parse(cap.stdout.join('')) as {
      max_messages: number;
      expires_at: number;
      created_at: number;
    };
    assert.equal(grant.max_messages, 10);
    assert.equal(grant.expires_at - grant.created_at, 900_000);
  });

  test('unknown source or target session exits 1 with CONTROL_SESSION_NOT_FOUND', async () => {
    const store = new ControlSessionStore();
    const known = uid('grant-k');
    registerSession(store, known, ['mailbox']);
    const cap1 = makeIO();
    assert.equal(
      await executeSessionCommand(opts('grant', [uid('grant-m1'), known]), cap1.io),
      1,
    );
    assert.match(cap1.stderr.join(''), /CONTROL_SESSION_NOT_FOUND/);
    const cap2 = makeIO();
    assert.equal(
      await executeSessionCommand(opts('grant', [known, uid('grant-m2')]), cap2.io),
      1,
    );
    assert.match(cap2.stderr.join(''), /CONTROL_SESSION_NOT_FOUND/);
  });

  test('malformed --ttl or --max-messages exits 2', async () => {
    const store = new ControlSessionStore();
    const source = uid('grant-bs');
    const target = uid('grant-bt');
    registerSession(store, source, ['mailbox']);
    registerSession(store, target, ['mailbox']);
    const capTtl = makeIO();
    assert.equal(
      await executeSessionCommand(opts('grant', [source, target], { ttl: 'soon' }), capTtl.io),
      2,
    );
    const capMax = makeIO();
    assert.equal(
      await executeSessionCommand(
        opts('grant', [source, target], { maxMessages: '0' }),
        capMax.io,
      ),
      2,
    );
  });

  test('CLI grant enables a previously-denied llm send (D-04)', async () => {
    const store = new ControlSessionStore();
    const broker = new ControlBroker(store);
    const source = uid('grant-llm-s');
    const target = uid('grant-llm-t');
    registerSession(store, source, ['mailbox', 'tool_call']);
    registerSession(store, target, ['mailbox']);
    assert.throws(() =>
      broker.sendMessage(
        { source_session_id: source, target_session_id: target, sender_kind: 'llm', content: 'pre-grant' },
        T0 + 10,
      ),
    );
    const cap = makeIO();
    assert.equal(await executeSessionCommand(opts('grant', [source, target]), cap.io), 0);
    const message = broker.sendMessage(
      { source_session_id: source, target_session_id: target, sender_kind: 'llm', content: 'post-grant' },
      Date.now(),
    );
    assert.equal(message.status, 'queued');
  });
});

describe('relay session revoke', () => {
  test('revokes a grant and appends grant_revoked', async () => {
    const store = new ControlSessionStore();
    const source = uid('rev-s');
    const target = uid('rev-t');
    registerSession(store, source, ['mailbox']);
    registerSession(store, target, ['mailbox']);
    const grant = store.grant(
      { source_session_id: source, target_session_id: target, ttl_ms: 60_000, max_messages: 5 },
      Date.now(),
    );
    const cap = makeIO();
    const code = await executeSessionCommand(opts('revoke', [grant.grant_id]), cap.io);
    assert.equal(code, 0);
    const body = JSON.parse(cap.stdout.join('')) as { grant_id: string; revoked_at: number | null };
    assert.equal(body.grant_id, grant.grant_id);
    assert.ok(body.revoked_at, 'revoked_at stamped');
    const events = store.tailEvents(source).filter((e) => e.event_type === 'grant_revoked');
    assert.equal(events.length, 1);
    // Revoked grant no longer authorizes llm sends.
    const broker = new ControlBroker(store);
    const check = broker.checkGrant(source, target, Date.now());
    assert.equal(check.allowed, false);
  });

  test('unknown grant exits 1', async () => {
    const cap = makeIO();
    const code = await executeSessionCommand(opts('revoke', [uid('rev-missing')]), cap.io);
    assert.equal(code, 1);
    assert.match(cap.stderr.join(''), /not found/i);
  });

  test('missing grant_id exits 2', async () => {
    const cap = makeIO();
    const code = await executeSessionCommand(opts('revoke', []), cap.io);
    assert.equal(code, 2);
  });
});

// ─── Usage errors ───────────────────────────────────────────────────────────

describe('relay session usage', () => {
  test('unknown action exits 2 and lists valid actions', async () => {
    const cap = makeIO();
    const code = await executeSessionCommand(opts('destroy', []), cap.io);
    assert.equal(code, 2);
    const err = cap.stderr.join('');
    assert.match(err, /list/);
    assert.match(err, /inspect/);
    assert.match(err, /send/);
    assert.match(err, /grant/);
    assert.match(err, /revoke/);
  });

  test('missing action exits 2', async () => {
    const cap = makeIO();
    const code = await executeSessionCommand(opts('', []), cap.io);
    assert.equal(code, 2);
  });
});

// ─── cli.ts wiring (source-level smoke, mirrors lmstudio-agentic T7) ────────

describe('cli.ts session wiring', () => {
  test('cli.ts dispatches the session command to cmd-session.js', async () => {
    const src = await readSourceFile('src/cli.ts');
    assert.match(src, /cmd === 'session'/);
    assert.match(src, /import\(['"]\.\/cli\/cmd-session\.js['"]\)/);
  });

  test('cli.ts help surfaces the session commands', async () => {
    const src = await readSourceFile('src/cli.ts');
    assert.match(src, /SESSION COMMANDS/);
    assert.match(src, /relay session list/);
    assert.match(src, /relay session send/);
    assert.match(src, /relay session grant/);
  });
});

// ─── 08-fix HIGH: agentic-sandbox guard (relay-CLI control bypass) ──────────

import { AGENTIC_SANDBOX_ENV } from '../security/env-sanitize.js';

describe('relay session — agentic-sandbox guard', () => {
  async function withSandbox<T>(fn: () => Promise<T>): Promise<T> {
    const orig = process.env[AGENTIC_SANDBOX_ENV];
    process.env[AGENTIC_SANDBOX_ENV] = '1';
    try {
      return await fn();
    } finally {
      if (orig === undefined) delete process.env[AGENTIC_SANDBOX_ENV];
      else process.env[AGENTIC_SANDBOX_ENV] = orig;
    }
  }

  // The named mutating set from the finding, plus delegate/pause/resume which are
  // equally mutating — the guard is fail-closed (everything but read-only refuses).
  for (const action of [
    'send',
    'grant',
    'approve',
    'deny',
    'revoke',
    'spawn',
    'delegate',
    'pause',
    'resume',
  ] as const) {
    test(`refuses mutating '${action}' under RELAY_AGENTIC_SANDBOX`, async () => {
      await withSandbox(async () => {
        const cap = makeIO();
        const positionals = action === 'spawn' ? ['some-binary'] : ['some-target', 'payload'];
        const extra = action === 'spawn' ? { provider: 'fake' } : {};
        const code = await executeSessionCommand(opts(action, positionals, extra), cap.io);
        assert.equal(code, 1, `${action} must refuse with exit 1 under the sandbox marker`);
        const err = cap.stderr.join('');
        assert.match(err, /CONTROL_SANDBOX_DENIED/, 'refusal uses the dedicated RelayError code');
        assert.match(err, /relay_session_/, 'refusal points the model at the in-process tools');
      });
    });
  }

  test('read-only list / inspect / tail stay allowed under RELAY_AGENTIC_SANDBOX', async () => {
    await withSandbox(async () => {
      const { store } = makeRig();
      const id = uid('sandbox-ro');
      registerSession(store, id, ['register', 'observe', 'mailbox']);

      let cap = makeIO();
      assert.equal(await executeSessionCommand(opts('list'), cap.io), 0, 'list allowed in sandbox');

      cap = makeIO();
      assert.equal(await executeSessionCommand(opts('inspect', [id]), cap.io), 0, 'inspect allowed in sandbox');

      cap = makeIO();
      assert.equal(await executeSessionCommand(opts('tail', [id]), cap.io), 0, 'tail allowed in sandbox');
    });
  });

  test('without the marker, a mutating send proceeds normally (guard is marker-gated)', async () => {
    const { store } = makeRig();
    const target = uid('nosandbox');
    registerSession(store, target, ['mailbox']);
    const cap = makeIO();
    const code = await executeSessionCommand(opts('send', [target, 'hi']), cap.io);
    assert.equal(code, 0, 'no marker → send is not blocked by the guard');
  });
});
