/**
 * Transcript-backed HTTP control adapter (Phase 8 / Plan 04 / Task 3).
 *
 * D-10 / CONTROL-09 — OpenRouter and Anthropic direct API sessions are stored
 * Relay transcripts with EXPLICIT non-live semantics:
 *
 *   - The provider API is stateless; the session state (model + transcript)
 *     lives in the control session's metadata.
 *   - `resume_send` means: append the incoming message as a user turn, make a
 *     NEW provider request carrying the FULL transcript, append the assistant
 *     reply, persist. It is Relay-transcript continuation, never
 *     provider-native live state.
 *   - `live_stdin` / `interrupt` are never reported — there is no live
 *     process to write to.
 *   - No hardcoded model fallbacks: a session without a configured model
 *     refuses delivery instead of guessing (CONTEXT.md non-goal).
 *
 * Provider errors surface as FAILED delivery outcomes — the registry records
 * the delivery attempt and the broker appends a `message_failed` audit event,
 * so a 500 from the provider is visible in the session's event tail.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { makeError, toRelayException, type RelayException } from '../../errors.js';
import type { WorkerResult } from '../../workers/types.js';
import type { ChatTurn } from '../../workers/generic-http-runner.js';
import { ControlSessionStore } from '../session-store.js';
import type {
  ControlAdapter,
  ControlCapability,
  ControlMessage,
  ControlProvider,
  ControlSession,
  DeliveryOutcome,
} from '../types.js';

/** Providers whose sessions are Relay-stored transcripts (D-10). */
export const TRANSCRIPT_PROVIDERS = ['openrouter', 'anthropic'] as const;
export type TranscriptProvider = (typeof TRANSCRIPT_PROVIDERS)[number];

/** Truthful transcript-session capability set: non-live by construction. */
export const TRANSCRIPT_SESSION_CAPABILITIES = [
  'register',
  'observe',
  'tail',
  'resume_send',
] as const satisfies readonly ControlCapability[];

/** One persisted transcript turn. Assistant output may legitimately be empty. */
export const TranscriptTurnSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string().max(200_000),
  })
  .strict();
export type TranscriptTurn = z.infer<typeof TranscriptTurnSchema>;

const TranscriptSchema = z.array(TranscriptTurnSchema);

/** Boundary input for creating a transcript-backed session. Model is REQUIRED. */
export const TranscriptSessionInputSchema = z
  .object({
    session_id: z.string().min(1).max(200).optional(),
    model: z.string().min(1).max(200),
    label: z.string().min(1).max(200).optional(),
    workdir: z.string().min(1).max(1000).optional(),
    system: z.string().min(1).max(100_000).optional(),
  })
  .strict()
  .readonly();
export type TranscriptSessionInput = z.infer<typeof TranscriptSessionInputSchema>;

/** One provider continuation request issued by the adapter. */
export interface TranscriptCompleterRequest {
  readonly provider: TranscriptProvider;
  readonly model: string;
  readonly messages: readonly ChatTurn[];
  readonly timeout_ms: number;
}

/** Pluggable provider call. The default routes to the worker runners. */
export type TranscriptCompleter = (req: TranscriptCompleterRequest) => Promise<WorkerResult>;

export const DEFAULT_TRANSCRIPT_TIMEOUT_MS = 120_000;

function invalidArgs(message: string): RelayException {
  return toRelayException(makeError('INVALID_ARGS', message, false));
}

function notFound(what: string): RelayException {
  return toRelayException(makeError('RUN_NOT_FOUND', `${what} not found`, false));
}

function notImplemented(): never {
  throw new Error('not implemented (08-04 RED)');
}

/** Default completer: route through the existing worker runners. */
export const defaultTranscriptCompleter: TranscriptCompleter = async (req) => {
  void req;
  notImplemented();
};

export class TranscriptHttpControlAdapter implements ControlAdapter {
  readonly provider: ControlProvider;

  private readonly store: ControlSessionStore;
  private readonly completer: TranscriptCompleter;
  private readonly timeout_ms: number;

  constructor(
    provider: TranscriptProvider,
    store: ControlSessionStore = new ControlSessionStore(),
    completer: TranscriptCompleter = defaultTranscriptCompleter,
    timeout_ms: number = DEFAULT_TRANSCRIPT_TIMEOUT_MS,
  ) {
    this.provider = provider;
    this.store = store;
    this.completer = completer;
    this.timeout_ms = timeout_ms;
    void invalidArgs;
    void notFound;
    void TranscriptSchema;
  }

  describeCapabilities(): readonly ControlCapability[] {
    notImplemented();
  }

  supports(capability: ControlCapability): boolean {
    void capability;
    notImplemented();
  }

  /**
   * Create a transcript-backed session (state `idle` per D-10 — registered
   * and resumable, not live). Refuses to overwrite an existing session: that
   * would silently wipe its transcript.
   */
  createSession(input: unknown, now: number = Date.now()): ControlSession {
    void input;
    void now;
    void this.store;
    notImplemented();
  }

  /** Validated transcript for a session, oldest turn first. */
  getTranscript(session_id: string): readonly TranscriptTurn[] {
    void session_id;
    notImplemented();
  }

  /**
   * resume_send delivery: append the message as a user turn, issue a NEW
   * provider request with the full transcript, persist user+assistant turns
   * on success. Provider failures leave the transcript untouched and surface
   * as failed delivery outcomes.
   */
  async deliver(message: ControlMessage, session: ControlSession): Promise<DeliveryOutcome> {
    void message;
    void session;
    void this.completer;
    void this.timeout_ms;
    notImplemented();
  }
}
