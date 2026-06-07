/**
 * Phase 8 / Plan 04 / Task 2 — conservative Codex control adapter.
 *
 * D-09 / CONTROL-08: capability discovery, never assumption. `tool_call` only
 * with a Relay MCP server entry, `context_inject` only with the Relay-managed
 * instructions block, `mailbox` only when a delivery surface exists, and
 * `live_stdin`/`resume_send` NEVER — full-TTY control of sessions Relay does
 * not own is out of v1 scope and is reported truthfully absent.
 *
 * Probes run against temp-dir fixtures (never the real ~/.codex). Sessions
 * share the per-process :memory: DB; unique ids avoid cross-test bleed.
 */

process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ControlSessionStore } from '../session-store.js';
import { ControlBroker } from '../broker.js';
import { ControlAdapterRegistry } from '../adapter-registry.js';
import {
  CodexControlAdapter,
  deriveCodexCapabilities,
  probeCodexControlSetup,
  RELAY_MANAGED_START,
  RELAY_MANAGED_END,
} from './codex.js';

const T0 = 1_780_100_000_000;

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-cx${counter}`;
}

function errCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code ?? 'NO_CODE';
  }
  return 'NO_THROW';
}

// ─── Capability derivation (D-09) ───────────────────────────────────────────

describe('deriveCodexCapabilities', () => {
  test('no integration → register only (no delivery surface, no tools)', () => {
    const caps = deriveCodexCapabilities({ instructions_present: false, mcp_configured: false });
    assert.deepEqual([...caps], ['register']);
  });

  test('instructions only → register + context_inject + mailbox, no tool_call', () => {
    const caps = deriveCodexCapabilities({ instructions_present: true, mcp_configured: false });
    assert.deepEqual([...caps], ['register', 'context_inject', 'mailbox']);
  });

  test('MCP only → register + mailbox + tool_call, no context_inject', () => {
    const caps = deriveCodexCapabilities({ instructions_present: false, mcp_configured: true });
    assert.deepEqual([...caps], ['register', 'mailbox', 'tool_call']);
  });

  test('both surfaces → register + context_inject + mailbox + tool_call', () => {
    const caps = deriveCodexCapabilities({ instructions_present: true, mcp_configured: true });
    assert.deepEqual([...caps], ['register', 'context_inject', 'mailbox', 'tool_call']);
  });

  test('live_stdin and resume_send are NEVER derived, in any combination', () => {
    for (const instructions_present of [false, true]) {
      for (const mcp_configured of [false, true]) {
        const caps = deriveCodexCapabilities({ instructions_present, mcp_configured });
        assert.ok(!caps.includes('live_stdin'), 'live_stdin must never be claimed');
        assert.ok(!caps.includes('resume_send'), 'resume_send must never be claimed');
        assert.ok(!caps.includes('interrupt'), 'interrupt must never be claimed');
        assert.ok(!caps.includes('spawn'), 'spawn must never be claimed');
        assert.ok(!caps.includes('fork'), 'fork must never be claimed');
      }
    }
  });
});

// ─── Filesystem probe (conservative discovery) ──────────────────────────────

describe('probeCodexControlSetup', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-codex-probe-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function paths(): { agentsPath: string; configPath: string } {
    return {
      agentsPath: join(tmp, 'AGENTS.md'),
      configPath: join(tmp, 'config.toml'),
    };
  }

  test('missing files → both surfaces absent (ENOENT is "not configured", not an error)', async () => {
    const probe = await probeCodexControlSetup(paths());
    assert.equal(probe.instructions_present, false);
    assert.equal(probe.mcp_configured, false);
  });

  test('AGENTS.md with the relay-managed block → instructions_present', async () => {
    await mkdir(tmp, { recursive: true });
    await writeFile(
      paths().agentsPath,
      `# My instructions\n\n${RELAY_MANAGED_START}\nRelay block\n${RELAY_MANAGED_END}\n`,
      'utf-8',
    );
    const probe = await probeCodexControlSetup(paths());
    assert.equal(probe.instructions_present, true);
    assert.equal(probe.mcp_configured, false);
  });

  test('AGENTS.md without relay markers → instructions absent', async () => {
    await writeFile(paths().agentsPath, '# user-only instructions, no relay block\n', 'utf-8');
    const probe = await probeCodexControlSetup(paths());
    assert.equal(probe.instructions_present, false);
  });

  test('config.toml with [mcp_servers.relay] → mcp_configured', async () => {
    await writeFile(
      paths().configPath,
      'model = "gpt-x"\n\n[mcp_servers.relay]\ncommand = "relay"\nargs = ["mcp"]\n',
      'utf-8',
    );
    const probe = await probeCodexControlSetup(paths());
    assert.equal(probe.mcp_configured, true);
    assert.equal(probe.instructions_present, false);
  });

  test('config.toml with quoted [mcp_servers."relay-mcp"] → mcp_configured', async () => {
    await writeFile(
      paths().configPath,
      '[mcp_servers."relay-mcp"]\ncommand = "relay-mcp"\n',
      'utf-8',
    );
    const probe = await probeCodexControlSetup(paths());
    assert.equal(probe.mcp_configured, true);
  });

  test('config.toml with only foreign MCP servers → mcp absent (never overclaim)', async () => {
    await writeFile(
      paths().configPath,
      '[mcp_servers.github]\ncommand = "gh-mcp"\n\n[mcp_servers.relayish-other]\ncommand = "x"\n',
      'utf-8',
    );
    const probe = await probeCodexControlSetup(paths());
    assert.equal(probe.mcp_configured, false);
  });
});

