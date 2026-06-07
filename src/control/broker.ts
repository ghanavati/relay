/**
 * Policy-aware control broker (Phase 8 / Plan 02 / Task 1).
 *
 * D-03 — LLM-to-LLM control flows through Relay tools and brokered messages,
 * never direct terminal writes. Every cross-session send — human UI action or
 * LLM tool call — goes through `sendMessage` here (D-13): same policy checks,
 * same grants, same loop detection, same audit events.
 *
 * D-04 — Policy:
 *   - Human sends may target any REGISTERED session whose capability set
 *     includes at least one delivery capability. Human sources need not be
 *     registered sessions (the human is not a session).
 *   - LLM sends are DEFAULT-DENY: they additionally require a registered
 *     source session and a usable grant (not revoked, not expired, under
 *     budget). The budget decrement and the enqueue happen in ONE
 *     transaction, with the store's guarded single-UPDATE
 *     (`incrementGrantUsage`) as the atomic gate.
 *   - Self-sends are blocked for every sender kind.
 *   - LLM sends repeating the same normalized content within the detection
 *     window are blocked once the pair (counted in BOTH directions, to catch
 *     ping-pong) reaches LOOP_DETECTION_THRESHOLD.
 *
 * D-05 — Audit events: `message_enqueued` / `message_delivered` /
 * `message_failed` are anchored to the TARGET session (whose mailbox/state
 * changed); `message_blocked` is anchored to the SOURCE (the denied actor —
 * the target may not even exist). Blocked sends never persist content; their
 * events carry only the normalized content hash.
 *
 * D-06 — Redaction happens BEFORE persistence: content is redacted, then the
 * normalized hash is computed over the redacted content, then the redacted
 * content + redaction metadata are stored. Callers cannot supply their own
 * content_hash or redaction (strict schema rejects both) — the broker owns
 * audit hashing.
 *
 * Synchronous like the store — better-sqlite3 calls are never awaited.
 */
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { getDb } from '../runtime/store/db.js';
import { makeError, toRelayException, type ErrorCode, type RelayException } from '../errors.js';
import { REDACTION_PATTERNS } from '../security/redaction.js';
import { ControlSessionStore } from './session-store.js';
import {
  ControlSenderKindSchema,
  MAX_CONTROL_CONTENT_CHARS,
  type ControlCapability,
  type ControlGrant,
  type ControlMessage,
  type ControlRedaction,
  type ControlSenderKind,
} from './types.js';

// ─── Policy constants ───────────────────────────────────────────────────────

/**
 * Capabilities that can carry a message TO a session, ordered strongest to
 * weakest. The broker requires a target to declare at least one; the adapter
 * registry (Task 2) routes delivery to the preference head of the
 * session ∩ adapter overlap.
 */
export const DELIVERY_CAPABILITY_PREFERENCE = [
  'live_stdin',
  'resume_send',
  'context_inject',
  'mailbox',
] as const satisfies readonly ControlCapability[];

const DELIVERY_CAPABILITY_SET: ReadonlySet<ControlCapability> = new Set(
  DELIVERY_CAPABILITY_PREFERENCE,
);

/**
 * An LLM send is blocked when its source↔target pair already has this many
 * persisted messages with the same normalized content hash inside the
 * detection window. Counted in both directions to catch A→B→A ping-pong.
 */
export const LOOP_DETECTION_THRESHOLD = 3;

/** Sliding window for loop detection. Older identical messages do not count. */
export const LOOP_DETECTION_WINDOW_MS = 10 * 60_000;

/** First capability (by preference order) present in BOTH sets, else undefined. */
export function pickDeliveryCapability(
  sessionCapabilities: readonly ControlCapability[],
  adapterCapabilities: readonly ControlCapability[],
): ControlCapability | undefined {
  for (const capability of DELIVERY_CAPABILITY_PREFERENCE) {
    if (sessionCapabilities.includes(capability) && adapterCapabilities.includes(capability)) {
      return capability;
    }
  }
  return undefined;
}

// ─── Normalized content hashing (loop detection + audit, D-04/D-05) ─────────

