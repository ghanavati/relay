/**
 * Universal control types and capability taxonomy (Phase 8 / Plan 01).
 *
 * D-01 — Relay models delivery and control as EXPLICIT adapter capabilities.
 * The `ControlCapability` set is closed: an adapter reports exactly which
 * operations it supports and commands refuse unsupported operations instead
 * of silently degrading. Nothing in this module infers behavior from a
 * provider name.
 *
 * D-02 — Strong live control (`live_stdin`, `interrupt`) exists only for
 * provider APIs or Relay-owned processes; ambient sessions are limited to
 * truthful `mailbox` / `context_inject` delivery.
 *
 * D-05 — Every cross-session message is auditable with source, target,
 * status, delivery attempts, content hash, and redaction metadata. The
 * shapes here are the boundary contracts the SQLite store (session-store.ts)
 * and the broker (Plan 02) persist and validate.
 *
 * All schemas are `.strict()` (unknown keys rejected) and `.readonly()`
 * (parse output frozen) — boundary input is validated and immutable.
 */
import { z } from 'zod';

// ─── JSON boundary primitive ────────────────────────────────────────────────

const literalSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
type Literal = z.infer<typeof literalSchema>;

/** JSON-serializable value — rejects Dates, functions, BigInt, NaN/Infinity. */
export type JsonValue = Literal | { [key: string]: JsonValue } | JsonValue[];

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([literalSchema, z.array(JsonValueSchema), z.record(JsonValueSchema)]),
);

// ─── Capability taxonomy (D-01, RESEARCH.md) ────────────────────────────────

/**
 * Closed capability set. Order mirrors the RESEARCH.md taxonomy table.
 *
 *   register       — adapter can create/update session records.
 *   observe        — Relay can read transcript/events for the session.
 *   tail           — Relay can stream new events.
 *   context_inject — Relay can add context at a host-defined boundary.
 *   mailbox        — Relay can queue messages for later delivery.
 *   resume_send    — Relay can resume a stored session and send a prompt.
 *   live_stdin     — Relay can write to a running process it owns.
 *   interrupt      — Relay can cancel/interrupt execution.
 *   fork           — Relay can branch a session.
 *   spawn          — Relay can start a new session.
 *   tool_call      — the LLM can call Relay control tools.
 */
export const CONTROL_CAPABILITIES = [
  'register',
  'observe',
  'tail',
  'context_inject',
  'mailbox',
  'resume_send',
  'live_stdin',
  'interrupt',
  'fork',
  'spawn',
  'tool_call',
] as const;

export const ControlCapabilitySchema = z.enum(CONTROL_CAPABILITIES);
export type ControlCapability = z.infer<typeof ControlCapabilitySchema>;

// ─── Providers and lifecycle value sets ─────────────────────────────────────

/** The six CONTROL-01 session surfaces. Adding a provider is an explicit schema change. */
export const CONTROL_PROVIDERS = [
  'claude-code',
  'codex',
  'lmstudio',
  'openrouter',
  'anthropic',
  'fake',
] as const;

export const ControlProviderSchema = z.enum(CONTROL_PROVIDERS);
export type ControlProvider = z.infer<typeof ControlProviderSchema>;

/**
 * Session lifecycle:
 *   active — live now (running process or open host session).
 *   idle   — registered and resumable, but not currently live (e.g. stored
 *            transcript sessions per D-10).
 *   ended  — closed; kept for audit/inspection.
 */
export const CONTROL_SESSION_STATES = ['active', 'idle', 'ended'] as const;
export const ControlSessionStateSchema = z.enum(CONTROL_SESSION_STATES);
export type ControlSessionState = z.infer<typeof ControlSessionStateSchema>;

/**
 * Mailbox message statuses. Allowed transitions (enforced by the store):
 *   queued    → delivered | failed | expired
 *   delivered → acknowledged
 *   acknowledged / failed / expired are terminal.
 */
export const CONTROL_MESSAGE_STATUSES = [
  'queued',
  'delivered',
  'acknowledged',
  'failed',
  'expired',
] as const;
export const ControlMessageStatusSchema = z.enum(CONTROL_MESSAGE_STATUSES);
export type ControlMessageStatus = z.infer<typeof ControlMessageStatusSchema>;

/** D-04 — user-initiated and agent-initiated sends follow different policy. */
export const CONTROL_SENDER_KINDS = ['human', 'llm'] as const;
export const ControlSenderKindSchema = z.enum(CONTROL_SENDER_KINDS);
export type ControlSenderKind = z.infer<typeof ControlSenderKindSchema>;

