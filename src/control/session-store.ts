/**
 * Synchronous SQLite control-session store (Phase 8 / Plan 01 / Task 2).
 *
 * Backs the universal control layer with five v4 tables (see the v4
 * migration in src/runtime/store/db.ts): control_sessions, control_events,
 * control_mailbox, control_grants, control_delivery_attempts.
 *
 * Contracts:
 *   - better-sqlite3 is SYNCHRONOUS — no method here is async and no DB call
 *     is awaited. Multi-statement operations run inside db.transaction.
 *   - Every boundary input is Zod-validated (types.ts schemas); malformed
 *     input throws RelayError INVALID_ARGS.
 *   - Rows read back from SQLite are re-validated; corrupted persisted JSON
 *     (e.g. hand-edited capabilities_json) throws RelayError CONFIG_ERROR
 *     instead of leaking garbage into the control plane (D-05).
 *   - All returned objects are frozen (schemas are .readonly()).
 *   - Policy (grant checks, TTL decisions, loop detection) lives in the
 *     broker (Plan 02). This store is mechanical persistence + transitions.
 */
import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import type { z } from 'zod';

import { getDb } from '../runtime/store/db.js';
import { makeError, toRelayException, type RelayException } from '../errors.js';
import {
  ControlEventInputSchema,
  ControlEventSchema,
  ControlGrantInputSchema,
  ControlGrantSchema,
  ControlMessageSchema,
  ControlMessageStatusSchema,
  ControlProviderSchema,
  ControlSendInputSchema,
  ControlSessionInputSchema,
  ControlSessionSchema,
  ControlSessionStateSchema,
  DeliveryAttemptInputSchema,
  DeliveryAttemptSchema,
  type ControlEvent,
  type ControlEventType,
  type ControlGrant,
  type ControlMessage,
  type ControlMessageStatus,
  type ControlProvider,
  type ControlSession,
  type ControlSessionState,
  type DeliveryAttempt,
} from './types.js';

// ─── Row shapes (snake_case mirrors of the v4 DDL) ──────────────────────────

type SessionRow = {
  session_id: string;
  provider: string;
  capabilities_json: string;
  state: string;
  label: string | null;
  workdir: string | null;
  pid: number | null;
  metadata_json: string | null;
  registered_at: number;
  last_seen_at: number;
};

type EventRow = {
  id: number;
  session_id: string;
  event_type: string;
  source_session_id: string | null;
  target_session_id: string | null;
  payload_json: string;
  created_at: number;
};

type MessageRow = {
  message_id: string;
  source_session_id: string;
  target_session_id: string;
  sender_kind: string;
  content: string;
  content_hash: string;
  status: string;
  redaction_json: string;
  fail_reason: string | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
};

type GrantRow = {
  grant_id: string;
  source_session_id: string;
  target_session_id: string;
  max_messages: number;
  used_messages: number;
  expires_at: number;
  created_at: number;
  revoked_at: number | null;
};

type AttemptRow = {
  id: number;
  message_id: string;
  attempt_number: number;
  capability: string;
  status: string;
  detail: string | null;
  created_at: number;
};

// ─── Error helpers ──────────────────────────────────────────────────────────

function invalidArgs(message: string): RelayException {
  return toRelayException(makeError('INVALID_ARGS', message, false));
}

function notFoundErr(what: string): RelayException {
  return toRelayException(makeError('RUN_NOT_FOUND', `${what} not found`, false));
}

function corruptedRow(what: string, detail: string): RelayException {
  return toRelayException(
    makeError('CONFIG_ERROR', `${what} is corrupted in the control store: ${detail}`, false),
  );
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

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    String((err as { code?: unknown }).code).startsWith('SQLITE_CONSTRAINT')
  );
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Clamp a read limit to [1, 1000] — same bound contract as tailEvents. */
function clampLimit(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit), 1), 1000);
}

// ─── Store ──────────────────────────────────────────────────────────────────

export class ControlSessionStore {
  private readonly db: Database.Database;

  /**
   * Allowed mailbox status transitions (documented in types.ts):
   *   queued → delivered | failed | expired; delivered → acknowledged;
   *   acknowledged / failed / expired are terminal.
   */
  private static readonly ALLOWED_TRANSITIONS: Readonly<
    Record<ControlMessageStatus, readonly ControlMessageStatus[]>
  > = {
    queued: ['delivered', 'failed', 'expired'],
    delivered: ['acknowledged'],
    acknowledged: [],
    failed: [],
    expired: [],
  };

