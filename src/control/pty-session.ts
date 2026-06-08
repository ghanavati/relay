/**
 * Relay-owned process sessions (Phase 8 / Plan 05 / Task 1).
 *
 * D-02 / CONTROL-03 — strong live control exists for processes Relay LAUNCHES
 * and OWNS. This module wraps a child process Relay spawns through node
 * `child_process` pipes (NOT a PTY): Relay can observe its output, tail it as
 * control events, write to its stdin (live_stdin), and interrupt it (SIGINT).
 *
 * v1 scope decision (2026-06-07): `live_stdin` covers line-based subprocess
 * I/O through pipes only. A full-TTY interactive CLI (claude, codex) detects
 * non-TTY stdio and changes its behavior, so those providers report
 * `live_stdin` as ABSENT until node-pty is explicitly approved as a
 * dependency (D-01: no overclaims). The pipe wrapper still observes, tails,
 * and interrupts a full-TTY process — only the live stdin channel is withheld.
 *
 * Output is recorded as `session_updated` control events: the closed event
 * taxonomy (types.ts) has no dedicated output type, so a session update with a
 * typed payload (`kind: 'process_output' | 'process_input'`) is the honest
 * fit. Exit records stopped-state: the session moves to `ended` with exit
 * metadata plus a `session_ended` audit event.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

import { getDb } from '../runtime/store/db.js';
import { makeError, toRelayException, type RelayException } from '../errors.js';
import type { CliIO } from '../cli/commands.js';
import { ControlBroker } from './broker.js';
import { ControlSessionStore } from './session-store.js';
import type {
  ControlCapability,
  ControlProvider,
  ControlSession,
  JsonValue,
} from './types.js';

// ─── Capability policy (D-01/D-02) ──────────────────────────────────────────

/**
 * Providers whose CLI is full-TTY interactive: they detect non-TTY stdio and
 * change behavior, so a pipe-owned process does NOT get a meaningful live
 * stdin channel. Reported truthfully without `live_stdin` (D-01).
 */
export const FULL_TTY_PROVIDERS: ReadonlySet<ControlProvider> = new Set<ControlProvider>([
  'claude-code',
  'codex',
]);

/**
 * Truthful capability set for a Relay-owned process. Every owned process can
 * be observed, tailed, mailboxed, and interrupted; only pipe-friendly
 * (non-full-TTY) processes additionally declare `live_stdin`.
 */
export function relayProcessCapabilities(provider: ControlProvider): readonly ControlCapability[] {
  const base: ControlCapability[] = ['register', 'observe', 'tail', 'mailbox', 'interrupt'];
  if (!FULL_TTY_PROVIDERS.has(provider)) {
    base.push('live_stdin');
  }
  return Object.freeze(base);
}

// ─── ProcessSession ─────────────────────────────────────────────────────────

export interface ProcessSessionInit {
  readonly sessionId: string;
  readonly provider: ControlProvider;
  /** [binary, ...args] — argv form, never a shell string (no shell injection). */
  readonly command: readonly string[];
  readonly workdir?: string | undefined;
  readonly label?: string | undefined;
  readonly store?: ControlSessionStore | undefined;
  readonly clock?: (() => number) | undefined;
}

/** One captured stdout/stderr line. */
export interface ProcessLine {
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
  readonly seq: number;
}

/** Terminal disposition of an owned process. */
export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** Keep the in-memory line buffer bounded — the durable record is control_events. */
const MAX_BUFFERED_LINES = 4096;

function controlError(code: Parameters<typeof makeError>[0], message: string): RelayException {
  return toRelayException(makeError(code, message, false));
}

/**
 * A child process Relay spawned and owns. Output lines are recorded as
 * `session_updated` control events and mirrored to subscribers. Exit records
 * stopped-state (state `ended` + `session_ended` audit event + exit metadata).
 */