/** Trim, collapse all whitespace runs to single spaces, lowercase. */
export function normalizeContent(content: string): string {
  return content.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** sha256 hex of the NORMALIZED content — whitespace/case variants collide. */
export function normalizedContentHash(content: string): string {
  return createHash('sha256').update(normalizeContent(content), 'utf8').digest('hex');
}

// ─── Redaction (D-06) ───────────────────────────────────────────────────────

/**
 * Apply the shared REDACTION_PATTERNS, tracking WHICH rules fired so the
 * redaction metadata persisted with the message names them (D-05/D-06).
 */
export function redactControlContent(content: string): {
  readonly content: string;
  readonly redaction: ControlRedaction;
} {
  let result = content;
  const rules: string[] = [];
  for (const { name, pattern, replacement } of REDACTION_PATTERNS) {
    // Fresh RegExp per use — the shared patterns carry /g state (lastIndex).
    const probe = new RegExp(pattern.source, pattern.flags);
    if (probe.test(result)) {
      rules.push(name);
      result = result.replace(new RegExp(pattern.source, pattern.flags), replacement);
    }
  }
  return {
    content: result,
    redaction: Object.freeze({
      applied: rules.length > 0,
      rules: Object.freeze([...rules]),
    }) as ControlRedaction,
  };
}

// ─── Boundary schema ────────────────────────────────────────────────────────

const idField = z.string().min(1).max(200);

/**
 * Broker send input. Deliberately NARROWER than the store's
 * ControlSendInputSchema: `content_hash` and `redaction` are not accepted —
 * the broker computes both, so callers cannot spoof audit hashes or claim
 * redaction that never happened (strict() rejects the keys).
 */
const BrokerSendInputSchema = z
  .object({
    message_id: idField.optional(),
    source_session_id: idField,
    target_session_id: idField,
    sender_kind: ControlSenderKindSchema,
    content: z.string().min(1).max(MAX_CONTROL_CONTENT_CHARS),
    expires_at: z.number().int().positive().nullable().optional(),
  })
  .strict()
  .readonly();
export type BrokerSendInput = z.infer<typeof BrokerSendInputSchema>;

// ─── Results and internals ──────────────────────────────────────────────────

/** Result of a grant policy check (D-04). */
export type GrantCheck =
  | { readonly allowed: true; readonly grant: ControlGrant }
  | { readonly allowed: false; readonly reason: 'no_grant' | 'expired' | 'exhausted' };

/** Reason strings recorded in message_blocked event payloads. */
type BlockReason =
  | 'self_send'
  | 'session_not_found'
  | 'delivery_unsupported'
  | 'grant_required'
  | 'grant_expired'
  | 'budget_exhausted'
  | 'loop_detected';

/** Internal sentinel: the atomic budget gate refused inside the send txn. */
class BudgetGateRefusedError extends Error {
  constructor() {
    super('grant became unusable during send');
  }
}

function invalidArgs(message: string): RelayException {
  return toRelayException(makeError('INVALID_ARGS', message, false));
}

/** Zod boundary gate — malformed input becomes RelayError INVALID_ARGS. */
function boundary<S extends z.ZodTypeAny>(schema: S, input: unknown, what: string): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw invalidArgs(`invalid ${what}: ${detail}`);
  }
  return result.data as z.output<S>;
}

// ─── Broker ─────────────────────────────────────────────────────────────────

export class ControlBroker {
  private readonly db: Database.Database;
  private readonly store: ControlSessionStore;

  constructor(store: ControlSessionStore = new ControlSessionStore()) {
    this.db = getDb();
    this.store = store;
  }

