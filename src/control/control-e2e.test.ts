/**
 * Phase 8 / Plan 05 / Task 2 — end-to-end control verification + diagnostics.
 *
 * Proves any-to-any messaging across the wired surface AT CURRENT HEAD: a fake
 * A→B reply, an LM Studio control-tool send to a fake target, Claude queued
 * context rendering, an unauthorized agent send blocked, and a repeated
 * ping-pong loop blocked. Then the diagnostics contract: `relay verify`,
 * `relay doctor`, and `relay info` surface control health, queued backlog, and
 * blocked attempts with a truthful adapter capability catalog.
 *
 * The E2E scenarios assert on allowed/blocked/delivered behavior and tool
 * result codes — not on internal event payload shapes that the Command Central
 * visibility layer extends additively.
 *
 * Shares a single :memory: DB (db.ts module cache). Unique ids per test.
 */

process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ControlSessionStore } from './session-store.js';
import { ControlBroker } from './broker.js';
import { ControlAdapterRegistry } from './adapter-registry.js';
import { FakeControlAdapter } from './adapters/fake.js';
import { ClaudeCodeControlAdapter } from './adapters/claude-code.js';
import { registerControlTools } from './tools.js';
import type { ControlCapability, ControlProvider } from './types.js';

import type { CliIO } from '../cli/commands.js';
import { runControlCheck, executeVerifyCommand } from '../cli/cmd-verify.js';
import { checkControlLayer, executeDoctorCommand } from '../cli/cmd-doctor.js';
import {
  readControlState,
  executeInfoCommand,
  CONTROL_ADAPTER_CATALOG,
} from '../cli/cmd-info.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-e${counter}`;
}

const T0 = 1_781_000_000_000;

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

function rig(): { store: ControlSessionStore; broker: ControlBroker; registry: ControlAdapterRegistry; fake: FakeControlAdapter } {
  const store = new ControlSessionStore();
  const broker = new ControlBroker(store);
  const registry = new ControlAdapterRegistry(store, broker);
  const fake = new FakeControlAdapter();
  registry.register(fake);
  return { store, broker, registry, fake };
}

function register(
  store: ControlSessionStore,
  id: string,
  caps: readonly ControlCapability[],
  provider: ControlProvider = 'fake',
): void {
  store.upsertSession({ session_id: id, provider, capabilities: caps }, T0);
}

interface ToolResult {
  ok: boolean;
  code?: string;
  message_id?: string;
  status?: string;
}

async function callSend(
  store: ControlSessionStore,
  broker: ControlBroker,
  caller: string,
  target: string,
  content: string,
): Promise<ToolResult> {
  const tools = registerControlTools(caller, { store, broker });
  const send = tools.find((t) => t.def.function.name === 'relay_session_send');
  assert.ok(send, 'relay_session_send tool registered');
  return (await send!.handle({ target_session_id: target, content })) as ToolResult;
}

// ─── E2E: any-to-any messaging ──────────────────────────────────────────────

