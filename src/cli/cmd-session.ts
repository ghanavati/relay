/**
 * `relay session ...` — human control surface over the universal control
 * layer (Phase 8 / Plan 03 / Task 1).
 *
 * Subcommands: list | inspect | tail | send | grant | revoke.
 *
 * D-03/D-13 — this CLI and the LLM-facing control tools (control/tools.ts)
 * share the SAME broker path: policy checks, redaction, loop detection, and
 * audit events are identical. The CLI never writes control tables directly;
 * it routes through ControlSessionStore, ControlBroker, and
 * ControlAdapterRegistry.
 *
 * D-04 — CLI sends are always sender_kind='human' (user-initiated). Grants
 * issued here are what authorize LLM-initiated sends; both TTL and message
 * budget are mandatory (defaults: 15m / 10 messages).
 *
 * D-01 — unsupported operations fail clearly: a target with no delivery
 * capability is refused with CONTROL_DELIVERY_UNSUPPORTED (exit 1), never
 * silently degraded.
 *
 * Exit codes: 0 success (message delivered or honestly queued), 1 runtime /
 * policy failure (RelayError code printed to stderr), 2 usage error (Zod
 * boundary rejection).
 */

import { z } from 'zod';

import type { CliIO } from './commands.js';
import { c } from './colors.js';
import { getDb } from '../runtime/store/db.js';
import { makeError, toRelayException } from '../errors.js';
import { ControlSessionStore } from '../control/session-store.js';
import { ControlBroker } from '../control/broker.js';
import { ControlAdapterRegistry } from '../control/adapter-registry.js';
import {
  ControlProviderSchema,
  ControlSessionStateSchema,
  MAX_CONTROL_CONTENT_CHARS,
  type ControlEvent,
  type ControlSession,
} from '../control/types.js';

// ─── Options and dependency seams ───────────────────────────────────────────

export interface SessionCommandOptions {
  readonly action: string;
  readonly positionals: readonly string[];
  readonly provider?: string | undefined;
  readonly state?: string | undefined;
  readonly after?: string | undefined;
  readonly limit?: string | undefined;
  readonly from?: string | undefined;
  readonly ttl?: string | undefined;
  readonly maxMessages?: string | undefined;
  readonly expiresIn?: string | undefined;
  readonly noDeliver?: boolean | undefined;
  readonly json: boolean;
}

/** Injection seam for tests; production builds default instances per call. */
export interface SessionCommandDeps {
  readonly store?: ControlSessionStore;
  readonly broker?: ControlBroker;
  readonly registry?: ControlAdapterRegistry;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Pseudo-session id recorded as the source of CLI-originated human sends. */
export const DEFAULT_HUMAN_SOURCE = 'human:cli';

/** D-04 grant defaults — bounded by design, never unlimited. */
export const DEFAULT_GRANT_TTL_MS = 15 * 60_000;
export const DEFAULT_GRANT_MAX_MESSAGES = 10;

const VALID_ACTIONS = 'list, inspect, tail, send, grant, revoke';

// ─── Duration parsing ───────────────────────────────────────────────────────

const DURATION_RE = /^(\d+)([smhd])?$/;

/** Parse `30s` / `10m` / `2h` / `1d` / bare milliseconds into positive ms. */
export function parseDurationMs(raw: string): number {
  const match = DURATION_RE.exec(raw.trim());
  if (!match) {
    throw new Error(`invalid duration "${raw}" — use <N>[s|m|h|d] or milliseconds (e.g. 30s, 10m, 2h)`);
  }
  const value = Number.parseInt(match[1]!, 10);
  const unit = match[2];
  const multiplier =
    unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : unit === 'd' ? 86_400_000 : 1;
  const ms = value * multiplier;
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new Error(`invalid duration "${raw}" — must be a positive duration`);
  }
  return ms;
}

// ─── Zod CLI boundary ───────────────────────────────────────────────────────

const idField = z.string().min(1).max(200);

const durationField = z.string().transform((raw, ctx) => {
  try {
    return parseDurationMs(raw);
  } catch (err) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (err as Error).message });
    return z.NEVER;
  }
});