  /**
   * Policy-gated cross-session send. Returns the queued ControlMessage or
   * throws RelayError; every deny is audited as a `message_blocked` event
   * BEFORE the throw (outside the send transaction, so it survives).
   */
  sendMessage(input: unknown, now: number = Date.now()): ControlMessage {
    const parsed = boundary(BrokerSendInputSchema, input, 'control send');
    if (parsed.expires_at != null && parsed.expires_at <= now) {
      throw invalidArgs(`expires_at (${parsed.expires_at}) must be in the future`);
    }

    const { content: redactedContent, redaction } = redactControlContent(parsed.content);
    const content_hash = normalizedContentHash(redactedContent);
    const ctx = {
      source_session_id: parsed.source_session_id,
      target_session_id: parsed.target_session_id,
      sender_kind: parsed.sender_kind,
      content_hash,
      now,
    };

    if (parsed.source_session_id === parsed.target_session_id) {
      this.blockSend(ctx, 'self_send', 'CONTROL_SELF_SEND_BLOCKED', 'self-sends are blocked');
    }

    const target = this.store.getSession(parsed.target_session_id);
    if (!target) {
      this.blockSend(
        ctx,
        'session_not_found',
        'CONTROL_SESSION_NOT_FOUND',
        `target session ${parsed.target_session_id} is not registered`,
      );
    }
    if (!target.capabilities.some((capability) => DELIVERY_CAPABILITY_SET.has(capability))) {
      this.blockSend(
        ctx,
        'delivery_unsupported',
        'CONTROL_DELIVERY_UNSUPPORTED',
        `target session ${parsed.target_session_id} declares no delivery capability ` +
          `(needs one of: ${DELIVERY_CAPABILITY_PREFERENCE.join(', ')})`,
      );
    }

    let grantId: string | undefined;
    if (parsed.sender_kind === 'llm') {
      const source = this.store.getSession(parsed.source_session_id);
      if (!source) {
        this.blockSend(
          ctx,
          'session_not_found',
          'CONTROL_SESSION_NOT_FOUND',
          `source session ${parsed.source_session_id} is not registered`,
        );
      }

      const check = this.checkGrant(parsed.source_session_id, parsed.target_session_id, now);
      if (!check.allowed) {
        const denial = ControlBroker.GRANT_DENIALS[check.reason];
        this.blockSend(
          ctx,
          denial.reason,
          denial.code,
          `llm send ${parsed.source_session_id} -> ${parsed.target_session_id} denied: ${denial.detail}`,
        );
      }
      grantId = check.grant.grant_id;

      const repeats = this.countRecentPairMessages(
        parsed.source_session_id,
        parsed.target_session_id,
        content_hash,
        now - LOOP_DETECTION_WINDOW_MS,
      );
      if (repeats >= LOOP_DETECTION_THRESHOLD) {
        this.blockSend(
          ctx,
          'loop_detected',
          'CONTROL_LOOP_DETECTED',
          `llm send ${parsed.source_session_id} -> ${parsed.target_session_id} blocked: ` +
            `${repeats} identical messages in the last ${LOOP_DETECTION_WINDOW_MS}ms (loop suspected)`,
        );
      }
    }

    // Allow path — budget decrement, enqueue, and audit event in ONE
    // transaction. The store calls inside become savepoints; any failure
    // (e.g. duplicate message_id) rolls back the budget decrement too.
    try {
      const txn = this.db.transaction((): ControlMessage => {
        if (grantId !== undefined && !this.store.incrementGrantUsage(grantId, now)) {
          throw new BudgetGateRefusedError();
        }
        const message = this.store.enqueueMessage(
          {
            ...(parsed.message_id !== undefined ? { message_id: parsed.message_id } : {}),
            source_session_id: parsed.source_session_id,
            target_session_id: parsed.target_session_id,
            sender_kind: parsed.sender_kind,
            content: redactedContent,
            content_hash,
            redaction,
            ...(parsed.expires_at !== undefined ? { expires_at: parsed.expires_at } : {}),
          },
          now,
        );
        this.store.appendEvent(
          {
            session_id: message.target_session_id,
            event_type: 'message_enqueued',
            source_session_id: message.source_session_id,
            target_session_id: message.target_session_id,
            payload: {
              message_id: message.message_id,
              sender_kind: message.sender_kind,
              content_hash: message.content_hash,
            },
          },
          now,
        );
        return message;
      });
      return txn();
    } catch (err) {
      if (err instanceof BudgetGateRefusedError) {
        // Race between checkGrant and the atomic gate (revoked/expired/spent
        // concurrently). The transaction rolled back; audit the deny.
        this.blockSend(
          ctx,
          'budget_exhausted',
          'CONTROL_BUDGET_EXHAUSTED',
          `llm send ${parsed.source_session_id} -> ${parsed.target_session_id} denied: ` +
            'grant became unusable during send',
        );
      }
      throw err;
    }
  }

  /**
   * D-04 grant policy check for a source → target pair. Pure read — the
   * atomic budget decrement inside sendMessage is the enforcement point.
   */
  checkGrant(source_session_id: string, target_session_id: string, now: number = Date.now()): GrantCheck {
    const grant = this.store.getGrant(source_session_id, target_session_id);
    if (!grant) {
      return Object.freeze({ allowed: false as const, reason: 'no_grant' as const });
    }
    if (grant.expires_at <= now) {
      return Object.freeze({ allowed: false as const, reason: 'expired' as const });
    }
    if (grant.used_messages >= grant.max_messages) {
      return Object.freeze({ allowed: false as const, reason: 'exhausted' as const });
    }
    return Object.freeze({ allowed: true as const, grant });
  }