describe('control E2E', () => {
  test('fake A→B reply round-trips through the broker and fake adapter', async () => {
    const { store, broker, registry, fake } = rig();
    const a = uid('a');
    const b = uid('b');
    register(store, a, ['register', 'observe', 'mailbox']);
    register(store, b, ['register', 'observe', 'mailbox']);

    const out = broker.sendMessage({ source_session_id: a, target_session_id: b, sender_kind: 'human', content: 'hi from A' });
    await registry.deliverQueued(b);
    assert.ok(fake.getInbox(b).some((m) => m.message_id === out.message_id), 'B receives A’s message');
    assert.equal(store.getMessage(out.message_id)?.status, 'delivered');

    const reply = broker.sendMessage({ source_session_id: b, target_session_id: a, sender_kind: 'human', content: 'reply from B' });
    await registry.deliverQueued(a);
    assert.ok(fake.getInbox(a).some((m) => m.message_id === reply.message_id), 'A receives B’s reply');
  });

  test('LM Studio control-tool send reaches a fake target (with a grant)', async () => {
    const { store, broker, registry, fake } = rig();
    const lm = uid('lm');
    const target = uid('tgt');
    register(store, lm, ['register', 'observe', 'tail', 'mailbox', 'tool_call'], 'lmstudio');
    register(store, target, ['register', 'observe', 'mailbox']);
    store.grant({ source_session_id: lm, target_session_id: target, ttl_ms: 600_000, max_messages: 10 }, T0);

    const result = await callSend(store, broker, lm, target, 'run the smoke suite');
    assert.equal(result.ok, true, 'granted llm send is allowed');
    await registry.deliverQueued(target);
    assert.ok(fake.getInbox(target).some((m) => m.content.includes('smoke suite')), 'fake target received it');
  });

  test('Claude queued context renders as additionalContext', async () => {
    const store = new ControlSessionStore();
    const broker = new ControlBroker(store);
    const claude = new ClaudeCodeControlAdapter(store);
    const registry = new ControlAdapterRegistry(store, broker);
    registry.register(claude);

    const id = uid('cc');
    claude.applyHookPayload({ session_id: id, hook_event_name: 'SessionStart', cwd: '/tmp/cc' }, T0);
    broker.sendMessage({ source_session_id: 'human:op', target_session_id: id, sender_kind: 'human', content: 'pause after the current task' });

    await registry.deliverQueued(id);
    const rendered = claude.takePendingContext(id);
    assert.ok(rendered, 'a context block is produced for the queued message');
    assert.match(rendered!, /pause after the current task/);
    assert.match(rendered!, /Relay cross-session messages/);
  });

  test('unauthorized agent send is blocked (no grant)', async () => {
    const { store, broker } = rig();
    const lm = uid('lm');
    const target = uid('tgt');
    register(store, lm, ['register', 'observe', 'mailbox', 'tool_call'], 'lmstudio');
    register(store, target, ['register', 'observe', 'mailbox']);

    const result = await callSend(store, broker, lm, target, 'do this now');
    assert.equal(result.ok, false, 'default-deny: ungranted llm send refused');
    assert.equal(result.code, 'CONTROL_GRANT_REQUIRED');
    assert.equal(store.getQueuedMessages(target).length, 0, 'nothing queued for the target');
    const blocked = store.listRecentEvents({ event_types: ['message_blocked'] });
    assert.ok(blocked.some((e) => e.source_session_id === lm && e.target_session_id === target), 'block is audited');
  });

  test('repeated identical ping-pong is blocked as a loop', async () => {
    const { store, broker } = rig();
    const lm = uid('lm');
    const target = uid('tgt');
    register(store, lm, ['register', 'observe', 'mailbox', 'tool_call'], 'lmstudio');
    register(store, target, ['register', 'observe', 'mailbox']);
    store.grant({ source_session_id: lm, target_session_id: target, ttl_ms: 600_000, max_messages: 50 }, T0);

    // Threshold is 3 identical messages in the window; the 4th trips loop detection.
    for (let i = 0; i < 3; i++) {
      const ok = await callSend(store, broker, lm, target, 'are you done yet');
      assert.equal(ok.ok, true, `send ${i + 1} allowed`);
    }
    const blocked = await callSend(store, broker, lm, target, 'are you done yet');
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'CONTROL_LOOP_DETECTED');
  });
});

// ─── Diagnostics contract (verify / doctor / info) ──────────────────────────