const ListArgsSchema = z
  .object({
    provider: ControlProviderSchema.optional(),
    state: ControlSessionStateSchema.optional(),
  })
  .strict();

const InspectArgsSchema = z.object({ session_id: idField }).strict();

const TailArgsSchema = z
  .object({
    session_id: idField,
    after: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().positive().max(1000).optional(),
  })
  .strict();

const SendArgsSchema = z
  .object({
    target_session_id: idField,
    content: z.string().min(1, 'send requires non-empty <content>').max(MAX_CONTROL_CONTENT_CHARS),
    from: idField.default(DEFAULT_HUMAN_SOURCE),
    expires_in_ms: durationField.optional(),
    deliver: z.boolean().default(true),
  })
  .strict();

const GrantArgsSchema = z
  .object({
    source_session_id: idField,
    target_session_id: idField,
    ttl_ms: durationField.optional(),
    max_messages: z.coerce.number().int().min(1).max(10_000).default(DEFAULT_GRANT_MAX_MESSAGES),
  })
  .strict();

const RevokeArgsSchema = z.object({ grant_id: idField }).strict();

/** Zod gate for CLI args: failure prints the issue list and exits 2. */
function parseArgs<S extends z.ZodTypeAny>(schema: S, input: unknown, io: CliIO): z.output<S> | undefined {
  const result = schema.safeParse(input);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    io.stderr(`relay session: invalid arguments — ${detail}\n`);
    return undefined;
  }
  return result.data as z.output<S>;
}

function notRegistered(kind: 'source' | 'target' | 'session', session_id: string): never {
  throw toRelayException(
    makeError('CONTROL_SESSION_NOT_FOUND', `${kind} session ${session_id} is not registered`, false),
  );
}

// ─── Rendering helpers ──────────────────────────────────────────────────────

function iso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function renderSessionRow(session: ControlSession): string {
  const id = session.session_id.padEnd(38);
  const provider = session.provider.padEnd(12);
  const state = session.state.padEnd(7);
  const caps = session.capabilities.join(',');
  return `${id}  ${c.cyan(provider)}  ${c.yellow(state)}  ${caps}  ${c.dim(iso(session.last_seen_at))}\n`;
}

function renderEventRow(event: ControlEvent): string {
  const route =
    event.source_session_id || event.target_session_id
      ? `${event.source_session_id ?? '-'} -> ${event.target_session_id ?? '-'}`
      : '-';
  return `${String(event.id).padStart(6)}  ${c.dim(iso(event.created_at))}  ${c.cyan(event.event_type.padEnd(20))}  ${route}\n`;
}

// ─── Subcommands ────────────────────────────────────────────────────────────

function runList(options: SessionCommandOptions, store: ControlSessionStore, io: CliIO): number {
  const args = parseArgs(ListArgsSchema, { provider: options.provider, state: options.state }, io);
  if (!args) return 2;
  const sessions = store.listSessions({ provider: args.provider, state: args.state });
  if (options.json) {
    io.stdout(JSON.stringify(sessions) + '\n');
    return 0;
  }
  if (sessions.length === 0) {
    io.stdout('No control sessions registered.\n');
    return 0;
  }
  io.stdout(
    `${c.bold('session_id'.padEnd(38))}  ${c.bold('provider'.padEnd(12))}  ${c.bold('state'.padEnd(7))}  ${c.bold('capabilities')}  ${c.bold('last_seen')}\n`,
  );
  for (const session of sessions) io.stdout(renderSessionRow(session));
  return 0;
}

const INSPECT_EVENT_LIMIT = 20;

