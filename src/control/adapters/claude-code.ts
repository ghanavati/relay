/**
 * Claude Code control adapter (Phase 8 / Plan 04 / Task 1).
 *
 * D-07 / CONTROL-06 — ambient Claude Code sessions are registered and updated
 * through CC hook payloads (SessionStart / UserPromptSubmit / SessionEnd carry
 * `session_id`, `transcript_path`, `cwd`) and receive queued Relay messages as
 * `additionalContext` at hook boundaries. Hooks are NOT a live stdin channel:
 * the ambient capability set is exactly
 * `register / observe / context_inject / mailbox` — never `live_stdin`, never
 * `resume_send`. Stronger semantics belong to a future Relay-managed (SDK)
 * adapter instance, not this one (D-02).
 *
 * Delivery contract: construct this adapter and drain its queue ONLY at a hook
 * boundary (see cmd-context-emit.ts). `deliver` buffers the message for the
 * additionalContext render that happens in the same process immediately after
 * the drain; outside a hook boundary there is nothing to render into, so do
 * not call `deliverQueued` against ambient claude-code sessions elsewhere.
 */
import { z } from 'zod';

import { makeError, toRelayException, type RelayException } from '../../errors.js';
import { ControlSessionStore } from '../session-store.js';
import type {
  ControlAdapter,
  ControlCapability,
  ControlMessage,
  ControlProvider,
  ControlSession,
  DeliveryOutcome,
} from '../types.js';

/** Truthful ambient capability set (D-07). No live_stdin, no resume_send. */
export const CLAUDE_CODE_AMBIENT_CAPABILITIES = [
  'register',
  'observe',
  'context_inject',
  'mailbox',
] as const satisfies readonly ControlCapability[];

/** Hook events Relay handles. Other CC hook events are not session boundaries we consume. */
export const CLAUDE_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'SessionEnd'] as const;

export const ClaudeHookEventSchema = z.enum(CLAUDE_HOOK_EVENTS);
export type ClaudeHookEvent = z.infer<typeof ClaudeHookEventSchema>;

/**
 * CC hook payload boundary schema. CC sends additional fields (`source`,
 * `prompt`, `model`, ...) — passthrough keeps them without trusting them.
 */
export const ClaudeHookPayloadSchema = z
  .object({
    session_id: z.string().min(1).max(200),
    hook_event_name: ClaudeHookEventSchema,
    transcript_path: z.string().min(1).max(1000).optional(),
    cwd: z.string().min(1).max(1000).optional(),
  })
  .passthrough()
  .readonly();
export type ClaudeHookPayload = z.infer<typeof ClaudeHookPayloadSchema>;

function invalidArgs(message: string): RelayException {
  return toRelayException(makeError('INVALID_ARGS', message, false));
}

function notImplemented(): never {
  throw new Error('not implemented (08-04 RED)');
}

/**
 * Parse a raw hook payload string.
 *
 * - `undefined` / empty / whitespace-only input → `undefined` (absence — the
 *   ENOENT analog: no payload was piped, degrade gracefully).
 * - present but not valid JSON, or JSON violating the schema → RelayError
 *   INVALID_ARGS (a parse error is NOT absence; callers decide how loudly to
 *   degrade).
 */
export function parseClaudeHookPayload(
  raw: string | null | undefined,
): ClaudeHookPayload | undefined {
  void raw;
  void invalidArgs;
  notImplemented();
}

/** Render queued mailbox messages as a markdown additionalContext block. */
export function renderMailboxContext(messages: readonly ControlMessage[]): string {
  void messages;
  notImplemented();
}

export class ClaudeCodeControlAdapter implements ControlAdapter {
  readonly provider: ControlProvider = 'claude-code';

  private readonly store: ControlSessionStore;
  private readonly pending = new Map<string, ControlMessage[]>();

  constructor(store: ControlSessionStore = new ControlSessionStore()) {
    this.store = store;
    void this.pending;
  }

  describeCapabilities(): readonly ControlCapability[] {
    notImplemented();
  }

  supports(capability: ControlCapability): boolean {
    void capability;
    notImplemented();
  }

  /**
   * Register / refresh / stop-mark a session from a validated hook payload.
   * SessionStart and UserPromptSubmit upsert an `active` session;
   * SessionEnd marks it `ended`. Every application appends an audit event
   * (session_registered / session_updated / session_ended).
   */
  applyHookPayload(payload: ClaudeHookPayload, now: number = Date.now()): ControlSession {
    void payload;
    void now;
    void this.store;
    notImplemented();
  }

  async deliver(message: ControlMessage, session: ControlSession): Promise<DeliveryOutcome> {
    void message;
    void session;
    notImplemented();
  }

  /**
   * Take (and clear) the rendered additionalContext block for messages
   * delivered to this session during the current hook-boundary drain.
   * Returns undefined when nothing was delivered.
   */
  takePendingContext(session_id: string): string | undefined {
    void session_id;
    notImplemented();
  }
}
