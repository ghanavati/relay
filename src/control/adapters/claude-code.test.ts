/**
 * Phase 8 / Plan 04 / Task 1 — Claude Code ambient control adapter.
 *
 * Covers: synthetic SessionStart / UserPromptSubmit / SessionEnd hook payload
 * parsing (absence vs parse-error), session registration / refresh /
 * stop-marking, truthful ambient capabilities (no live_stdin, no resume_send
 * — D-07/CONTROL-06), mailbox delivery buffering + additionalContext
 * rendering, and the `relay context emit --target cc` hook integration that
 * extends the existing memory-injection pipeline WITHOUT breaking it.
 *
 * Uses a shared :memory: SQLite DB per process; unique session/message ids
 * per test avoid cross-test bleed. No real Claude Code, no real stdin — hook
 * payloads are synthetic and the stdin reader is injected.
 */

process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';

import { getDb } from '../../runtime/store/db.js';
import { MemoryStore } from '../../memory/memory-store.js';
import { ControlSessionStore } from '../session-store.js';
import { ControlBroker } from '../broker.js';
import { ControlAdapterRegistry } from '../adapter-registry.js';
import {
  CLAUDE_CODE_AMBIENT_CAPABILITIES,
  ClaudeCodeControlAdapter,
  parseClaudeHookPayload,
  renderMailboxContext,
  type ClaudeHookPayload,
} from './claude-code.js';
import { executeContextEmitCommand } from '../../cli/cmd-context-emit.js';
import type { CliIO } from '../../cli/commands.js';