/**
 * Audit event types (D-05) plus the D-14 model-driven control lifecycle
 * (requested → approved/denied → executed). Closed set: new event types are
 * explicit schema changes, never free-form strings.
 */
export const CONTROL_EVENT_TYPES = [
  'session_registered',
  'session_updated',
  'session_ended',
  'message_enqueued',
  'message_blocked',
  'message_delivered',
  'message_acknowledged',
  'message_failed',
  'message_expired',
  'grant_issued',
  'grant_revoked',
  'delivery_attempted',
  'control_requested',
  'control_approved',
  'control_denied',
  'control_executed',
] as const;
export const ControlEventTypeSchema = z.enum(CONTROL_EVENT_TYPES);
export type ControlEventType = z.infer<typeof ControlEventTypeSchema>;

export const DELIVERY_ATTEMPT_STATUSES = ['success', 'failure'] as const;
export const DeliveryAttemptStatusSchema = z.enum(DELIVERY_ATTEMPT_STATUSES);
export type DeliveryAttemptStatus = z.infer<typeof DeliveryAttemptStatusSchema>;

// ─── Shared field primitives ────────────────────────────────────────────────

/** Upper bound for cross-session message content (boundary validation). */
export const MAX_CONTROL_CONTENT_CHARS = 100_000;

const idField = z.string().min(1).max(200);
const sha256HexField = z.string().regex(/^[a-f0-9]{64}$/, 'must be a lowercase sha256 hex digest');
const epochMsField = z.number().int().nonnegative();

/** D-06 — redaction metadata recorded with every cross-session message. */
export const ControlRedactionSchema = z
  .object({
    applied: z.boolean(),
    rules: z.array(z.string().min(1).max(100)).readonly().default([]),
  })
  .strict()
  .readonly();
export type ControlRedaction = z.infer<typeof ControlRedactionSchema>;

// ─── Sessions (CONTROL-01) ──────────────────────────────────────────────────

/** Boundary input for registering/updating a session. Store stamps timestamps. */
export const ControlSessionInputSchema = z
  .object({
    session_id: idField,
    provider: ControlProviderSchema,
    capabilities: z.array(ControlCapabilitySchema).min(1).readonly(),
    state: ControlSessionStateSchema.default('active'),
    label: z.string().min(1).max(200).nullable().optional(),
    workdir: z.string().min(1).max(1000).nullable().optional(),
    pid: z.number().int().positive().nullable().optional(),
    metadata: z.record(JsonValueSchema).nullable().optional(),
  })
  .strict()
  .readonly();
export type ControlSessionInput = z.infer<typeof ControlSessionInputSchema>;

/** Full session record as persisted/returned by the store. */
export const ControlSessionSchema = z
  .object({
    session_id: idField,
    provider: ControlProviderSchema,
    capabilities: z.array(ControlCapabilitySchema).min(1).readonly(),
    state: ControlSessionStateSchema,
    label: z.string().max(200).nullable(),
    workdir: z.string().max(1000).nullable(),
    pid: z.number().int().positive().nullable(),
    metadata: z.record(JsonValueSchema).nullable(),
    registered_at: epochMsField,
    last_seen_at: epochMsField,
  })
  .strict()
  .readonly();
export type ControlSession = z.infer<typeof ControlSessionSchema>;

// ─── Cross-session messages (D-04/D-05/D-06) ────────────────────────────────

/**
 * Boundary input for enqueueing a cross-session send. `content_hash` and
 * `redaction` may be supplied by the broker (which normalizes/redacts before
 * persistence); the store computes/defaults them when absent.
 */
export const ControlSendInputSchema = z
  .object({
    message_id: idField.optional(),
    source_session_id: idField,
    target_session_id: idField,
    sender_kind: ControlSenderKindSchema,
    content: z.string().min(1).max(MAX_CONTROL_CONTENT_CHARS),
    content_hash: sha256HexField.optional(),
    redaction: ControlRedactionSchema.optional(),
    expires_at: z.number().int().positive().nullable().optional(),
  })
  .strict()
  .readonly();
export type ControlSendInput = z.infer<typeof ControlSendInputSchema>;