export class ProcessSession {
  private readonly init: ProcessSessionInit;
  private readonly store: ControlSessionStore;
  private readonly clock: () => number;
  private readonly caps: readonly ControlCapability[];
  private readonly emitter = new EventEmitter();
  private readonly lineBuffer: ProcessLine[] = [];
  private readonly partial: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };

  private child: ChildProcessWithoutNullStreams | undefined;
  private seq = 0;
  private finalized = false;
  private exitInfo: ProcessExit | undefined;

  constructor(init: ProcessSessionInit) {
    this.init = init;
    this.store = init.store ?? new ControlSessionStore();
    this.clock = init.clock ?? Date.now;
    this.caps = relayProcessCapabilities(init.provider);
    // Output lines can outpace consumers — raise the listener ceiling.
    this.emitter.setMaxListeners(0);
  }

  get sessionId(): string {
    return this.init.sessionId;
  }

  get provider(): ControlProvider {
    return this.init.provider;
  }

  get capabilities(): readonly ControlCapability[] {
    return this.caps;
  }

  get exited(): boolean {
    return this.exitInfo !== undefined;
  }

  /** Register the control session and spawn the child with piped stdio. */
  start(): ControlSession {
    if (this.child !== undefined) {
      throw controlError('INVALID_ARGS', `session ${this.sessionId} is already started`);
    }
    const [bin, ...args] = this.init.command;
    if (bin === undefined) {
      throw controlError('INVALID_ARGS', 'spawn requires a non-empty command');
    }
    const now = this.clock();

    const child = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(this.init.workdir !== undefined ? { cwd: this.init.workdir } : {}),
    }) as ChildProcessWithoutNullStreams;
    this.child = child;

    const session = this.registerSession(child.pid ?? null, now);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onData('stdout', chunk));
    child.stderr.on('data', (chunk: string) => this.onData('stderr', chunk));
    child.on('error', (err) => this.finalize(null, null, err.message));
    child.on('close', (code, signal) => this.finalize(code, signal, undefined));

    return session;
  }

  /** Write a line to the child's stdin (live_stdin). Throws when unsupported or exited. */
  sendLine(text: string): void {
    if (!this.caps.includes('live_stdin')) {
      throw controlError(
        'CONTROL_DELIVERY_UNSUPPORTED',
        `session ${this.sessionId} (${this.provider}) does not support live_stdin — ` +
          'full-TTY processes detect non-TTY stdio and are out of live_stdin scope (D-01)',
      );
    }
    const child = this.child;
    if (child === undefined || this.exited || child.stdin.destroyed) {
      throw controlError('INVALID_ARGS', `session ${this.sessionId} has no live stdin to write to`);
    }
    child.stdin.write(text.endsWith('\n') ? text : `${text}\n`);
    this.recordEvent('process_input', { text });
  }

  /** Send SIGINT to the child (interrupt). No-op once exited. */
  interrupt(): void {
    if (this.exited || this.child === undefined) return;
    this.child.kill('SIGINT');
  }

  /** Send SIGTERM to the child (stop). No-op once exited. */
  stop(): void {
    if (this.exited || this.child === undefined) return;
    this.child.kill('SIGTERM');
  }

  /** Subscribe to captured output lines. Returns an unsubscribe function. */
  onLine(listener: (line: ProcessLine) => void): () => void {
    this.emitter.on('line', listener);
    return () => this.emitter.off('line', listener);
  }

  /** Resolve when the child exits. A positive timeout rejects; omit it to wait indefinitely. */
  waitForExit(timeoutMs?: number): Promise<ProcessExit> {
    if (this.exitInfo !== undefined) return Promise.resolve(this.exitInfo);
    return new Promise<ProcessExit>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const onExit = (exit: ProcessExit): void => {
        if (timer) clearTimeout(timer);
        resolve(exit);
      };
      this.emitter.once('exit', onExit);
      if (typeof timeoutMs === 'number' && timeoutMs > 0) {
        timer = setTimeout(() => {
          this.emitter.off('exit', onExit);
          reject(controlError('TIMEOUT', `session ${this.sessionId} did not exit within ${timeoutMs}ms`));
        }, timeoutMs);
      }
    });
  }

  /** Resolve when a recorded line matches the predicate; a positive timeout rejects. */
  waitForLine(predicate: (line: ProcessLine) => boolean, timeoutMs?: number): Promise<ProcessLine> {
    const existing = this.lineBuffer.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<ProcessLine>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const onLine = (line: ProcessLine): void => {
        if (!predicate(line)) return;
        this.emitter.off('line', onLine);
        if (timer) clearTimeout(timer);
        resolve(line);
      };
      this.emitter.on('line', onLine);
      if (typeof timeoutMs === 'number' && timeoutMs > 0) {
        timer = setTimeout(() => {
          this.emitter.off('line', onLine);
          reject(controlError('TIMEOUT', `no matching line within ${timeoutMs}ms for ${this.sessionId}`));
        }, timeoutMs);
      }
    });
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private registerSession(pid: number | null, now: number): ControlSession {
    const txn = getDb().transaction((): ControlSession => {
      const session = this.store.upsertSession(
        {
          session_id: this.sessionId,
          provider: this.provider,
          capabilities: this.caps,
          state: 'active',
          label: this.init.label ?? null,
          workdir: this.init.workdir ?? null,
          ...(pid !== null ? { pid } : {}),
          metadata: { owned_by: 'relay', command: this.init.command.join(' ') },
        },
        now,
      );
      this.store.appendEvent(
        {
          session_id: this.sessionId,
          event_type: 'session_registered',
          payload: { provider: this.provider, owned_by: 'relay' },
        },
        now,
      );
      return session;
    });
    return txn();
  }

  private onData(stream: 'stdout' | 'stderr', chunk: string): void {
    const buffered = this.partial[stream] + chunk;
    const parts = buffered.split('\n');
    this.partial[stream] = parts.pop() ?? '';
    for (const text of parts) {
      this.emitLine(stream, text);
    }
  }

  private emitLine(stream: 'stdout' | 'stderr', text: string): void {
    const seq = ++this.seq;
    const line: ProcessLine = Object.freeze({ stream, text, seq });
    this.lineBuffer.push(line);
    if (this.lineBuffer.length > MAX_BUFFERED_LINES) this.lineBuffer.shift();
    this.recordEvent('process_output', { stream, text, seq });
    this.emitter.emit('line', line);
  }

  private recordEvent(kind: 'process_output' | 'process_input', extra: Record<string, JsonValue>): void {
    try {
      this.store.appendEvent(
        {
          session_id: this.sessionId,
          event_type: 'session_updated',
          payload: { kind, ...extra },
        },
        this.clock(),
      );
    } catch {
      // Best-effort observability — a recording failure must not kill the process.
    }
  }

  private finalize(
    code: number | null,
    signal: NodeJS.Signals | null,
    errorDetail: string | undefined,
  ): void {
    if (this.finalized) return;
    this.finalized = true;
    // Flush any trailing partial line (output without a final newline).
    for (const stream of ['stdout', 'stderr'] as const) {
      const remainder = this.partial[stream];
      if (remainder.length > 0) {
        this.partial[stream] = '';
        this.emitLine(stream, remainder);
      }
    }
    const exit: ProcessExit = Object.freeze({ code, signal });
    this.exitInfo = exit;
    const now = this.clock();
    this.recordStoppedState(code, signal, errorDetail, now);
    this.emitter.emit('exit', exit);
  }

  private recordStoppedState(
    code: number | null,
    signal: NodeJS.Signals | null,
    errorDetail: string | undefined,
    now: number,
  ): void {
    try {
      const existing = this.store.getSession(this.sessionId);
      const txn = getDb().transaction(() => {
        this.store.upsertSession(
          {
            session_id: this.sessionId,
            provider: this.provider,
            capabilities: existing?.capabilities ?? this.caps,
            state: 'ended',
            label: existing?.label ?? this.init.label ?? null,
            workdir: existing?.workdir ?? this.init.workdir ?? null,
            ...(existing?.pid != null ? { pid: existing.pid } : {}),
            metadata: {
              ...(existing?.metadata ?? {}),
              owned_by: 'relay',
              exit_code: code,
              exit_signal: signal,
              stopped_at: now,
              ...(errorDetail !== undefined ? { spawn_error: errorDetail } : {}),
            },
          },
          now,
        );
        this.store.appendEvent(
          {
            session_id: this.sessionId,
            event_type: 'session_ended',
            payload: {
              exit_code: code,
              signal,
              ...(errorDetail !== undefined ? { spawn_error: errorDetail } : {}),
            },
          },
          now,
        );
      });
      txn();
    } catch {
      // Stopped-state is best-effort cleanup; never throw from a process event.
    }
  }
}