  /** Transition to delivered + target-anchored `message_delivered` event, atomically. */
  markDelivered(
    message_id: string,
    opts: { capability?: ControlCapability; now?: number } = {},
  ): ControlMessage {
    return this.finishMessage(message_id, 'delivered', opts);
  }

  /** Transition to failed + target-anchored `message_failed` event, atomically. */
  markFailed(
    message_id: string,
    reason: string,
    opts: { capability?: ControlCapability; now?: number } = {},
  ): ControlMessage {
    return this.finishMessage(message_id, 'failed', opts, reason);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private static readonly GRANT_DENIALS: Readonly<
    Record<
      'no_grant' | 'expired' | 'exhausted',
      { reason: BlockReason; code: ErrorCode; detail: string }
    >
  > = {
    no_grant: {
      reason: 'grant_required',
      code: 'CONTROL_GRANT_REQUIRED',
      detail: 'no grant for this pair (llm sends are default-deny, D-04)',
    },
    expired: {
      reason: 'grant_expired',
      code: 'CONTROL_GRANT_EXPIRED',
      detail: 'grant TTL has expired',
    },
    exhausted: {
      reason: 'budget_exhausted',
      code: 'CONTROL_BUDGET_EXHAUSTED',
      detail: 'grant message budget is exhausted',
    },
  };

  /**
   * Audit a deny as a source-anchored `message_blocked` event, then throw.
   * Runs OUTSIDE the send transaction so the audit row survives the deny.
   * Payload carries the normalized content hash, never the content (D-06).
   */
  private blockSend(
    ctx: {
      source_session_id: string;
      target_session_id: string;
      sender_kind: ControlSenderKind;
      content_hash: string;
      now: number;
    },
    reason: BlockReason,
    code: ErrorCode,
    message: string,
  ): never {
    this.store.appendEvent(
      {
        session_id: ctx.source_session_id,
        event_type: 'message_blocked',
        source_session_id: ctx.source_session_id,
        target_session_id: ctx.target_session_id,
        payload: { reason, sender_kind: ctx.sender_kind, content_hash: ctx.content_hash },
      },
      ctx.now,
    );
    throw toRelayException(makeError(code, message, false));
  }

  /** Shared delivered/failed wrapper: store transition + audit event in one txn. */
  private finishMessage(
    message_id: string,
    outcome: 'delivered' | 'failed',
    opts: { capability?: ControlCapability; now?: number },
    failReason?: string,
  ): ControlMessage {
    const now = opts.now ?? Date.now();
    const txn = this.db.transaction((): ControlMessage => {
      const message =
        outcome === 'delivered'
          ? this.store.markDelivered(message_id, now)
          : this.store.markFailed(message_id, failReason ?? 'delivery failed', now);
      this.store.appendEvent(
        {
          session_id: message.target_session_id,
          event_type: outcome === 'delivered' ? 'message_delivered' : 'message_failed',
          source_session_id: message.source_session_id,
          target_session_id: message.target_session_id,
          payload: {
            message_id,
            ...(opts.capability !== undefined ? { capability: opts.capability } : {}),
            ...(outcome === 'failed' ? { reason: failReason ?? 'delivery failed' } : {}),
          },
        },
        now,
      );
      return message;
    });
    return txn();
  }

  /**
   * Loop-detection aggregate: persisted messages (any status) between the
   * pair IN BOTH DIRECTIONS with the same normalized hash since `since`.
   * Read-only policy query — kept in the broker because the 08-01 store is
   * deliberately mechanical (no policy aggregates).
   */
  private countRecentPairMessages(
    a: string,
    b: string,
    content_hash: string,
    since: number,
  ): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM control_mailbox
         WHERE content_hash = ? AND created_at >= ?
           AND ((source_session_id = ? AND target_session_id = ?)
             OR (source_session_id = ? AND target_session_id = ?))`,
      )
      .get(content_hash, since, a, b, b, a) as { n: number };
    return row.n;
  }
}

export function createControlBroker(store?: ControlSessionStore): ControlBroker {
  return new ControlBroker(store ?? new ControlSessionStore());
}
