/**
 * Phase 8 / Plan 05 / Task 1 — Relay-owned process sessions.
 *
 * Exercises ProcessSession against REAL child processes (node `-e` one-liners,
 * no external deps, deterministic): spawn + stdout/stderr tail events, stdin
 * send (live_stdin), SIGINT interrupt, stopped-state recording, the mailbox →
 * live-stdin bridge (a peer `relay session send` reaching a running process),
 * the truthful capability policy (full-TTY providers withhold live_stdin), and
 * the `relay session spawn` dispatch through executeSessionCommand.
 *
 * Shares a single :memory: DB (db.ts module cache). Unique session ids per
 * test avoid cross-test bleed.
 */

process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { execPath } from 'node:process';

import { ControlSessionStore } from './session-store.js';
import { ControlBroker } from './broker.js';
import type { ControlEvent } from './types.js';
import type { CliIO } from '../cli/commands.js';
import { executeSessionCommand, type SessionCommandOptions } from '../cli/cmd-session.js';
import {
  ProcessSession,
  drainMailboxToProcess,
  relayProcessCapabilities,
  type ProcessLine,
} from './pty-session.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-p${counter}`;
}

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

/** A child that echoes each stdin line back to stdout as `echo:<line>`. */
const ECHO_LOOP = [
  execPath,
  '-e',
  "const rl=require('readline').createInterface({input:process.stdin});" +
    "rl.on('line',l=>process.stdout.write('echo:'+l+'\\n'));" +
    "rl.on('close',()=>process.exit(0));",
];

/** A child that writes one stdout line then exits 0. */
function quickWriter(text: string): string[] {
  return [execPath, '-e', `process.stdout.write(${JSON.stringify(text + '\n')});process.exit(0);`];
}

function outputLines(events: readonly ControlEvent[]): Array<{ stream: string; text: string }> {
  return events
    .filter((e) => e.event_type === 'session_updated' && (e.payload as { kind?: unknown }).kind === 'process_output')
    .map((e) => {
      const p = e.payload as { stream?: unknown; text?: unknown };
      return { stream: String(p.stream), text: String(p.text) };
    });
}

function endedEvent(events: readonly ControlEvent[]): ControlEvent | undefined {
  return events.find((e) => e.event_type === 'session_ended');
}

function opts(extra: Partial<SessionCommandOptions> = {}): SessionCommandOptions {
  return { action: 'spawn', positionals: [], json: true, ...extra };
}

// ─── Capability policy ───────────────────────────────────────────────────────

describe('relayProcessCapabilities', () => {
  test('pipe-friendly providers declare live_stdin + interrupt', () => {
    const caps = relayProcessCapabilities('fake');
    assert.ok(caps.includes('live_stdin'), 'fake process owns a live stdin channel');
    assert.ok(caps.includes('interrupt'), 'owned process can be interrupted');
    assert.ok(caps.includes('observe') && caps.includes('tail') && caps.includes('mailbox'));
  });

  test('full-TTY providers (claude-code, codex) withhold live_stdin but keep interrupt', () => {
    for (const provider of ['claude-code', 'codex'] as const) {
      const caps = relayProcessCapabilities(provider);
      assert.ok(!caps.includes('live_stdin'), `${provider} detects non-TTY — no live_stdin (D-01)`);
      assert.ok(caps.includes('interrupt'), `${provider} is still interruptible when Relay owns it`);
      assert.ok(caps.includes('observe'), `${provider} output is still observable`);
    }
  });
});

// ─── ProcessSession ───────────────────────────────────────────────────────────