// ─── Mailbox → live stdin bridge (D-13) ─────────────────────────────────────

/**
 * Deliver a Relay-owned session's queued mailbox messages into the live
 * process stdin (live_stdin delivery). Each delivery is audited exactly like
 * adapter delivery: a delivery attempt plus the broker's `message_delivered`
 * event. This is how a `relay session send <id>` issued from another terminal
 * reaches a running owned process. Returns the count delivered.
 *
 * A session without `live_stdin` (full-TTY) cannot receive this way — returns 0
 * rather than silently degrading (D-01); such messages wait for another channel.
 */
export function drainMailboxToProcess(
  session: ProcessSession,
  store: ControlSessionStore,
  broker: ControlBroker,
  now: number = Date.now(),
): number {
  if (!session.capabilities.includes('live_stdin')) return 0;
  let delivered = 0;
  for (const message of store.getQueuedMessages(session.sessionId, now)) {
    try {
      session.sendLine(message.content);
      store.recordDeliveryAttempt(
        {
          message_id: message.message_id,
          capability: 'live_stdin',
          status: 'success',
          detail: 'written to owned process stdin',
        },
        now,
      );
      broker.markDelivered(message.message_id, { capability: 'live_stdin', now });
      delivered += 1;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      store.recordDeliveryAttempt(
        { message_id: message.message_id, capability: 'live_stdin', status: 'failure', detail },
        now,
      );
      broker.markFailed(message.message_id, detail, { capability: 'live_stdin', now });
    }
  }
  return delivered;
}