describe('control diagnostics', () => {
  let savedFetch: typeof fetch | undefined;

  beforeEach(() => {
    savedFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    // Keep doctor/info provider probes fast + offline.
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => {
      throw new Error('offline (test stub)');
    }) as typeof fetch;
  });

  afterEach(() => {
    if (savedFetch) (globalThis as { fetch?: typeof fetch }).fetch = savedFetch;
  });

  test('relay verify control check passes and leaves no residue', async () => {
    const before = new ControlSessionStore().listSessions().length;
    const check = await runControlCheck('tok123');
    assert.equal(check.name, 'control');
    assert.equal(check.status, 'pass');
    assert.equal(check.critical, true);
    const after = new ControlSessionStore().listSessions().length;
    assert.equal(after, before, 'control smoke is rolled back — no session residue');
  });

  test('relay verify includes the control check in its report', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'relay-e2e-'));
    const cap = makeIO(tmp);
    await executeVerifyCommand({ json: true }, cap.io);
    const parsed = JSON.parse(cap.stdout.join('').trim()) as { checks: Array<{ name: string }> };
    assert.ok(parsed.checks.some((c) => c.name === 'control'), 'control check wired into verify');
    await rm(tmp, { recursive: true, force: true });
  });

  test('relay doctor control probe reports session/queued/blocked health', async () => {
    register(new ControlSessionStore(), uid('doc'), ['register', 'mailbox']);
    const probe = await checkControlLayer();
    assert.equal(probe.name, 'control');
    assert.equal(probe.status, 'ok');
    assert.match(probe.detail, /session/i);
    assert.match(probe.detail, /queued/i);
    assert.match(probe.detail, /blocked/i);
  });

  test('relay doctor includes the control probe', async () => {
    const cap = makeIO();
    await executeDoctorCommand({ json: true }, cap.io);
    const parsed = JSON.parse(cap.stdout.join('').trim()) as { checks: Array<{ name: string }> };
    assert.ok(parsed.checks.some((c) => c.name === 'control'), 'control probe wired into doctor');
  });

  test('control adapter catalog is truthful: no ambient adapter claims live_stdin', () => {
    assert.ok(CONTROL_ADAPTER_CATALOG.length >= 6, 'every provider catalogued');
    const byProvider = new Map(CONTROL_ADAPTER_CATALOG.map((a) => [a.provider, a]));
    for (const p of ['claude-code', 'codex', 'lmstudio', 'openrouter', 'anthropic', 'fake']) {
      assert.ok(byProvider.has(p), `${p} present in catalog`);
    }
    for (const a of CONTROL_ADAPTER_CATALOG) {
      assert.ok(!a.capabilities.includes('live_stdin'), `${a.provider} ambient adapter must not claim live_stdin`);
      assert.equal(a.live_control, false, `${a.provider} ambient adapter is not live-control`);
    }
  });

  test('relay info control rollup counts live sessions', async () => {
    register(new ControlSessionStore(), uid('info'), ['register', 'mailbox']);
    const state = await readControlState();
    assert.ok(state.sessions.total >= 1, 'sessions counted from the live tables');
    assert.ok(state.adapters.length >= 6, 'catalog surfaced in info');
    assert.equal(typeof state.queued, 'number');
    assert.equal(typeof state.blocked, 'number');
  });

  test('relay info includes the control section', async () => {
    const cap = makeIO();
    await executeInfoCommand({ json: true }, cap.io, '0.1.2');
    const parsed = JSON.parse(cap.stdout.join('').trim()) as { control?: unknown };
    assert.ok(parsed.control && typeof parsed.control === 'object', 'control section wired into info');
  });
});

// ─── Docs contract (Task 3) ─────────────────────────────────────────────────

async function readRepoFile(rel: string): Promise<string> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  // dist/control/control-e2e.test.js → repo root is ../../
  const here = new URL('.', import.meta.url).pathname;
  const root = path.resolve(here, '..', '..');
  return fs.readFile(path.join(root, rel), 'utf-8');
}

describe('control docs contract', () => {
  test('README frames live control truthfully — not every adapter', async () => {
    const readme = await readRepoFile('README.md');
    assert.doesNotMatch(
      readme,
      /(all|every)\s+(adapters?|providers?|tools?)[^.\n]*\blive\b/i,
      'README must not claim every adapter supports live control',
    );
    assert.match(
      readme,
      /(live[\s\S]{0,90}(Relay-owned|Relay-launched|relay session spawn))|((Relay-owned|Relay-launched|relay session spawn)[\s\S]{0,90}live)/i,
      'README ties live (stdin) control to Relay-owned processes',
    );
  });

  test('commands.md documents every relay session subcommand', async () => {
    const docs = await readRepoFile('docs/commands.md');
    for (const sub of [
      'list', 'inspect', 'tail', 'send', 'delegate', 'spawn',
      'grant', 'revoke', 'pause', 'resume', 'approve', 'deny',
    ]) {
      assert.match(docs, new RegExp(`relay session ${sub}\\b`), `commands.md documents 'relay session ${sub}'`);
    }
  });

  test('providers.md documents capability levels + the Relay-owned live mode', async () => {
    const docs = await readRepoFile('docs/providers.md');
    for (const cap of ['register', 'observe', 'mailbox', 'context_inject', 'resume_send', 'live_stdin']) {
      assert.match(docs, new RegExp(cap), `providers.md names the ${cap} capability`);
    }
    for (const provider of ['claude-code', 'codex', 'lmstudio', 'openrouter', 'anthropic']) {
      assert.match(docs, new RegExp(provider), `providers.md covers ${provider}`);
    }
    assert.match(docs, /relay session spawn/i, 'providers.md documents the Relay-owned process strong mode');
  });
});