  constructor() {
    this.db = getDb();
  }

  // ── Sessions (CONTROL-01) ─────────────────────────────────────────────────

  /**
   * Register or refresh a session. Insert stamps registered_at = last_seen_at
   * = now; update is full-replace of the mutable fields (the input is the
   * session's current truth), preserves registered_at, and bumps last_seen_at.
   */
  upsertSession(input: unknown, now: number = Date.now()): ControlSession {
    const parsed = boundary(ControlSessionInputSchema, input, 'control session');
    const capabilitiesJson = JSON.stringify([...new Set(parsed.capabilities)]);
    const metadataJson = parsed.metadata == null ? null : JSON.stringify(parsed.metadata);

    const txn = this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT registered_at FROM control_sessions WHERE session_id = ?')
        .get(parsed.session_id) as { registered_at: number } | undefined;
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO control_sessions (
              session_id, provider, capabilities_json, state, label, workdir,
              pid, metadata_json, registered_at, last_seen_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            parsed.session_id,
            parsed.provider,
            capabilitiesJson,
            parsed.state,
            parsed.label ?? null,
            parsed.workdir ?? null,
            parsed.pid ?? null,
            metadataJson,
            now,
            now,
          );
      } else {
        this.db
          .prepare(
            `UPDATE control_sessions SET
              provider = ?, capabilities_json = ?, state = ?, label = ?,
              workdir = ?, pid = ?, metadata_json = ?, last_seen_at = ?
             WHERE session_id = ?`,
          )
          .run(
            parsed.provider,
            capabilitiesJson,
            parsed.state,
            parsed.label ?? null,
            parsed.workdir ?? null,
            parsed.pid ?? null,
            metadataJson,
            now,
            parsed.session_id,
          );
      }
    });
    txn();
    return this.mustGetSession(parsed.session_id);
  }

  getSession(session_id: string): ControlSession | undefined {
    const row = this.db
      .prepare('SELECT * FROM control_sessions WHERE session_id = ?')
      .get(session_id) as SessionRow | undefined;
    return row ? this.rowToSession(row) : undefined;
  }

  listSessions(filters?: {
    provider?: ControlProvider;
    state?: ControlSessionState;
    limit?: number;
  }): ControlSession[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filters?.provider !== undefined) {
      clauses.push('provider = ?');
      params.push(filters.provider);
    }
    if (filters?.state !== undefined) {
      clauses.push('state = ?');
      params.push(filters.state);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    let sql = `SELECT * FROM control_sessions ${where} ORDER BY last_seen_at DESC, session_id ASC`;
    if (filters?.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(clampLimit(filters.limit));
    }
    const rows = this.db
      .prepare(sql)
      .all(...(params as Parameters<Database.Statement['all']>)) as SessionRow[];
    return rows.map((row) => this.rowToSession(row));
  }

  /**
   * Bounded aggregate for the Command Central read model: session counts
   * grouped by provider and state. Output is at most |providers| x |states|
   * rows, so provider rollups stay correct even when the roster read is
   * truncated by its limit. Rows are enum-validated like every other read.
   */
  countSessionsByProviderState(): Array<{
    provider: ControlProvider;
    state: ControlSessionState;
    count: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT provider, state, COUNT(*) AS count FROM control_sessions
         GROUP BY provider, state ORDER BY provider ASC, state ASC`,
      )
      .all() as Array<{ provider: string; state: string; count: number }>;
    return rows.map((row) => {
      const provider = ControlProviderSchema.safeParse(row.provider);
      const state = ControlSessionStateSchema.safeParse(row.state);
      if (!provider.success || !state.success) {
        throw corruptedRow(
          'control session aggregate',
          `unknown provider/state "${row.provider}"/"${row.state}"`,
        );
      }
      return { provider: provider.data, state: state.data, count: row.count };
    });
  }

  // ── Events (CONTROL-02, D-05) ─────────────────────────────────────────────

  appendEvent(input: unknown, now: number = Date.now()): ControlEvent {
    const parsed = boundary(ControlEventInputSchema, input, 'control event');
    const info = this.db
      .prepare(
        `INSERT INTO control_events (
          session_id, event_type, source_session_id, target_session_id, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.session_id,
        parsed.event_type,
        parsed.source_session_id ?? null,
        parsed.target_session_id ?? null,
        JSON.stringify(parsed.payload),
        now,
      );
    const row = this.db
      .prepare('SELECT * FROM control_events WHERE id = ?')
      .get(Number(info.lastInsertRowid)) as EventRow;
    return this.rowToEvent(row);
  }

  /**
   * Tail a session's events in append order. `after_id` is the monotonic
   * cursor (pass the last seen event id to poll for new events).
   */
  tailEvents(session_id: string, opts?: { after_id?: number; limit?: number }): ControlEvent[] {
    const after = opts?.after_id ?? 0;
    const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 1000);
    const rows = this.db
      .prepare('SELECT * FROM control_events WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?')
      .all(session_id, after, limit) as EventRow[];
    return rows.map((row) => this.rowToEvent(row));
  }

  /**
   * Recent events, NEWEST first (id DESC) — the Command Central read-model
   * feed for audit, blocked, pending-action, and selected-session panes.
   * Optional session/event-type filters; the limit is always clamped, so
   * every call is a bounded read (D-12). An explicitly empty `event_types`
   * array selects nothing.
   */
  listRecentEvents(opts?: {
    session_id?: string;
    event_types?: readonly ControlEventType[];
    limit?: number;
  }): ControlEvent[] {
    if (opts?.event_types !== undefined && opts.event_types.length === 0) return [];
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts?.session_id !== undefined) {
      clauses.push('session_id = ?');
      params.push(opts.session_id);
    }
    if (opts?.event_types !== undefined) {
      clauses.push(`event_type IN (${opts.event_types.map(() => '?').join(', ')})`);
      params.push(...opts.event_types);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(clampLimit(opts?.limit ?? 100));
    const rows = this.db
      .prepare(`SELECT * FROM control_events ${where} ORDER BY id DESC LIMIT ?`)
      .all(...(params as Parameters<Database.Statement['all']>)) as EventRow[];
    return rows.map((row) => this.rowToEvent(row));
  }

  /**
   * All D-14 control lifecycle events (control_requested / approved / denied
   * / executed) whose payload names this request_id, in append order. Used by
   * the broker's approval queue; mechanical read — resolution POLICY stays in
   * the broker. Naturally tiny per request; bounded for safety.
   */
  listControlRequestEvents(request_id: string): ControlEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM control_events
         WHERE event_type IN ('control_requested', 'control_approved', 'control_denied', 'control_executed')
           AND json_extract(payload_json, '$.request_id') = ?
         ORDER BY id ASC LIMIT 1000`,
      )
      .all(request_id) as EventRow[];
    return rows.map((row) => this.rowToEvent(row));
  }

  // ── Mailbox (D-04/D-05/D-06) ──────────────────────────────────────────────

  /**
   * Queue a cross-session message. The broker (Plan 02) supplies normalized
   * content_hash and redaction metadata; when absent the store computes a
   * plain sha256 of content and records redaction as not-applied.
   */
  enqueueMessage(input: unknown, now: number = Date.now()): ControlMessage {
    const parsed = boundary(ControlSendInputSchema, input, 'control send');
    const message_id = parsed.message_id ?? randomUUID();
    const content_hash = parsed.content_hash ?? sha256Hex(parsed.content);
    const redaction = parsed.redaction ?? { applied: false, rules: [] };
    try {
      this.db
        .prepare(
          `INSERT INTO control_mailbox (
            message_id, source_session_id, target_session_id, sender_kind,
            content, content_hash, status, redaction_json, fail_reason,
            expires_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, NULL, ?, ?, ?)`,
        )
        .run(
          message_id,
          parsed.source_session_id,
          parsed.target_session_id,
          parsed.sender_kind,
          parsed.content,
          content_hash,
          JSON.stringify(redaction),
          parsed.expires_at ?? null,
          now,
          now,
        );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw invalidArgs(`duplicate message_id: ${message_id}`);
      }
      throw err;
    }
    return this.mustGetMessage(message_id);
  }

  getMessage(message_id: string): ControlMessage | undefined {
    const row = this.db
      .prepare('SELECT * FROM control_mailbox WHERE message_id = ?')
      .get(message_id) as MessageRow | undefined;
    return row ? this.rowToMessage(row) : undefined;
  }

  /** Queued, unexpired messages for a target, oldest first. */
  getQueuedMessages(target_session_id: string, now: number = Date.now()): ControlMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM control_mailbox
         WHERE target_session_id = ? AND status = 'queued'
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(target_session_id, now) as MessageRow[];
    return rows.map((row) => this.rowToMessage(row));
  }

  /**
   * Global queued backlog: queued, unexpired messages across ALL targets,
   * oldest first (delivery order) — the Command Central inbox feed. The
   * limit is always clamped, so this is a bounded read (D-12).
   */
  listQueuedMessages(opts?: { now?: number; limit?: number }): ControlMessage[] {
    const now = opts?.now ?? Date.now();
    const limit = clampLimit(opts?.limit ?? 100);
    const rows = this.db
      .prepare(
        `SELECT * FROM control_mailbox
         WHERE status = 'queued' AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY created_at ASC, rowid ASC LIMIT ?`,
      )
      .all(now, limit) as MessageRow[];
    return rows.map((row) => this.rowToMessage(row));
  }

  markDelivered(message_id: string, now: number = Date.now()): ControlMessage {
    return this.transitionMessage(message_id, 'delivered', now);
  }

  markAcknowledged(message_id: string, now: number = Date.now()): ControlMessage {
    return this.transitionMessage(message_id, 'acknowledged', now);
  }

  markFailed(message_id: string, reason: string, now: number = Date.now()): ControlMessage {
    return this.transitionMessage(message_id, 'failed', now, reason);
  }

  markExpired(message_id: string, now: number = Date.now()): ControlMessage {
    return this.transitionMessage(message_id, 'expired', now);
  }

  // ── Grants (D-04) ─────────────────────────────────────────────────────────

  /** Issue a TTL-bound, budgeted grant allowing source → target sends. */
  grant(input: unknown, now: number = Date.now()): ControlGrant {
    const parsed = boundary(ControlGrantInputSchema, input, 'control grant');
    const grant_id = parsed.grant_id ?? randomUUID();
    try {
      this.db
        .prepare(
          `INSERT INTO control_grants (
            grant_id, source_session_id, target_session_id, max_messages,
            used_messages, expires_at, created_at, revoked_at
          ) VALUES (?, ?, ?, ?, 0, ?, ?, NULL)`,
        )
        .run(
          grant_id,
          parsed.source_session_id,
          parsed.target_session_id,
          parsed.max_messages,
          now + parsed.ttl_ms,
          now,
        );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw invalidArgs(`duplicate grant_id: ${grant_id}`);
      }
      throw err;
    }
    return this.mustGetGrantById(grant_id);
  }

  /**
   * Latest non-revoked grant for a source → target pair. Expiry and budget
   * are NOT filtered here — the broker owns those policy decisions (D-04)
   * and uses incrementGrantUsage as the atomic budget gate.
   */
  getGrant(source_session_id: string, target_session_id: string): ControlGrant | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM control_grants
         WHERE source_session_id = ? AND target_session_id = ? AND revoked_at IS NULL
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(source_session_id, target_session_id) as GrantRow | undefined;
    return row ? this.rowToGrant(row) : undefined;
  }

  /**
   * Grants for the operator console, newest first, bounded (D-12). When
   * `active_at` is given, only non-revoked grants whose TTL outlives that
   * instant are returned. Budget exhaustion is NOT filtered — exhausted
   * grants stay visible so the operator can revoke or re-issue them.
   */
  listGrants(opts?: { active_at?: number; limit?: number }): ControlGrant[] {
    const params: unknown[] = [];
    let where = '';
    if (opts?.active_at !== undefined) {
      where = 'WHERE revoked_at IS NULL AND expires_at > ?';
      params.push(opts.active_at);
    }
    params.push(clampLimit(opts?.limit ?? 100));
    const rows = this.db
      .prepare(
        `SELECT * FROM control_grants ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...(params as Parameters<Database.Statement['all']>)) as GrantRow[];
    return rows.map((row) => this.rowToGrant(row));
  }

  /** Revoke a grant (idempotent — re-revoking returns the existing record). */
  revoke(grant_id: string, now: number = Date.now()): ControlGrant {
    const txn = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT revoked_at FROM control_grants WHERE grant_id = ?')
        .get(grant_id) as { revoked_at: number | null } | undefined;
      if (!row) throw notFoundErr(`Control grant ${grant_id}`);
      if (row.revoked_at == null) {
        this.db
          .prepare('UPDATE control_grants SET revoked_at = ? WHERE grant_id = ?')
          .run(now, grant_id);
      }
    });
    txn();
    return this.mustGetGrantById(grant_id);
  }

  /**
   * Atomically consume one unit of a grant's message budget. Returns false
   * when the grant is missing, revoked, expired, or exhausted — the guarded
   * single UPDATE is the D-04 budget gate the broker relies on.
   */
  incrementGrantUsage(grant_id: string, now: number = Date.now()): boolean {
    const result = this.db
      .prepare(
        `UPDATE control_grants SET used_messages = used_messages + 1
         WHERE grant_id = ? AND revoked_at IS NULL AND expires_at > ?
           AND used_messages < max_messages`,
      )
      .run(grant_id, now);
    return result.changes === 1;
  }

  // ── Delivery attempts (D-05) ──────────────────────────────────────────────

  /** Record one delivery attempt; attempt_number auto-increments per message. */
  recordDeliveryAttempt(input: unknown, now: number = Date.now()): DeliveryAttempt {
    const parsed = boundary(DeliveryAttemptInputSchema, input, 'delivery attempt');
    let insertedId = 0;
    const txn = this.db.transaction(() => {
      const exists = this.db
        .prepare('SELECT 1 AS one FROM control_mailbox WHERE message_id = ?')
        .get(parsed.message_id);
      if (!exists) throw notFoundErr(`Control message ${parsed.message_id}`);
      const next = (
        this.db
          .prepare(
            'SELECT COALESCE(MAX(attempt_number), 0) + 1 AS n FROM control_delivery_attempts WHERE message_id = ?',
          )
          .get(parsed.message_id) as { n: number }
      ).n;
      const info = this.db
        .prepare(
          `INSERT INTO control_delivery_attempts (
            message_id, attempt_number, capability, status, detail, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(parsed.message_id, next, parsed.capability, parsed.status, parsed.detail ?? null, now);
      insertedId = Number(info.lastInsertRowid);
    });
    txn();
    const row = this.db
      .prepare('SELECT * FROM control_delivery_attempts WHERE id = ?')
      .get(insertedId) as AttemptRow;
    return this.rowToAttempt(row);
  }

  listDeliveryAttempts(message_id: string): DeliveryAttempt[] {
    const rows = this.db
      .prepare('SELECT * FROM control_delivery_attempts WHERE message_id = ? ORDER BY attempt_number ASC')
      .all(message_id) as AttemptRow[];
    return rows.map((row) => this.rowToAttempt(row));
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** Guarded status transition inside one transaction (read → validate → update). */
  private transitionMessage(
    message_id: string,
    to: ControlMessageStatus,
    now: number,
    failReason?: string,
  ): ControlMessage {
    const txn = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT status FROM control_mailbox WHERE message_id = ?')
        .get(message_id) as { status: string } | undefined;
      if (!row) throw notFoundErr(`Control message ${message_id}`);
      const from = ControlMessageStatusSchema.safeParse(row.status);
      if (!from.success) {
        throw corruptedRow(`control message ${message_id}`, `unknown status "${row.status}"`);
      }
      if (!ControlSessionStore.ALLOWED_TRANSITIONS[from.data].includes(to)) {
        throw invalidArgs(
          `illegal message status transition ${from.data} -> ${to} for ${message_id}`,
        );
      }
      this.db
        .prepare(
          'UPDATE control_mailbox SET status = ?, updated_at = ?, fail_reason = COALESCE(?, fail_reason) WHERE message_id = ?',
        )
        .run(to, now, failReason ?? null, message_id);
    });
    txn();
    return this.mustGetMessage(message_id);
  }

  private mustGetSession(session_id: string): ControlSession {
    const session = this.getSession(session_id);
    if (!session) throw notFoundErr(`Control session ${session_id}`);
    return session;
  }

  private mustGetMessage(message_id: string): ControlMessage {
    const message = this.getMessage(message_id);
    if (!message) throw notFoundErr(`Control message ${message_id}`);
    return message;
  }

  private mustGetGrantById(grant_id: string): ControlGrant {
    const row = this.db
      .prepare('SELECT * FROM control_grants WHERE grant_id = ?')
      .get(grant_id) as GrantRow | undefined;
    if (!row) throw notFoundErr(`Control grant ${grant_id}`);
    return this.rowToGrant(row);
  }

  private rowToSession(row: SessionRow): ControlSession {
    let capabilities: unknown;
    let metadata: unknown = null;
    try {
      capabilities = JSON.parse(row.capabilities_json);
      metadata = row.metadata_json == null ? null : JSON.parse(row.metadata_json);
    } catch (err) {
      throw corruptedRow(
        `control session ${row.session_id}`,
        `unparseable JSON (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    const parsed = ControlSessionSchema.safeParse({
      session_id: row.session_id,
      provider: row.provider,
      capabilities,
      state: row.state,
      label: row.label,
      workdir: row.workdir,
      pid: row.pid,
      metadata,
      registered_at: row.registered_at,
      last_seen_at: row.last_seen_at,
    });
    if (!parsed.success) {
      throw corruptedRow(`control session ${row.session_id}`, parsed.error.issues[0]?.message ?? 'schema mismatch');
    }
    return parsed.data;
  }

  private rowToEvent(row: EventRow): ControlEvent {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json);
    } catch (err) {
      throw corruptedRow(
        `control event ${row.id}`,
        `unparseable payload JSON (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    const parsed = ControlEventSchema.safeParse({
      id: row.id,
      session_id: row.session_id,
      event_type: row.event_type,
      source_session_id: row.source_session_id,
      target_session_id: row.target_session_id,
      payload,
      created_at: row.created_at,
    });
    if (!parsed.success) {
      throw corruptedRow(`control event ${row.id}`, parsed.error.issues[0]?.message ?? 'schema mismatch');
    }
    return parsed.data;
  }

  private rowToMessage(row: MessageRow): ControlMessage {
    let redaction: unknown;
    try {
      redaction = JSON.parse(row.redaction_json);
    } catch (err) {
      throw corruptedRow(
        `control message ${row.message_id}`,
        `unparseable redaction JSON (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    const parsed = ControlMessageSchema.safeParse({
      message_id: row.message_id,
      source_session_id: row.source_session_id,
      target_session_id: row.target_session_id,
      sender_kind: row.sender_kind,
      content: row.content,
      content_hash: row.content_hash,
      status: row.status,
      redaction,
      fail_reason: row.fail_reason,
      expires_at: row.expires_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
    if (!parsed.success) {
      throw corruptedRow(`control message ${row.message_id}`, parsed.error.issues[0]?.message ?? 'schema mismatch');
    }
    return parsed.data;
  }

  private rowToGrant(row: GrantRow): ControlGrant {
    const parsed = ControlGrantSchema.safeParse({
      grant_id: row.grant_id,
      source_session_id: row.source_session_id,
      target_session_id: row.target_session_id,
      max_messages: row.max_messages,
      used_messages: row.used_messages,
      expires_at: row.expires_at,
      created_at: row.created_at,
      revoked_at: row.revoked_at,
    });
    if (!parsed.success) {
      throw corruptedRow(`control grant ${row.grant_id}`, parsed.error.issues[0]?.message ?? 'schema mismatch');
    }
    return parsed.data;
  }

  private rowToAttempt(row: AttemptRow): DeliveryAttempt {
    const parsed = DeliveryAttemptSchema.safeParse({
      id: row.id,
      message_id: row.message_id,
      attempt_number: row.attempt_number,
      capability: row.capability,
      status: row.status,
      detail: row.detail,
      created_at: row.created_at,
    });
    if (!parsed.success) {
      throw corruptedRow(`delivery attempt ${row.id}`, parsed.error.issues[0]?.message ?? 'schema mismatch');
    }
    return parsed.data;
  }
}

export function getControlSessionStore(): ControlSessionStore {
  return new ControlSessionStore();
}