// ─── CLI spawn driver ────────────────────────────────────────────────────────

export interface SpawnSessionOptions {
  readonly provider: ControlProvider;
  readonly command: readonly string[];
  readonly sessionId?: string | undefined;
  readonly workdir?: string | undefined;
  readonly label?: string | undefined;
  /** Forward the operator terminal's stdin into the child. Default: stdin.isTTY. */
  readonly attachStdin?: boolean | undefined;
  /** Mirror child output to the CliIO (human mode). Default true. */
  readonly mirrorOutput?: boolean | undefined;
  /** Mailbox poll interval (ms) for live_stdin delivery. 0 disables. Default 250. */
  readonly mailboxPollMs?: number | undefined;
  readonly store?: ControlSessionStore | undefined;
  readonly broker?: ControlBroker | undefined;
  readonly clock?: (() => number) | undefined;
}

export interface SpawnResult {
  readonly sessionId: string;
  readonly provider: ControlProvider;
  readonly capabilities: readonly ControlCapability[];
  readonly exitCode: number | null;
  readonly signal: string | null;
}

/**
 * Foreground driver for `relay session spawn`: register + spawn the owned
 * process, mirror its output to the terminal while recording it as control
 * events, forward operator stdin (when a TTY and the session supports
 * live_stdin), poll the mailbox so peer sends land on the child's stdin, and
 * forward SIGINT as an interrupt. Resolves with the child's disposition.
 */
export async function runSpawnSession(options: SpawnSessionOptions, io: CliIO): Promise<SpawnResult> {
  const store = options.store ?? new ControlSessionStore();
  const broker = options.broker ?? new ControlBroker(store);
  const sessionId = options.sessionId ?? randomUUID();

  const session = new ProcessSession({
    sessionId,
    provider: options.provider,
    command: options.command,
    ...(options.workdir !== undefined ? { workdir: options.workdir } : {}),
    ...(options.label !== undefined ? { label: options.label } : {}),
    store,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  });
  session.start();

  const mirror = options.mirrorOutput ?? true;
  const unsubscribe = mirror
    ? session.onLine((line) => {
        const write = line.stream === 'stderr' ? io.stderr : io.stdout;
        write(`${line.text}\n`);
      })
    : undefined;

  const liveStdin = session.capabilities.includes('live_stdin');

  const pollMs = options.mailboxPollMs ?? 250;
  let pollTimer: NodeJS.Timeout | undefined;
  if (liveStdin && pollMs > 0) {
    pollTimer = setInterval(() => {
      try {
        drainMailboxToProcess(session, store, broker);
      } catch {
        // Poll errors are non-fatal; the next tick retries.
      }
    }, pollMs);
    pollTimer.unref?.();
  }

  const attachStdin = options.attachStdin ?? Boolean(process.stdin.isTTY);
  let rl: ReadlineInterface | undefined;
  if (attachStdin && liveStdin) {
    rl = createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      try {
        session.sendLine(line);
      } catch {
        // The child may have exited between the keystroke and the write.
      }
    });
  }

  const onSigint = (): void => session.interrupt();
  process.once('SIGINT', onSigint);

  try {
    const exit = await session.waitForExit();
    return Object.freeze({
      sessionId,
      provider: session.provider,
      capabilities: session.capabilities,
      exitCode: exit.code,
      signal: exit.signal,
    });
  } finally {
    if (pollTimer) clearInterval(pollTimer);
    if (rl) rl.close();
    if (unsubscribe) unsubscribe();
    process.removeListener('SIGINT', onSigint);
  }
}