// ─── Adapter behavior ───────────────────────────────────────────────────────

describe('CodexControlAdapter', () => {
  test('default adapter is register-only and never claims live control', () => {
    const adapter = new CodexControlAdapter();
    assert.equal(adapter.provider, 'codex');
    assert.deepEqual([...adapter.describeCapabilities()], ['register']);
    assert.equal(adapter.supports('register'), true);
    assert.equal(adapter.supports('live_stdin'), false);
    assert.equal(adapter.supports('resume_send'), false);
    assert.equal(adapter.supports('tool_call'), false);
    assert.equal(adapter.supports('context_inject'), false);
  });

  test('discover() builds the adapter from the probed surfaces', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'relay-codex-disc-'));
    try {
      const agentsPath = join(tmp, 'AGENTS.md');
      const configPath = join(tmp, 'config.toml');
      await writeFile(agentsPath, `${RELAY_MANAGED_START}\nblock\n${RELAY_MANAGED_END}\n`, 'utf-8');

      const adapter = await CodexControlAdapter.discover({ agentsPath, configPath });
      assert.deepEqual(
        [...adapter.describeCapabilities()],
        ['register', 'context_inject', 'mailbox'],
      );
      assert.equal(adapter.supports('tool_call'), false, 'no MCP entry → no tool_call');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('registerSession records a codex session carrying the discovered capabilities', () => {
    const store = new ControlSessionStore();
    const adapter = new CodexControlAdapter(
      deriveCodexCapabilities({ instructions_present: true, mcp_configured: true }),
      store,
    );
    const sessionId = uid('codex');
    const session = adapter.registerSession(
      { session_id: sessionId, label: 'codex shell', workdir: '/tmp/proj' },
      T0,
    );

    assert.equal(session.session_id, sessionId);
    assert.equal(session.provider, 'codex');
    assert.equal(session.state, 'active');
    assert.equal(session.label, 'codex shell');
    assert.deepEqual(
      [...session.capabilities],
      ['register', 'context_inject', 'mailbox', 'tool_call'],
    );

    const events = store.tailEvents(sessionId);
    assert.equal(events[0]?.event_type, 'session_registered');

    const again = adapter.registerSession({ session_id: sessionId }, T0 + 1_000);
    assert.equal(again.last_seen_at, T0 + 1_000);
    assert.equal(store.tailEvents(sessionId)[1]?.event_type, 'session_updated');
  });

  test('instructions-capable session drains queued messages as context_inject at a render boundary', async () => {
    const store = new ControlSessionStore();
    const broker = new ControlBroker(store);
    const registry = new ControlAdapterRegistry(store, broker);
    const adapter = new CodexControlAdapter(
      deriveCodexCapabilities({ instructions_present: true, mcp_configured: false }),
      store,
    );
    registry.register(adapter);

    const sessionId = uid('codex');
    adapter.registerSession({ session_id: sessionId }, T0);
    const message = broker.sendMessage(
      {
        source_session_id: uid('peer'),
        target_session_id: sessionId,
        sender_kind: 'human',
        content: 'review the diff before approving',
      },
      T0 + 1,
    );

    const reports = await registry.deliverQueued(sessionId, T0 + 2);
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.ok, true);
    assert.equal(reports[0]?.capability, 'context_inject');
    assert.equal(store.getMessage(message.message_id)?.status, 'delivered');

    const rendered = adapter.takePendingInstructions(sessionId);
    assert.ok(rendered);
    assert.match(rendered, /review the diff before approving/);
    assert.equal(adapter.takePendingInstructions(sessionId), undefined, 'take clears the buffer');
  });

  test('register-only codex session cannot be sent to (broker refuses — no delivery capability)', () => {
    const store = new ControlSessionStore();
    const broker = new ControlBroker(store);
    const adapter = new CodexControlAdapter(
      deriveCodexCapabilities({ instructions_present: false, mcp_configured: false }),
      store,
    );
    const sessionId = uid('codex');
    adapter.registerSession({ session_id: sessionId }, T0);

    const code = errCode(() =>
      broker.sendMessage(
        {
          source_session_id: uid('peer'),
          target_session_id: sessionId,
          sender_kind: 'human',
          content: 'this must be refused, not silently dropped',
        },
        T0 + 1,
      ),
    );
    assert.equal(code, 'CONTROL_DELIVERY_UNSUPPORTED');
  });

  test('mcp-only session queues messages for tool pull (send accepted, stays queued)', () => {
    const store = new ControlSessionStore();
    const broker = new ControlBroker(store);
    const adapter = new CodexControlAdapter(
      deriveCodexCapabilities({ instructions_present: false, mcp_configured: true }),
      store,
    );
    const sessionId = uid('codex');
    adapter.registerSession({ session_id: sessionId }, T0);

    const message = broker.sendMessage(
      {
        source_session_id: uid('peer'),
        target_session_id: sessionId,
        sender_kind: 'human',
        content: 'waiting for the codex tool pull',
      },
      T0 + 1,
    );
    assert.equal(store.getMessage(message.message_id)?.status, 'queued');
    assert.equal(store.getQueuedMessages(sessionId, T0 + 2).length, 1);
  });
});