describe('ProcessSession', () => {
  test('spawn registers an active session with truthful capabilities', () => {
    const store = new ControlSessionStore();
    const id = uid('spawn');
    const session = new ProcessSession({ sessionId: id, provider: 'fake', command: ECHO_LOOP, store });
    try {
      const registered = session.start();
      assert.equal(registered.session_id, id);
      assert.equal(registered.state, 'active');
      assert.equal(registered.provider, 'fake');
      assert.ok(registered.capabilities.includes('live_stdin'));
      assert.equal(registered.pid !== null, true, 'owned process records its pid');
    } finally {
      session.stop();
    }
  });

  test('stdin send (live_stdin) reaches the child and tails as a stdout event', async () => {
    const store = new ControlSessionStore();
    const id = uid('stdin');
    const session = new ProcessSession({ sessionId: id, provider: 'fake', command: ECHO_LOOP, store });
    session.start();
    try {
      session.sendLine('ping-123');
      const line = await session.waitForLine((l: ProcessLine) => l.stream === 'stdout' && l.text.includes('ping-123'), 5000);
      assert.match(line.text, /echo:ping-123/);
      // Tailed as a control event Relay can observe.
      const lines = outputLines(store.tailEvents(id, { limit: 1000 }));
      assert.ok(lines.some((l) => l.stream === 'stdout' && l.text.includes('ping-123')));
    } finally {
      session.stop();
      await session.waitForExit(5000).catch(() => undefined);
    }
  });

  test('stderr output is captured and tailed as a stderr event', async () => {
    const store = new ControlSessionStore();
    const id = uid('stderr');
    const command = [
      execPath,
      '-e',
      "process.stderr.write('boom-err\\n');setTimeout(()=>process.exit(0),100);",
    ];
    const session = new ProcessSession({ sessionId: id, provider: 'fake', command, store });
    session.start();
    const line = await session.waitForLine((l) => l.stream === 'stderr' && l.text.includes('boom-err'), 5000);
    assert.match(line.text, /boom-err/);
    await session.waitForExit(5000);
    const lines = outputLines(store.tailEvents(id, { limit: 1000 }));
    assert.ok(lines.some((l) => l.stream === 'stderr' && l.text.includes('boom-err')));
  });

  test('SIGINT interrupt stops the process and records stopped-state', async () => {
    const store = new ControlSessionStore();
    const id = uid('sigint');
    const session = new ProcessSession({ sessionId: id, provider: 'fake', command: ECHO_LOOP, store });
    session.start();
    session.interrupt();
    const exit = await session.waitForExit(5000);
    assert.equal(exit.signal, 'SIGINT', 'child terminated by the forwarded SIGINT');
    assert.equal(session.exited, true);
    // Stopped-state recording: session ended + session_ended audit event.
    const after = store.getSession(id);
    assert.equal(after?.state, 'ended');
    const ended = endedEvent(store.tailEvents(id, { limit: 1000 }));
    assert.ok(ended, 'a session_ended audit event is recorded on stop');
    assert.equal((ended!.payload as { signal?: unknown }).signal, 'SIGINT');
  });

  test('normal exit records the exit code in stopped-state', async () => {
    const store = new ControlSessionStore();
    const id = uid('exit0');
    const session = new ProcessSession({ sessionId: id, provider: 'fake', command: quickWriter('ready'), store });
    session.start();
    const exit = await session.waitForExit(5000);
    assert.equal(exit.code, 0);
    assert.equal(store.getSession(id)?.state, 'ended');
    const ended = endedEvent(store.tailEvents(id, { limit: 1000 }));
    assert.equal((ended!.payload as { exit_code?: unknown }).exit_code, 0);
  });
});

// ─── Mailbox → live stdin bridge ───────────────────────────────────────────

describe('drainMailboxToProcess', () => {
  test('a peer send is delivered into the running process stdin and marked delivered', async () => {
    const store = new ControlSessionStore();
    const broker = new ControlBroker(store);
    const id = uid('bridge');
    const session = new ProcessSession({ sessionId: id, provider: 'fake', command: ECHO_LOOP, store });
    session.start();
    try {
      // A human peer queues a steering message for the owned session.
      const message = broker.sendMessage({
        source_session_id: 'human:peer',
        target_session_id: id,
        sender_kind: 'human',
        content: 'steer-now',
      });
      assert.equal(message.status, 'queued');

      const delivered = drainMailboxToProcess(session, store, broker);
      assert.equal(delivered, 1, 'one queued message drained to stdin');

      const line = await session.waitForLine((l) => l.text.includes('steer-now'), 5000);
      assert.match(line.text, /echo:steer-now/);
      assert.equal(store.getMessage(message.message_id)?.status, 'delivered');
    } finally {
      session.stop();
      await session.waitForExit(5000).catch(() => undefined);
    }
  });
});

// ─── relay session spawn dispatch ───────────────────────────────────────────

describe('executeSessionCommand spawn', () => {
  test('spawns an owned session, runs it to completion, and reports the exit code', async () => {
    const store = new ControlSessionStore();
    const id = uid('cli-spawn');
    const cap = makeIO();
    const code = await executeSessionCommand(
      opts({ provider: 'fake', positionals: quickWriter('cli-ready'), sessionId: id }),
      cap.io,
    );
    assert.equal(code, 0, 'a clean child exit maps to exit 0');
    const result = JSON.parse(cap.stdout.join('')) as {
      session_id: string;
      provider: string;
      exit_code: number | null;
      capabilities: string[];
    };
    assert.equal(result.session_id, id);
    assert.equal(result.provider, 'fake');
    assert.equal(result.exit_code, 0);
    assert.ok(result.capabilities.includes('live_stdin'));
    // The owned session is registered, observed, and ended.
    assert.equal(store.getSession(id)?.state, 'ended');
    const lines = outputLines(store.tailEvents(id, { limit: 1000 }));
    assert.ok(lines.some((l) => l.text.includes('cli-ready')), 'child stdout tailed as control events');
  });

  test('missing --provider is a usage error (exit 2)', async () => {
    const cap = makeIO();
    const code = await executeSessionCommand(opts({ positionals: quickWriter('x') }), cap.io);
    assert.equal(code, 2);
    assert.match(cap.stderr.join(''), /provider/i);
  });

  test('empty command is a usage error (exit 2)', async () => {
    const cap = makeIO();
    const code = await executeSessionCommand(opts({ provider: 'fake', positionals: [] }), cap.io);
    assert.equal(code, 2);
    assert.match(cap.stderr.join(''), /command/i);
  });
});

