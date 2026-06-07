/**
 * LLM-facing Relay control tools (Phase 8 / Plan 03 / Task 2).
 *
 * D-03 — LLM-to-LLM control is tools + message bus, never direct terminal
 * writes. These five tools are the ONLY model-facing control surface, and
 * every send routes through ControlBroker.sendMessage — the same policy
 * path the human CLI uses (D-13).
 *
 * D-04 — caller scoping is structural, not advisory:
 *   - `relay_session_send` binds source_session_id to the CALLER session at
 *     registration time; the args schema is strict, so a model-supplied
 *     source_session_id key is rejected (no spoofing).
 *   - `relay_inbox_read` / `relay_inbox_ack` operate only on the caller's
 *     own mailbox; foreign messages are indistinguishable from missing ones.
 *   - sender_kind is always 'llm' → broker default-deny, grants, TTLs,
 *     budgets, and loop detection all apply.
 *
 * D-14 — denials come back as structured `{ ok:false, code, message }`
 * results (visible denied state), never as silent degradation.
 *
 * D-08 / CONTROL-07 — `createControlSessionForRun` registers every
 * Relay-owned lmstudio-agentic run as a control session with a TRUTHFUL
 * capability set: only what is actually wired (mailbox pull + control tool
 * calls + observability). No live_stdin/context_inject overclaims (D-01).
 *
 * Synchronous better-sqlite3 throughout — handlers are async only to match
 * the worker's NamedToolHandler contract.
 */

import { z } from 'zod';

import { getDb } from '../runtime/store/db.js';
import { makeError, toRelayException, type RelayException } from '../errors.js';
import type { ToolDef } from '../workers/types.js';
import type { NamedToolHandler } from '../workers/lmstudio-agentic.js';
import { ControlSessionStore } from './session-store.js';
import { ControlBroker } from './broker.js';
import {
  CONTROL_PROVIDERS,
  CONTROL_SESSION_STATES,
  ControlProviderSchema,
  ControlSessionStateSchema,
  MAX_CONTROL_CONTENT_CHARS,
  type ControlCapability,
  type ControlSession,
} from './types.js';

// ─── Contracts ──────────────────────────────────────────────────────────────

/** Injection seam for tests; production builds default instances per call. */
export interface ControlToolDeps {
  readonly store?: ControlSessionStore;
  readonly broker?: ControlBroker;
}

/**
 * One model-facing control tool: an OpenAI-compatible declaration plus a
 * caller-bound handler. The caller session id is captured at registration —
 * it never travels through model-controlled arguments.
 */
export interface ControlToolHandler {
  readonly def: ToolDef;
  readonly handle: (args: unknown) => Promise<unknown>;
}

// ─── Boundary helpers ───────────────────────────────────────────────────────

const idField = z.string().min(1).max(200);

function invalidArgs(message: string): RelayException {
  return toRelayException(makeError('INVALID_ARGS', message, false));
}

/** Zod boundary gate — malformed model args become RelayError INVALID_ARGS. */
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

/**
 * Convert RelayError throws into structured `{ ok:false, code, message }`
 * tool results so the model sees the policy decision (D-14) instead of a
 * bare error string. Non-Relay errors propagate to the worker's dispatcher.
 */
function guard(handle: (args: unknown) => unknown): (args: unknown) => Promise<unknown> {
  return async (args: unknown) => {
    try {
      return await handle(args);
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (typeof code === 'string' && code.length > 0) {
        return { ok: false, code, message: (err as Error).message };
      }
      throw err;
    }
  };
}

// ─── Tool declarations (OpenAI-compatible) ──────────────────────────────────