function runInspect(options: SessionCommandOptions, store: ControlSessionStore, io: CliIO): number {
  const args = parseArgs(InspectArgsSchema, { session_id: options.positionals[0] }, io);
  if (!args) return 2;
  const session = store.getSession(args.session_id);
  if (!session) notRegistered('session', args.session_id);
  const queued = store.getQueuedMessages(args.session_id);
  const events = store.tailEvents(args.session_id, { limit: 1000 }).slice(-INSPECT_EVENT_LIMIT);
  if (options.json) {
    io.stdout(JSON.stringify({ session, queued_count: queued.length, events }) + '\n');
    return 0;
  }
  io.stdout(`${c.bold(session.session_id)}\n`);
  io.stdout(`  provider:      ${session.provider}\n`);
  io.stdout(`  state:         ${session.state}\n`);
  io.stdout(`  capabilities:  ${session.capabilities.join(', ')}\n`);
  if (session.label) io.stdout(`  label:         ${session.label}\n`);
  if (session.workdir) io.stdout(`  workdir:       ${session.workdir}\n`);
  if (session.pid != null) io.stdout(`  pid:           ${session.pid}\n`);
  io.stdout(`  registered:    ${iso(session.registered_at)}\n`);
  io.stdout(`  last_seen:     ${iso(session.last_seen_at)}\n`);
  io.stdout(`  queued:        ${queued.length} message(s)\n`);
  if (events.length > 0) {
    io.stdout(`  recent events:\n`);
    for (const event of events) io.stdout(`  ${renderEventRow(event)}`);
  }
  return 0;
}

function runTail(options: SessionCommandOptions, store: ControlSessionStore, io: CliIO): number {
  const args = parseArgs(
    TailArgsSchema,
    { session_id: options.positionals[0], after: options.after, limit: options.limit },
    io,
  );
  if (!args) return 2;
  if (!store.getSession(args.session_id)) notRegistered('session', args.session_id);
  const events = store.tailEvents(args.session_id, {
    ...(args.after !== undefined ? { after_id: args.after } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
  });
  if (options.json) {
    io.stdout(JSON.stringify(events) + '\n');
    return 0;
  }
  if (events.length === 0) {
    io.stdout('No events.\n');
    return 0;
  }
  for (const event of events) io.stdout(renderEventRow(event));
  return 0;
}

async function runSend(
  options: SessionCommandOptions,
  store: ControlSessionStore,
  broker: ControlBroker,
  registry: ControlAdapterRegistry,
  io: CliIO,
): Promise<number> {
  const args = parseArgs(
    SendArgsSchema,
    {
      target_session_id: options.positionals[0],
      content: options.positionals.slice(1).join(' ').trim(),
      from: options.from,
      expires_in_ms: options.expiresIn,
      deliver: options.noDeliver ? false : true,
    },
    io,
  );
  if (!args) return 2;

  const now = Date.now();
  const message = broker.sendMessage(
    {
      source_session_id: args.from,
      target_session_id: args.target_session_id,
      sender_kind: 'human',
      content: args.content,
      ...(args.expires_in_ms !== undefined ? { expires_at: now + args.expires_in_ms } : {}),
    },
    now,
  );

  let status: string = message.status;
  let deliveryCapability: string | undefined;
  let deliveryDetail: string | undefined;
  if (args.deliver) {
    try {
      const reports = await registry.deliverQueued(args.target_session_id, now);
      const mine = reports.find((r) => r.message_id === message.message_id);
      if (mine) {
        status = mine.ok ? 'delivered' : 'failed';
        deliveryCapability = mine.capability;
        deliveryDetail = mine.detail;
      }
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'PROVIDER_NOT_CONFIGURED' || code === 'CONTROL_DELIVERY_UNSUPPORTED') {
        // No adapter (or no shared delivery capability) for this provider in
        // this process — the message honestly waits in the mailbox (D-01).
        deliveryDetail = (err as Error).message;
      } else {
        throw err;
      }
    }
  }

  if (options.json) {
    io.stdout(
      JSON.stringify({
        message_id: message.message_id,
        target_session_id: message.target_session_id,
        status,
        redaction: message.redaction,
        ...(deliveryCapability !== undefined ? { delivery_capability: deliveryCapability } : {}),
        ...(deliveryDetail !== undefined ? { delivery_detail: deliveryDetail } : {}),
      }) + '\n',
    );
  } else if (status === 'failed') {
    io.stderr(
      `relay session: delivery failed for ${message.message_id}: ${deliveryDetail ?? 'unknown failure'}\n`,
    );
  } else {
    const via = deliveryCapability !== undefined ? ` via ${deliveryCapability}` : '';
    io.stdout(`${status}${via}: ${message.message_id} -> ${message.target_session_id}\n`);
  }
  return status === 'failed' ? 1 : 0;
}

