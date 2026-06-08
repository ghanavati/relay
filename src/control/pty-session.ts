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
 * RED stub: the executable bodies throw until the GREEN implementation lands.
 * The exported types are final so cmd-session.ts and the test compile against
 * the same shapes in both phases. The shared build stays green for the
 * parallel agent — only the tests are red.
 */

import type { CliIO } from '../cli/commands.js';
import type { ControlBroker } from './broker.js';
import type { ControlSessionStore } from './session-store.js';
import type {
  ControlCapability,
  ControlProvider,
  ControlSession,
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

function notImplemented(): never {
  throw new Error('pty-session: not implemented (RED)');
}

/**
 * A child process Relay spawned and owns. Output lines are recorded as
 * `session_updated` control events (the closed event taxonomy has no dedicated
 * output type; a session update with a typed payload is the honest fit) and
 * mirrored to subscribers. Exit records stopped-state: the session transitions
 * to `ended` with exit metadata plus a `session_ended` audit event.
 */
export class ProcessSession {
  private readonly init: ProcessSessionInit;

  constructor(init: ProcessSessionInit) {
    this.init = init;
  }

  get sessionId(): string {
    return this.init.sessionId;
  }

  get provider(): ControlProvider {
    return this.init.provider;
  }

  get capabilities(): readonly ControlCapability[] {
    return relayProcessCapabilities(this.init.provider);
  }

  get exited(): boolean {
    return notImplemented();
  }

  /** Register the control session and spawn the child with piped stdio. */
  start(): ControlSession {
    return notImplemented();
  }

  /** Write a line to the child's stdin (live_stdin). Throws when unsupported or exited. */
  sendLine(_text: string): void {
    return notImplemented();
  }

  /** Send SIGINT to the child (interrupt). No-op once exited. */
  interrupt(): void {
    return notImplemented();
  }

  /** Send SIGTERM to the child (stop). No-op once exited. */
  stop(): void {
    return notImplemented();
  }

  /** Subscribe to captured output lines. Returns an unsubscribe function. */
  onLine(_listener: (line: ProcessLine) => void): () => void {
    return notImplemented();
  }

  /** Resolve when the child exits; rejects on timeout (default 10s). */
  waitForExit(_timeoutMs?: number): Promise<ProcessExit> {
    return notImplemented();
  }

  /** Resolve when a recorded line matches the predicate; rejects on timeout. */
  waitForLine(
    _predicate: (line: ProcessLine) => boolean,
    _timeoutMs?: number,
  ): Promise<ProcessLine> {
    return notImplemented();
  }
}

// ─── Mailbox → live stdin bridge (D-13) ─────────────────────────────────────

/**
 * Deliver a Relay-owned session's queued mailbox messages into the live
 * process stdin (live_stdin delivery). Each delivered message is audited
 * exactly like adapter delivery: a delivery attempt plus the broker's
 * `message_delivered` event. This is how a `relay session send <id>` issued
 * from another terminal reaches a running owned process. Returns the count
 * delivered.
 */
export function drainMailboxToProcess(
  _session: ProcessSession,
  _store: ControlSessionStore,
  _broker: ControlBroker,
  _now?: number,
): number {
  return notImplemented();
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
 * events, forward operator stdin (when a TTY), poll the mailbox so peer sends
 * land on the child's stdin, and forward SIGINT as an interrupt. Resolves with
 * the child's terminal disposition once it exits.
 */
export async function runSpawnSession(_options: SpawnSessionOptions, _io: CliIO): Promise<SpawnResult> {
  return notImplemented();
}