const SESSION_LIST_DEF: ToolDef = {
  type: 'function',
  function: {
    name: 'relay_session_list',
    description:
      'List registered Relay control sessions (peers you can observe and, with a grant, message). ' +
      'Returns session_id, provider, state, declared capabilities, label, and last_seen_at.',
    parameters: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          enum: [...CONTROL_PROVIDERS],
          description: 'Optional provider filter.',
        },
        state: {
          type: 'string',
          enum: [...CONTROL_SESSION_STATES],
          description: 'Optional lifecycle-state filter.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

const SESSION_INSPECT_DEF: ToolDef = {
  type: 'function',
  function: {
    name: 'relay_session_inspect',
    description:
      'Inspect one Relay control session: summary, queued mailbox count, and whether YOUR session ' +
      'currently holds a usable grant to send to it.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Target session id (from relay_session_list).' },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
  },
};

const SESSION_SEND_DEF: ToolDef = {
  type: 'function',
  function: {
    name: 'relay_session_send',
    description:
      'Send a message to another Relay session through the policy broker. LLM sends are default-deny: ' +
      'they require an explicit human-issued grant (TTL + message budget) from your session to the target. ' +
      'Content is redacted and audited. Denials return { ok: false, code, message }.',
    parameters: {
      type: 'object',
      properties: {
        target_session_id: { type: 'string', description: 'Recipient session id.' },
        content: { type: 'string', description: 'Message content (max 100000 chars).' },
      },
      required: ['target_session_id', 'content'],
      additionalProperties: false,
    },
  },
};

const INBOX_READ_DEF: ToolDef = {
  type: 'function',
  function: {
    name: 'relay_inbox_read',
    description:
      'Read queued messages addressed to YOUR session. Returned messages are marked delivered ' +
      '(a second read returns only newer messages). Acknowledge processed messages with relay_inbox_ack.',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Max messages to pull (default 10).',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

const INBOX_ACK_DEF: ToolDef = {
  type: 'function',
  function: {
    name: 'relay_inbox_ack',
    description:
      'Acknowledge a delivered message from YOUR inbox after processing it. ' +
      'Only messages addressed to your session can be acknowledged.',
    parameters: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Message id from relay_inbox_read.' },
      },
      required: ['message_id'],
      additionalProperties: false,
    },
  },
};

/** The five model-facing control tools, in registration order. */
export const CONTROL_TOOL_DEFS: readonly ToolDef[] = Object.freeze([
  SESSION_LIST_DEF,
  SESSION_INSPECT_DEF,
  SESSION_SEND_DEF,
  INBOX_READ_DEF,
  INBOX_ACK_DEF,
]);

// ─── Arg schemas ────────────────────────────────────────────────────────────

const ListToolArgsSchema = z
  .object({
    provider: ControlProviderSchema.optional(),
    state: ControlSessionStateSchema.optional(),
  })
  .strict();

const InspectToolArgsSchema = z.object({ session_id: idField }).strict();

const SendToolArgsSchema = z
  .object({
    target_session_id: idField,
    content: z.string().min(1).max(MAX_CONTROL_CONTENT_CHARS),
  })
  .strict();

const InboxReadArgsSchema = z
  .object({ limit: z.number().int().positive().max(100).optional() })
  .strict();

const InboxAckArgsSchema = z.object({ message_id: idField }).strict();

const DEFAULT_INBOX_READ_LIMIT = 10;

// ─── Handlers ───────────────────────────────────────────────────────────────

/** Model-safe session projection: no workdir, pid, or metadata (least disclosure). */
function toSafeSummary(session: ControlSession): {
  session_id: string;
  provider: string;
  state: string;
  capabilities: readonly string[];
  label: string | null;
  last_seen_at: number;
} {
  return {
    session_id: session.session_id,
    provider: session.provider,
    state: session.state,
    capabilities: session.capabilities,
    label: session.label,
    last_seen_at: session.last_seen_at,
  };
}

function handleSessionList(args: unknown, store: ControlSessionStore): unknown {
  const parsed = boundary(ListToolArgsSchema, args ?? {}, 'relay_session_list args');
  const sessions = store.listSessions({ provider: parsed.provider, state: parsed.state });
  return { ok: true, sessions: sessions.map(toSafeSummary) };
}

function handleSessionInspect(
  args: unknown,
  callerSessionId: string,
  store: ControlSessionStore,
  broker: ControlBroker,
): unknown {
  const parsed = boundary(InspectToolArgsSchema, args, 'relay_session_inspect args');
  const session = store.getSession(parsed.session_id);
  if (!session) {
    throw toRelayException(
      makeError('CONTROL_SESSION_NOT_FOUND', `session ${parsed.session_id} is not registered`, false),
    );
  }
  const check = broker.checkGrant(callerSessionId, parsed.session_id);
  const grant = check.allowed
    ? {
        allowed: true,
        expires_at: check.grant.expires_at,
        remaining_messages: check.grant.max_messages - check.grant.used_messages,
      }
    : { allowed: false, reason: check.reason };
  return {
    ok: true,
    session: toSafeSummary(session),
    queued_count: store.getQueuedMessages(parsed.session_id).length,
    grant,
  };
}

function handleSessionSend(args: unknown, callerSessionId: string, broker: ControlBroker): unknown {
  const parsed = boundary(SendToolArgsSchema, args, 'relay_session_send args');
  const message = broker.sendMessage({
    source_session_id: callerSessionId,
    target_session_id: parsed.target_session_id,
    sender_kind: 'llm',
    content: parsed.content,
  });
  return {
    ok: true,
    message_id: message.message_id,
    target_session_id: message.target_session_id,
    status: message.status,
  };
}

function handleInboxRead(
  args: unknown,
  callerSessionId: string,
  store: ControlSessionStore,
  broker: ControlBroker,
): unknown {
  const parsed = boundary(InboxReadArgsSchema, args ?? {}, 'relay_inbox_read args');
  const limit = parsed.limit ?? DEFAULT_INBOX_READ_LIMIT;
  const now = Date.now();
  const queued = store.getQueuedMessages(callerSessionId, now).slice(0, limit);
  const messages = queued.map((message) => {
    // Pull-based mailbox delivery: reading IS the delivery (D-05 audit —
    // one delivery attempt + the broker's message_delivered event).
    store.recordDeliveryAttempt(
      {
        message_id: message.message_id,
        capability: 'mailbox',
        status: 'success',
        detail: 'pulled via relay_inbox_read',
      },
      now,
    );
    broker.markDelivered(message.message_id, { capability: 'mailbox', now });
    return {
      message_id: message.message_id,
      source_session_id: message.source_session_id,
      sender_kind: message.sender_kind,
      content: message.content,
      created_at: message.created_at,
    };
  });
  return { ok: true, messages };
}

function handleInboxAck(args: unknown, callerSessionId: string, store: ControlSessionStore): unknown {
  const parsed = boundary(InboxAckArgsSchema, args, 'relay_inbox_ack args');
  const message = store.getMessage(parsed.message_id);
  // Scoping with information hiding: a foreign message is indistinguishable
  // from a missing one — the caller learns nothing about other inboxes.
  if (!message || message.target_session_id !== callerSessionId) {
    throw toRelayException(
      makeError('RUN_NOT_FOUND', `message ${parsed.message_id} not found in your inbox`, false),
    );
  }
  const now = Date.now();
  const txn = getDb().transaction(() => {
    const acknowledged = store.markAcknowledged(parsed.message_id, now);
    store.appendEvent(
      {
        session_id: callerSessionId,
        event_type: 'message_acknowledged',
        source_session_id: acknowledged.source_session_id,
        target_session_id: acknowledged.target_session_id,
        payload: { message_id: acknowledged.message_id },
      },
      now,
    );
    return acknowledged;
  });
  const acknowledged = txn();
  return { ok: true, message_id: acknowledged.message_id, status: acknowledged.status };
}

// ─── Registration ───────────────────────────────────────────────────────────

/**
 * Build the five caller-bound control tool handlers. `callerSessionId` is the
 * Relay control session the model RUNS AS — captured here, never accepted
 * from model arguments.
 */
export function registerControlTools(
  callerSessionId: string,
  deps: ControlToolDeps = {},
): ControlToolHandler[] {
  const store = deps.store ?? new ControlSessionStore();
  const broker = deps.broker ?? new ControlBroker(store);
  return [
    { def: SESSION_LIST_DEF, handle: guard((args) => handleSessionList(args, store)) },
    {
      def: SESSION_INSPECT_DEF,
      handle: guard((args) => handleSessionInspect(args, callerSessionId, store, broker)),
    },
    { def: SESSION_SEND_DEF, handle: guard((args) => handleSessionSend(args, callerSessionId, broker)) },
    {
      def: INBOX_READ_DEF,
      handle: guard((args) => handleInboxRead(args, callerSessionId, store, broker)),
    },
    { def: INBOX_ACK_DEF, handle: guard((args) => handleInboxAck(args, callerSessionId, store)) },
  ];
}

/**
 * Adapt control handlers to the worker's NamedToolHandler contract
 * (extraToolHandlers path in LmStudioAgenticRunner). Control tools carry no
 * credential, so `pat` is omitted (optional since this plan).
 */
export function toNamedToolHandlers(handlers: readonly ControlToolHandler[]): NamedToolHandler[] {
  return handlers.map((handler) => ({
    name: handler.def.function.name,
    handle: (args: unknown, _ctx: { workdir: string; pat: string }) => handler.handle(args),
  }));
}

// ─── Run-scoped control session lifecycle (D-08, CONTROL-07) ───────────────

/**
 * Capabilities a Relay-owned lmstudio-agentic run ACTUALLY has wired today:
 * registration, event observability, mailbox pull (relay_inbox_read), and
 * control tool calls. Deliberately excludes live_stdin / context_inject /
 * interrupt until a real delivery path exists (D-01: no overclaims).
 */
const RUN_SESSION_CAPABILITIES: readonly ControlCapability[] = Object.freeze([
  'register',
  'observe',
  'tail',
  'mailbox',
  'tool_call',
]);

/**
 * Register the control session for one `relay run --provider lmstudio-agentic`
 * invocation. session_id == run_id so control events join cleanly against the
 * runs table.
 */
export function createControlSessionForRun(
  input: {
    run_id: string;
    workdir: string;
    model?: string | undefined;
    label?: string | undefined;
  },
  store: ControlSessionStore = new ControlSessionStore(),
  now: number = Date.now(),
): ControlSession {
  const txn = getDb().transaction(() => {
    const session = store.upsertSession(
      {
        session_id: input.run_id,
        provider: 'lmstudio',
        capabilities: RUN_SESSION_CAPABILITIES,
        state: 'active',
        label: input.label ?? null,
        workdir: input.workdir,
        pid: process.pid,
        metadata: {
          run_id: input.run_id,
          owned_by: 'relay',
          ...(input.model !== undefined ? { model: input.model } : {}),
        },
      },
      now,
    );
    store.appendEvent(
      {
        session_id: session.session_id,
        event_type: 'session_registered',
        payload: { provider: 'lmstudio', run_id: input.run_id },
      },
      now,
    );
    return session;
  });
  return txn();
}

/**
 * Mark a run's control session ended (called when the run finishes, on both
 * success and error paths). Unknown sessions return undefined — ending is
 * best-effort cleanup, not a policy gate.
 */
export function endControlSessionForRun(
  session_id: string,
  store: ControlSessionStore = new ControlSessionStore(),
  now: number = Date.now(),
): ControlSession | undefined {
  const existing = store.getSession(session_id);
  if (!existing) return undefined;
  const txn = getDb().transaction(() => {
    const session = store.upsertSession(
      {
        session_id,
        provider: existing.provider,
        capabilities: existing.capabilities,
        state: 'ended',
        label: existing.label,
        workdir: existing.workdir,
        pid: existing.pid,
        metadata: existing.metadata,
      },
      now,
    );
    store.appendEvent({ session_id, event_type: 'session_ended', payload: {} }, now);
    return session;
  });
  return txn();
}