// ─── 08-fix MEDIUM: spawned-process secret leak ─────────────────────────────

describe('ProcessSession — sanitized child env + redacted persistence', () => {
  /** node one-liner that prints its own env as JSON and exits. */
  function envDumper(): string[] {
    return [execPath, '-e', 'process.stdout.write(JSON.stringify(process.env));process.exit(0);'];
  }

  test('owned child env drops secret-shaped + RELAY_* vars (no key/control-DB leak)', async () => {
    const store = new ControlSessionStore();
    const id = uid('env-strip');
    const sentinel = 'sk-ant-PTYLEAK' + Math.random().toString(36).slice(2);
    const origAnthropic = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = sentinel;
    // RELAY_DB_PATH is ':memory:' from the file header — assert it is NOT inherited.
    try {
      const session = new ProcessSession({ sessionId: id, provider: 'fake', command: envDumper(), store });
      session.start();
      await session.waitForExit(5000);
      const dump = outputLines(store.tailEvents(id, { limit: 1000 })).map((l) => l.text).join('');
      const childEnv = JSON.parse(dump) as Record<string, string>;
      assert.equal(childEnv['ANTHROPIC_API_KEY'], undefined, 'API key MUST NOT reach the owned child');
      assert.equal(childEnv['RELAY_DB_PATH'], undefined, 'RELAY_DB_PATH MUST NOT reach the owned child');
      // No secret-shaped var name survives in the child environment.
      const secretShaped = Object.keys(childEnv).filter((k) =>
        /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH)\b/i.test(k),
      );
      assert.deepEqual(secretShaped, [], `secret-shaped vars leaked: ${secretShaped.join(', ')}`);
      assert.ok(childEnv['PATH'] !== undefined, 'PATH passes through (sanity — child is functional)');
    } finally {
      if (origAnthropic === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = origAnthropic;
    }
  });

  test('a secret printed by the child is redacted in the persisted output event', async () => {
    const store = new ControlSessionStore();
    const id = uid('redact-out');
    const secret = 'AKIAABCDEFGHIJKLMNOP'; // AKIA + 16 → aws_key redaction pattern
    const command = [
      execPath,
      '-e',
      `process.stdout.write(${JSON.stringify('aws ' + secret + ' end\n')});process.exit(0);`,
    ];
    const session = new ProcessSession({ sessionId: id, provider: 'fake', command, store });
    session.start();
    await session.waitForExit(5000);
    const persisted = outputLines(store.tailEvents(id, { limit: 1000 })).map((l) => l.text).join('\n');
    assert.equal(persisted.includes(secret), false, 'child output secret MUST be redacted before persistence');
    assert.match(persisted, /REDACTED/, 'a redaction marker replaces the secret');
  });

  test('command text carrying a secret is redacted in session metadata', async () => {
    const store = new ControlSessionStore();
    const id = uid('redact-cmd');
    const secret = 'AKIAABCDEFGHIJKLMNOP';
    const command = [execPath, '-e', 'process.exit(0);', '--aws-key', secret];
    const session = new ProcessSession({ sessionId: id, provider: 'fake', command, store });
    session.start();
    await session.waitForExit(5000);
    const meta = JSON.stringify(store.getSession(id)?.metadata ?? {});
    assert.equal(meta.includes(secret), false, 'command metadata MUST be redacted before persistence');
  });

  test('a failed spawn redacts a secret in the binary path before persistence', async () => {
    const store = new ControlSessionStore();
    const id = uid('redact-spawnerr');
    const secret = 'AKIAABCDEFGHIJKLMNOP'; // AKIA + 16 → aws_key redaction pattern
    // Nonexistent binary whose path carries a secret → ENOENT spawn error.
    const command = [`/nonexistent/${secret}/relay`, 'session', 'list'];
    const session = new ProcessSession({ sessionId: id, provider: 'fake', command, store });
    session.start();
    await session.waitForExit(5000);
    const meta = JSON.stringify(store.getSession(id)?.metadata ?? {});
    const ended = JSON.stringify(
      store.tailEvents(id, { limit: 1000 }).filter((e) => e.event_type === 'session_ended'),
    );
    assert.equal(meta.includes(secret), false, 'spawn_error in metadata MUST be redacted');
    assert.equal(ended.includes(secret), false, 'spawn_error in session_ended event MUST be redacted');
  });
});