/** Full mailbox message record. */
export const ControlMessageSchema = z
  .object({
    message_id: idField,
    source_session_id: idField,
    target_session_id: idField,
    sender_kind: ControlSenderKindSchema,
    content: z.string().min(1).max(MAX_CONTROL_CONTENT_CHARS),
    content_hash: sha256HexField,
    status: ControlMessageStatusSchema,
    redaction: ControlRedactionSchema,
    fail_reason: z.string().max(2000).nullable(),
    expires_at: z.number().int().positive().nullable(),
    created_at: epochMsField,
    updated_at: epochMsField,
  })
  .strict()
  .readonly();
export type ControlMessage = z.infer<typeof ControlMessageSchema>;

// ─── Audit events (D-05, CONTROL-02) ────────────────────────────────────────

/** Boundary input for appending an audit event. Store assigns id + created_at. */
export const ControlEventInputSchema = z
  .object({
    session_id: idField,
    event_type: ControlEventTypeSchema,
    source_session_id: idField.nullable().optional(),
    target_session_id: idField.nullable().optional(),
    payload: z.record(JsonValueSchema).default({}),
  })
  .strict()
  .readonly();
export type ControlEventInput = z.infer<typeof ControlEventInputSchema>;

/** Full audit event record. `id` is the monotonic tail cursor. */
export const ControlEventSchema = z
  .object({
    id: z.number().int().positive(),
    session_id: idField,
    event_type: ControlEventTypeSchema,
    source_session_id: idField.nullable(),
    target_session_id: idField.nullable(),
    payload: z.record(JsonValueSchema),
    created_at: epochMsField,
  })
  .strict()
  .readonly();
export type ControlEvent = z.infer<typeof ControlEventSchema>;

// ─── Grants (D-04) ──────────────────────────────────────────────────────────

/** Boundary input for issuing a grant: TTL and message budget are mandatory. */
export const ControlGrantInputSchema = z
  .object({
    grant_id: idField.optional(),
    source_session_id: idField,
    target_session_id: idField,
    ttl_ms: z.number().int().positive(),
    max_messages: z.number().int().min(1).max(10_000),
  })
  .strict()
  .readonly();
export type ControlGrantInput = z.infer<typeof ControlGrantInputSchema>;

/** Full grant record. A grant is usable while not revoked, not expired, and under budget. */
export const ControlGrantSchema = z
  .object({
    grant_id: idField,
    source_session_id: idField,
    target_session_id: idField,
    max_messages: z.number().int().min(1),
    used_messages: z.number().int().nonnegative(),
    expires_at: z.number().int().positive(),
    created_at: epochMsField,
    revoked_at: z.number().int().positive().nullable(),
  })
  .strict()
  .readonly();
export type ControlGrant = z.infer<typeof ControlGrantSchema>;

// ─── Delivery attempts (D-05) ───────────────────────────────────────────────

/** Boundary input for recording one delivery attempt. Store assigns attempt_number. */
export const DeliveryAttemptInputSchema = z
  .object({
    message_id: idField,
    capability: ControlCapabilitySchema,
    status: DeliveryAttemptStatusSchema,
    detail: z.string().max(2000).nullable().optional(),
  })
  .strict()
  .readonly();
export type DeliveryAttemptInput = z.infer<typeof DeliveryAttemptInputSchema>;

/** Full delivery attempt record. */
export const DeliveryAttemptSchema = z
  .object({
    id: z.number().int().positive(),
    message_id: idField,
    attempt_number: z.number().int().min(1),
    capability: ControlCapabilitySchema,
    status: DeliveryAttemptStatusSchema,
    detail: z.string().max(2000).nullable(),
    created_at: epochMsField,
  })
  .strict()
  .readonly();
export type DeliveryAttempt = z.infer<typeof DeliveryAttemptSchema>;

// ─── Adapter contract (D-01/D-02) ───────────────────────────────────────────

/** Result of one adapter delivery attempt, naming the capability used. */
export interface DeliveryOutcome {
  readonly ok: boolean;
  readonly capability: ControlCapability;
  readonly detail?: string;
}

/**
 * Provider adapter contract. Capabilities are DECLARED per adapter instance —
 * two adapters for the same provider may report different sets (e.g. an
 * ambient Claude Code session vs a Relay-owned one). Callers must check
 * `supports()` and refuse unsupported operations instead of degrading
 * silently (D-01).
 */
export interface ControlAdapter {
  readonly provider: ControlProvider;
  describeCapabilities(): readonly ControlCapability[];
  supports(capability: ControlCapability): boolean;
  deliver(message: ControlMessage, session: ControlSession): Promise<DeliveryOutcome>;
}
