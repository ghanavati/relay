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
import { OpenRouterRunner } from '../../workers/openrouter.js';
import { AnthropicRunner } from '../../workers/anthropic.js';
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

function corrupted(what: string, detail: string): RelayException {
  return toRelayException(makeError('CONFIG_ERROR', `${what} is corrupted: ${detail}`, false));
}

/** Default completer: route through the existing worker runners. */
export const defaultTranscriptCompleter: TranscriptCompleter = async (req) => {
  const opts = { model: req.model, timeout_ms: req.timeout_ms };
  return req.provider === 'openrouter'
    ? new OpenRouterRunner().runMessages(req.messages, opts)
    : new AnthropicRunner().runMessages(req.messages, opts);
};

export class TranscriptHttpControlAdapter implements ControlAdapter {
  readonly provider: ControlProvider;

  private readonly transcriptProvider: TranscriptProvider;
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
    this.transcriptProvider = provider;
    this.store = store;
    this.completer = completer;
    this.timeout_ms = timeout_ms;
  }

  describeCapabilities(): readonly ControlCapability[] {
    return TRANSCRIPT_SESSION_CAPABILITIES;
  }

  supports(capability: ControlCapability): boolean {
    return (TRANSCRIPT_SESSION_CAPABILITIES as readonly ControlCapability[]).includes(capability);
  }

  /**
   * Create a transcript-backed session (state `idle` per D-10 — registered
   * and resumable, not live). Refuses to overwrite an existing session: that
   * would silently wipe its transcript.
   */
  createSession(input: unknown, now: number = Date.now()): ControlSession {
    const result = TranscriptSessionInputSchema.safeParse(input);
    if (!result.success) {
      const detail = result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw invalidArgs(`invalid transcript session input: ${detail}`);
    }
    const parsed = result.data;
    const session_id = parsed.session_id ?? randomUUID();

    if (this.store.getSession(session_id)) {
      throw invalidArgs(
        `transcript session ${session_id} already exists — refusing to overwrite its transcript`,
      );
    }

    const transcript: TranscriptTurn[] =
      parsed.system !== undefined ? [{ role: 'system', content: parsed.system }] : [];

    const session = this.store.upsertSession(
      {
        session_id,
        provider: this.provider,
        capabilities: TRANSCRIPT_SESSION_CAPABILITIES,
        state: 'idle',
        label: parsed.label ?? null,
        workdir: parsed.workdir ?? null,
        metadata: { model: parsed.model, transcript },
      },
      now,
    );

    this.store.appendEvent(
      {
        session_id,
        event_type: 'session_registered',
        payload: { provider: this.provider, model: parsed.model },
      },
      now,
    );
    return session;
  }

  /** Validated transcript for a session, oldest turn first. */
  getTranscript(session_id: string): readonly TranscriptTurn[] {
    const session = this.store.getSession(session_id);
    if (!session) throw notFound(`Control session ${session_id}`);
    return this.parseTranscript(session);
  }

  /**
   * resume_send delivery: append the message as a user turn, issue a NEW
   * provider request with the full transcript, persist user+assistant turns
   * on success. Provider failures leave the transcript untouched and surface
   * as failed delivery outcomes.
   */
  async deliver(message: ControlMessage, session: ControlSession): Promise<DeliveryOutcome> {
    const capability: ControlCapability = 'resume_send';

    const model = session.metadata?.['model'];
    if (typeof model !== 'string' || model.trim().length === 0) {
      return {
        ok: false,
        capability,
        detail:
          `transcript session ${session.session_id} has no model configured — ` +
          'refusing to guess (no hardcoded model fallbacks)',
      };
    }

    let transcript: TranscriptTurn[];
    try {
      transcript = this.parseTranscript(session);
    } catch (err) {
      return {
        ok: false,
        capability,
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    const messages: ChatTurn[] = [...transcript, { role: 'user', content: message.content }];

    let result: WorkerResult;
    try {
      result = await this.completer({
        provider: this.transcriptProvider,
        model,
        messages,
        timeout_ms: this.timeout_ms,
      });
    } catch (err) {
      return {
        ok: false,
        capability,
        detail: `provider request failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (result.status !== 'success') {
      return {
        ok: false,
        capability,
        detail: result.error?.message ?? `provider returned status "${result.status}"`,
      };
    }

    const updated: TranscriptTurn[] = [...messages, { role: 'assistant', content: result.output }];
    const now = Date.now();
    this.store.upsertSession(
      {
        session_id: session.session_id,
        provider: session.provider,
        capabilities: session.capabilities,
        state: 'idle',
        label: session.label,
        workdir: session.workdir,
        pid: session.pid,
        metadata: { ...(session.metadata ?? {}), transcript: updated },
      },
      now,
    );
    // Audit the append without leaking transcript content into events (D-06).
    this.store.appendEvent(
      {
        session_id: session.session_id,
        event_type: 'session_updated',
        payload: { reason: 'transcript_appended', turns: updated.length },
      },
      now,
    );

    return { ok: true, capability };
  }

  private parseTranscript(session: ControlSession): TranscriptTurn[] {
    const raw = session.metadata?.['transcript'] ?? [];
    const parsed = TranscriptSchema.safeParse(raw);
    if (!parsed.success) {
      throw corrupted(
        `transcript for session ${session.session_id}`,
        parsed.error.issues[0]?.message ?? 'schema mismatch',
      );
    }
    return parsed.data;
  }
}