function runGrant(options: SessionCommandOptions, store: ControlSessionStore, io: CliIO): number {
  const args = parseArgs(
    GrantArgsSchema,
    {
      source_session_id: options.positionals[0],
      target_session_id: options.positionals[1],
      ttl_ms: options.ttl,
      max_messages: options.maxMessages,
    },
    io,
  );
  if (!args) return 2;
  if (!store.getSession(args.source_session_id)) notRegistered('source', args.source_session_id);
  if (!store.getSession(args.target_session_id)) notRegistered('target', args.target_session_id);

  const ttl_ms = args.ttl_ms ?? DEFAULT_GRANT_TTL_MS;
  const now = Date.now();
  const txn = getDb().transaction(() => {
    const grant = store.grant(
      {
        source_session_id: args.source_session_id,
        target_session_id: args.target_session_id,
        ttl_ms,
        max_messages: args.max_messages,
      },
      now,
    );
    store.appendEvent(
      {
        session_id: grant.source_session_id,
        event_type: 'grant_issued',
        source_session_id: grant.source_session_id,
        target_session_id: grant.target_session_id,
        payload: {
          grant_id: grant.grant_id,
          max_messages: grant.max_messages,
          expires_at: grant.expires_at,
        },
      },
      now,
    );
    return grant;
  });
  const grant = txn();

  if (options.json) {
    io.stdout(JSON.stringify(grant) + '\n');
  } else {
    io.stdout(
      `granted ${grant.grant_id}: ${grant.source_session_id} -> ${grant.target_session_id} ` +
        `(${grant.max_messages} messages, expires ${iso(grant.expires_at)})\n`,
    );
  }
  return 0;
}

function runRevoke(options: SessionCommandOptions, store: ControlSessionStore, io: CliIO): number {
  const args = parseArgs(RevokeArgsSchema, { grant_id: options.positionals[0] }, io);
  if (!args) return 2;
  const now = Date.now();
  const txn = getDb().transaction(() => {
    const grant = store.revoke(args.grant_id, now);
    store.appendEvent(
      {
        session_id: grant.source_session_id,
        event_type: 'grant_revoked',
        source_session_id: grant.source_session_id,
        target_session_id: grant.target_session_id,
        payload: { grant_id: grant.grant_id },
      },
      now,
    );
    return grant;
  });
  const grant = txn();

  if (options.json) {
    io.stdout(JSON.stringify(grant) + '\n');
  } else {
    io.stdout(`revoked ${grant.grant_id} (${grant.source_session_id} -> ${grant.target_session_id})\n`);
  }
  return 0;
}

// ─── Entry point ────────────────────────────────────────────────────────────

export async function executeSessionCommand(
  options: SessionCommandOptions,
  io: CliIO,
  deps: SessionCommandDeps = {},
): Promise<number> {
  const store = deps.store ?? new ControlSessionStore();
  const broker = deps.broker ?? new ControlBroker(store);
  const registry = deps.registry ?? new ControlAdapterRegistry(store, broker);

  try {
    switch (options.action) {
      case 'list':
        return runList(options, store, io);
      case 'inspect':
        return runInspect(options, store, io);
      case 'tail':
        return runTail(options, store, io);
      case 'send':
        return await runSend(options, store, broker, registry, io);
      case 'grant':
        return runGrant(options, store, io);
      case 'revoke':
        return runRevoke(options, store, io);
      default:
        io.stderr(`relay session: unknown action '${options.action}'. Try: ${VALID_ACTIONS}\n`);
        return 2;
    }
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) {
      io.stderr(`relay session: ${code}: ${(err as Error).message}\n`);
      return 1;
    }
    throw err;
  }
}