const T0 = 1_780_000_000_000; // fixed epoch-ms base for deterministic clocks

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-cc${counter}`;
}

function errCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code ?? 'NO_CODE';
  }
  return 'NO_THROW';
}

function makePayload(overrides: Partial<Record<string, unknown>> = {}): ClaudeHookPayload {
  const parsed = parseClaudeHookPayload(
    JSON.stringify({
      session_id: uid('sess'),
      hook_event_name: 'SessionStart',
      transcript_path: '/tmp/cc/transcript.jsonl',
      cwd: '/tmp/cc/project',
      source: 'startup', // extra CC field — must be tolerated
      ...overrides,
    }),
  );
  assert.ok(parsed, 'fixture payload must parse');
  return parsed;
}

function makeRig(): {
  store: ControlSessionStore;
  broker: ControlBroker;
  registry: ControlAdapterRegistry;
  adapter: ClaudeCodeControlAdapter;
} {
  const store = new ControlSessionStore();
  const broker = new ControlBroker(store);
  const registry = new ControlAdapterRegistry(store, broker);
  const adapter = new ClaudeCodeControlAdapter(store);
  registry.register(adapter);
  return { store, broker, registry, adapter };
}

interface CapturedIO {
  io: CliIO;
  stdout: string[];
  stderr: string[];
}

function makeIO(cwd: string): CapturedIO {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { cwd, stdout: (m) => stdout.push(m), stderr: (m) => stderr.push(m) },
    stdout,
    stderr,
  };
}

// ─── Payload parsing (absence vs parse error) ───────────────────────────────

describe('parseClaudeHookPayload', () => {
  test('parses a valid SessionStart payload and tolerates extra CC fields', () => {
    const raw = JSON.stringify({
      session_id: 'abc-123',
      hook_event_name: 'SessionStart',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/tmp/proj',
      source: 'startup',
      model: 'claude-x',
    });
    const parsed = parseClaudeHookPayload(raw);
    assert.ok(parsed);
    assert.equal(parsed.session_id, 'abc-123');
    assert.equal(parsed.hook_event_name, 'SessionStart');
    assert.equal(parsed.transcript_path, '/tmp/t.jsonl');
    assert.equal(parsed.cwd, '/tmp/proj');
  });

  test('parses UserPromptSubmit and SessionEnd events', () => {
    for (const event of ['UserPromptSubmit', 'SessionEnd'] as const) {
      const parsed = parseClaudeHookPayload(
        JSON.stringify({ session_id: 's1', hook_event_name: event }),
      );
      assert.ok(parsed);
      assert.equal(parsed.hook_event_name, event);
    }
  });

  test('absence: undefined, empty, and whitespace-only input return undefined', () => {
    assert.equal(parseClaudeHookPayload(undefined), undefined);
    assert.equal(parseClaudeHookPayload(null), undefined);
    assert.equal(parseClaudeHookPayload(''), undefined);
    assert.equal(parseClaudeHookPayload('   \n\t '), undefined);
  });

  test('parse error: invalid JSON throws RelayError INVALID_ARGS (not absence)', () => {
    assert.equal(errCode(() => parseClaudeHookPayload('not-json{')), 'INVALID_ARGS');
  });

  test('parse error: JSON missing session_id throws INVALID_ARGS', () => {
    assert.equal(
      errCode(() => parseClaudeHookPayload(JSON.stringify({ hook_event_name: 'SessionStart' }))),
      'INVALID_ARGS',
    );
  });

  test('parse error: unsupported hook_event_name throws INVALID_ARGS', () => {
    assert.equal(
      errCode(() =>
        parseClaudeHookPayload(
          JSON.stringify({ session_id: 's1', hook_event_name: 'PreToolUse' }),
        ),
      ),
      'INVALID_ARGS',
    );
  });
});

// ─── Truthful ambient capabilities (D-07) ───────────────────────────────────

describe('ClaudeCodeControlAdapter — capabilities', () => {
  test('ambient capability set is exactly register/observe/context_inject/mailbox', () => {
    const adapter = new ClaudeCodeControlAdapter(new ControlSessionStore());
    assert.deepEqual(
      [...adapter.describeCapabilities()],
      ['register', 'observe', 'context_inject', 'mailbox'],
    );
    assert.deepEqual([...CLAUDE_CODE_AMBIENT_CAPABILITIES], [
      'register',
      'observe',
      'context_inject',
      'mailbox',
    ]);
  });

  test('never claims live control for ambient sessions (no live_stdin/resume_send)', () => {
    const adapter = new ClaudeCodeControlAdapter(new ControlSessionStore());
    assert.equal(adapter.supports('mailbox'), true);
    assert.equal(adapter.supports('context_inject'), true);
    assert.equal(adapter.supports('observe'), true);
    assert.equal(adapter.supports('register'), true);
    assert.equal(adapter.supports('live_stdin'), false);
    assert.equal(adapter.supports('resume_send'), false);
    assert.equal(adapter.supports('interrupt'), false);
    assert.equal(adapter.supports('fork'), false);
    assert.equal(adapter.supports('spawn'), false);
  });
});

// ─── Hook payload registration / refresh / stop-marking ────────────────────

describe('ClaudeCodeControlAdapter.applyHookPayload', () => {
  test('SessionStart registers an active session with workdir + transcript metadata', () => {
    const { store, adapter } = makeRig();
    const payload = makePayload();
    const session = adapter.applyHookPayload(payload, T0);

    assert.equal(session.session_id, payload.session_id);
    assert.equal(session.provider, 'claude-code');
    assert.equal(session.state, 'active');
    assert.equal(session.workdir, '/tmp/cc/project');
    assert.equal(session.metadata?.['transcript_path'], '/tmp/cc/transcript.jsonl');
    assert.deepEqual([...session.capabilities], [...CLAUDE_CODE_AMBIENT_CAPABILITIES]);
    assert.equal(session.registered_at, T0);
    assert.equal(session.last_seen_at, T0);

    const events = store.tailEvents(payload.session_id);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event_type, 'session_registered');
  });

  test('UserPromptSubmit on a known session refreshes last_seen and appends session_updated', () => {
    const { store, adapter } = makeRig();
    const start = makePayload();
    adapter.applyHookPayload(start, T0);

    const prompt = parseClaudeHookPayload(
      JSON.stringify({
        session_id: start.session_id,
        hook_event_name: 'UserPromptSubmit',
        cwd: '/tmp/cc/project',
      }),
    );
    assert.ok(prompt);
    const session = adapter.applyHookPayload(prompt, T0 + 5_000);

    assert.equal(session.state, 'active');
    assert.equal(session.registered_at, T0, 'registered_at preserved');
    assert.equal(session.last_seen_at, T0 + 5_000, 'last_seen bumped');

    const events = store.tailEvents(start.session_id);
    assert.deepEqual(
      events.map((e) => e.event_type),
      ['session_registered', 'session_updated'],
    );
  });

  test('SessionEnd marks a known session ended and appends session_ended', () => {
    const { store, adapter } = makeRig();
    const start = makePayload();
    adapter.applyHookPayload(start, T0);

    const end = parseClaudeHookPayload(
      JSON.stringify({ session_id: start.session_id, hook_event_name: 'SessionEnd' }),
    );
    assert.ok(end);
    const session = adapter.applyHookPayload(end, T0 + 60_000);

    assert.equal(session.state, 'ended');
    const events = store.tailEvents(start.session_id);
    assert.deepEqual(
      events.map((e) => e.event_type),
      ['session_registered', 'session_ended'],
    );
  });

  test('SessionEnd for an unknown session registers it directly as ended', () => {
    const { adapter } = makeRig();
    const end = makePayload({ hook_event_name: 'SessionEnd' });
    const session = adapter.applyHookPayload(end, T0);
    assert.equal(session.state, 'ended');
  });

  test('update without cwd preserves the previously recorded workdir', () => {
    const { adapter } = makeRig();
    const start = makePayload();
    adapter.applyHookPayload(start, T0);

    const prompt = parseClaudeHookPayload(
      JSON.stringify({ session_id: start.session_id, hook_event_name: 'UserPromptSubmit' }),
    );
    assert.ok(prompt);
    const session = adapter.applyHookPayload(prompt, T0 + 1_000);
    assert.equal(session.workdir, '/tmp/cc/project');
  });
});

// ─── Mailbox delivery + additionalContext rendering ─────────────────────────

describe('ClaudeCodeControlAdapter — mailbox delivery at hook boundaries', () => {
  test('queued message drains through the registry as context_inject and renders as additionalContext', async () => {
    const { store, broker, registry, adapter } = makeRig();
    const payload = makePayload();
    adapter.applyHookPayload(payload, T0);

    const message = broker.sendMessage(
      {
        source_session_id: uid('human'),
        target_session_id: payload.session_id,
        sender_kind: 'human',
        content: 'please run the integration suite before merging',
      },
      T0 + 1,
    );

    const reports = await registry.deliverQueued(payload.session_id, T0 + 2);
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.ok, true);
    assert.equal(reports[0]?.capability, 'context_inject');

    assert.equal(store.getMessage(message.message_id)?.status, 'delivered');
    const attempts = store.listDeliveryAttempts(message.message_id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.status, 'success');
    assert.equal(attempts[0]?.capability, 'context_inject');

    const rendered = adapter.takePendingContext(payload.session_id);
    assert.ok(rendered, 'rendered block expected');
    assert.match(rendered, /please run the integration suite before merging/);
    assert.match(rendered, /Relay/i);
    assert.equal(adapter.takePendingContext(payload.session_id), undefined, 'take clears the buffer');
  });

  test('renderMailboxContext renders source, sender kind, and content for every message (oldest first)', () => {
    const { store, broker, registry, adapter } = makeRig();
    void registry;
    const payload = makePayload();
    adapter.applyHookPayload(payload, T0);

    const sourceA = uid('peer');
    const m1 = broker.sendMessage(
      {
        source_session_id: sourceA,
        target_session_id: payload.session_id,
        sender_kind: 'human',
        content: 'first queued note',
      },
      T0 + 1,
    );
    const m2 = broker.sendMessage(
      {
        source_session_id: sourceA,
        target_session_id: payload.session_id,
        sender_kind: 'human',
        content: 'second queued note',
      },
      T0 + 2,
    );

    const rendered = renderMailboxContext([
      store.getMessage(m1.message_id)!,
      store.getMessage(m2.message_id)!,
    ]);
    assert.match(rendered, /first queued note/);
    assert.match(rendered, /second queued note/);
    assert.ok(
      rendered.indexOf('first queued note') < rendered.indexOf('second queued note'),
      'oldest first',
    );
    assert.match(rendered, new RegExp(sourceA));
    assert.match(rendered, /human/);
  });
});

// ─── `relay context emit --target cc` hook integration ──────────────────────

describe('executeContextEmitCommand — claude hook payload integration', () => {
  const WORKDIR = '/tmp/relay-claude-adapter-test';
  const SEEDED = 'control-suite seeded lesson alpha';

  beforeEach(() => {
    getDb().prepare('DELETE FROM memories').run();
    const memories = new MemoryStore();
    const id = memories.remember({
      content: SEEDED,
      memory_type: 'lesson',
      workdir: WORKDIR,
      memory_source: 'human',
    });
    memories.upgradeTrust(id);
  });

  function emitCommand(): {
    target: 'cc';
    workdir: string;
    tokenBudget: number;
    types: ('lesson' | 'fact' | 'decision' | 'context')[];
  } {
    return {
      target: 'cc',
      workdir: WORKDIR,
      tokenBudget: 800,
      types: ['lesson', 'fact', 'decision', 'context'],
    };
  }

  function parseEnvelope(stdout: string[]): {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  } {
    return JSON.parse(stdout.join('').trim()) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
  }

  test('SessionStart payload registers the session and appends queued messages after memories', async () => {
    const { broker, adapter } = makeRig();
    const store = new ControlSessionStore();
    const payload = makePayload();
    adapter.applyHookPayload(payload, T0);
    const message = broker.sendMessage(
      {
        source_session_id: uid('peer'),
        target_session_id: payload.session_id,
        sender_kind: 'human',
        content: 'cross-session ping for session start',
      },
      T0 + 1,
    );

    const cap = makeIO(WORKDIR);
    const code = await executeContextEmitCommand(emitCommand(), cap.io, {
      readStdin: async () =>
        JSON.stringify({
          session_id: payload.session_id,
          hook_event_name: 'SessionStart',
          transcript_path: '/tmp/cc/transcript.jsonl',
          cwd: WORKDIR,
        }),
    });

    assert.equal(code, 0);
    const envelope = parseEnvelope(cap.stdout);
    assert.equal(envelope.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(envelope.hookSpecificOutput.additionalContext, new RegExp(SEEDED));
    assert.match(
      envelope.hookSpecificOutput.additionalContext,
      /cross-session ping for session start/,
    );
    assert.equal(store.getMessage(message.message_id)?.status, 'delivered');
    assert.equal(store.getSession(payload.session_id)?.workdir, WORKDIR);
  });

  test('UserPromptSubmit payload delivers queued messages WITHOUT re-injecting memories', async () => {
    const { broker, adapter } = makeRig();
    const store = new ControlSessionStore();
    const payload = makePayload();
    adapter.applyHookPayload(payload, T0);
    broker.sendMessage(
      {
        source_session_id: uid('peer'),
        target_session_id: payload.session_id,
        sender_kind: 'human',
        content: 'mid-session mailbox delivery',
      },
      T0 + 1,
    );

    const cap = makeIO(WORKDIR);
    const code = await executeContextEmitCommand(emitCommand(), cap.io, {
      readStdin: async () =>
        JSON.stringify({
          session_id: payload.session_id,
          hook_event_name: 'UserPromptSubmit',
          cwd: WORKDIR,
          prompt: 'what is next?',
        }),
    });

    assert.equal(code, 0);
    const envelope = parseEnvelope(cap.stdout);
    assert.equal(envelope.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(envelope.hookSpecificOutput.additionalContext, /mid-session mailbox delivery/);
    assert.doesNotMatch(
      envelope.hookSpecificOutput.additionalContext,
      new RegExp(SEEDED),
      'UserPromptSubmit must not re-inject recalled memories on every prompt',
    );
    assert.equal(store.getSession(payload.session_id)?.state, 'active');
  });

  test('UserPromptSubmit for an unknown session registers it and emits an empty context', async () => {
    const store = new ControlSessionStore();
    const sessionId = uid('fresh');

    const cap = makeIO(WORKDIR);
    const code = await executeContextEmitCommand(emitCommand(), cap.io, {
      readStdin: async () =>
        JSON.stringify({ session_id: sessionId, hook_event_name: 'UserPromptSubmit', cwd: WORKDIR }),
    });

    assert.equal(code, 0);
    const envelope = parseEnvelope(cap.stdout);
    assert.equal(envelope.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.equal(envelope.hookSpecificOutput.additionalContext, '');
    assert.equal(store.getSession(sessionId)?.state, 'active');
  });

  test('SessionEnd payload stop-marks the session, leaves queued messages queued, and emits empty context', async () => {
    const { broker, adapter } = makeRig();
    const store = new ControlSessionStore();
    const payload = makePayload();
    adapter.applyHookPayload(payload, T0);
    const message = broker.sendMessage(
      {
        source_session_id: uid('peer'),
        target_session_id: payload.session_id,
        sender_kind: 'human',
        content: 'arrived after the session ended',
      },
      T0 + 1,
    );

    const cap = makeIO(WORKDIR);
    const code = await executeContextEmitCommand(emitCommand(), cap.io, {
      readStdin: async () =>
        JSON.stringify({ session_id: payload.session_id, hook_event_name: 'SessionEnd' }),
    });

    assert.equal(code, 0);
    const envelope = parseEnvelope(cap.stdout);
    assert.equal(envelope.hookSpecificOutput.hookEventName, 'SessionEnd');
    assert.equal(envelope.hookSpecificOutput.additionalContext, '');
    assert.equal(store.getSession(payload.session_id)?.state, 'ended');
    assert.equal(
      store.getMessage(message.message_id)?.status,
      'queued',
      'SessionEnd must not consume the mailbox',
    );
  });

  test('malformed hook payload degrades gracefully to the legacy memory-only emit (exit 0)', async () => {
    const cap = makeIO(WORKDIR);
    const code = await executeContextEmitCommand(emitCommand(), cap.io, {
      readStdin: async () => 'garbage{not-json',
    });

    assert.equal(code, 0, 'hooks must never break CC startup');
    const envelope = parseEnvelope(cap.stdout);
    assert.equal(envelope.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(envelope.hookSpecificOutput.additionalContext, new RegExp(SEEDED));
    assert.match(cap.stderr.join(''), /hook payload/i, 'parse errors are surfaced on stderr');
  });

  test('empty stdin keeps the legacy SessionStart memory emit byte-compatible', async () => {
    const cap = makeIO(WORKDIR);
    const code = await executeContextEmitCommand(emitCommand(), cap.io, {
      readStdin: async () => '',
    });

    assert.equal(code, 0);
    const envelope = parseEnvelope(cap.stdout);
    assert.equal(envelope.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(envelope.hookSpecificOutput.additionalContext, new RegExp(SEEDED));
    assert.equal(cap.stderr.join(''), '');
  });
});
