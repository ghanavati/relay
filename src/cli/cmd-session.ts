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
  type ControlGrant,
  type ControlMessage,
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

const VALID_ACTIONS = 'list, inspect, tail, send, delegate, grant, revoke, pause, resume';

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

const DelegateArgsSchema = z
  .object({
    target_session_id: idField,
    task: z.string().min(1, 'delegate requires a non-empty <task>').max(MAX_CONTROL_CONTENT_CHARS),
    from: idField.default(DEFAULT_HUMAN_SOURCE),
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

function runInspect(options: SessionCommandOptions, deps: SessionActionDeps, io: CliIO): number {
  const args = parseArgs(InspectArgsSchema, { session_id: options.positionals[0] }, io);
  if (!args) return 2;
  const { session, queued_count, events } = inspectSession(deps, args.session_id);
  if (options.json) {
    io.stdout(JSON.stringify({ session, queued_count, events }) + '\n');
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
  io.stdout(`  queued:        ${queued_count} message(s)\n`);
  if (events.length > 0) {
    io.stdout(`  recent events:\n`);
    for (const event of events) io.stdout(`  ${renderEventRow(event)}`);
  }
  return 0;
}

function runTail(options: SessionCommandOptions, deps: SessionActionDeps, io: CliIO): number {
  const args = parseArgs(
    TailArgsSchema,
    { session_id: options.positionals[0], after: options.after, limit: options.limit },
    io,
  );
  if (!args) return 2;
  const events = tailSession(deps, args.session_id, {
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

/** Shared send/delegate output shaping: JSON contract + human lines + exit code. */
function emitSendResult(result: SendActionResult, options: SessionCommandOptions, io: CliIO): number {
  const { message, status, delivery_capability, delivery_detail } = result;
  if (options.json) {
    io.stdout(
      JSON.stringify({
        message_id: message.message_id,
        target_session_id: message.target_session_id,
        status,
        redaction: message.redaction,
        ...(delivery_capability !== undefined ? { delivery_capability } : {}),
        ...(delivery_detail !== undefined ? { delivery_detail } : {}),
      }) + '\n',
    );
  } else if (status === 'failed') {
    io.stderr(
      `relay session: delivery failed for ${message.message_id}: ${delivery_detail ?? 'unknown failure'}\n`,
    );
  } else {
    const via = delivery_capability !== undefined ? ` via ${delivery_capability}` : '';
    io.stdout(`${status}${via}: ${message.message_id} -> ${message.target_session_id}\n`);
  }
  return status === 'failed' ? 1 : 0;
}

async function runSend(
  options: SessionCommandOptions,
  deps: SessionActionDeps,
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
  const result = await sendToSession(deps, {
    target_session_id: args.target_session_id,
    content: args.content,
    from: args.from,
    ...(args.expires_in_ms !== undefined ? { expires_in_ms: args.expires_in_ms } : {}),
    deliver: args.deliver,
  });
  return emitSendResult(result, options, io);
}

async function runDelegate(
  options: SessionCommandOptions,
  deps: SessionActionDeps,
  io: CliIO,
): Promise<number> {
  const args = parseArgs(
    DelegateArgsSchema,
    {
      target_session_id: options.positionals[0],
      task: options.positionals.slice(1).join(' ').trim(),
      from: options.from,
      deliver: options.noDeliver ? false : true,
    },
    io,
  );
  if (!args) return 2;
  const result = await delegateToSession(deps, {
    target_session_id: args.target_session_id,
    task: args.task,
    from: args.from,
    deliver: args.deliver,
  });
  return emitSendResult(result, options, io);
}

function runPauseResume(
  action: 'pause' | 'resume',
  options: SessionCommandOptions,
  deps: SessionActionDeps,
  io: CliIO,
): number {
  const args = parseArgs(InspectArgsSchema, { session_id: options.positionals[0] }, io);
  if (!args) return 2;
  const session =
    action === 'pause'
      ? deps.broker.pauseSession(args.session_id)
      : deps.broker.resumeSession(args.session_id);
  if (options.json) {
    io.stdout(JSON.stringify(session) + '\n');
  } else {
    io.stdout(`${action}d ${session.session_id} (state: ${session.state})\n`);
  }
  return 0;
}

function runGrant(options: SessionCommandOptions, deps: SessionActionDeps, io: CliIO): number {
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
  const grant = issueGrant(deps, {
    source_session_id: args.source_session_id,
    target_session_id: args.target_session_id,
    ...(args.ttl_ms !== undefined ? { ttl_ms: args.ttl_ms } : {}),
    max_messages: args.max_messages,
  });

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

function runRevoke(options: SessionCommandOptions, deps: SessionActionDeps, io: CliIO): number {
  const args = parseArgs(RevokeArgsSchema, { grant_id: options.positionals[0] }, io);
  if (!args) return 2;
  const grant = revokeGrant(deps, args.grant_id);

  if (options.json) {
    io.stdout(JSON.stringify(grant) + '\n');
  } else {
    io.stdout(`revoked ${grant.grant_id} (${grant.source_session_id} -> ${grant.target_session_id})\n`);
  }
  return 0;
}

// ─── Shared session actions (08-07 Task 1, D-13) ────────────────────────────
//
// One implementation per operator action, used by BOTH the `relay session ...`
// CLI subcommands and the Command Central palette (cmd-tui.ts). Same broker
// methods, same policy checks, same audit events, same RelayError codes —
// the UI never grows a parallel control implementation.

/** Fully-resolved dependency set for shared session actions. */
export interface SessionActionDeps {
  readonly store: ControlSessionStore;
  readonly broker: ControlBroker;
  readonly registry: ControlAdapterRegistry;
}

export interface InspectResult {
  readonly session: ControlSession;
  readonly queued_count: number;
  readonly events: readonly ControlEvent[];
}

export interface SendActionInput {
  readonly target_session_id: string;
  readonly content: string;
  readonly from?: string | undefined;
  readonly expires_in_ms?: number | undefined;
  readonly deliver?: boolean | undefined;
}

export interface DelegateActionInput {
  readonly target_session_id: string;
  readonly task: string;
  readonly from?: string | undefined;
  readonly deliver?: boolean | undefined;
}

export interface SendActionResult {
  readonly message: ControlMessage;
  readonly status: string;
  readonly delivery_capability?: string | undefined;
  readonly delivery_detail?: string | undefined;
}

export interface GrantActionInput {
  readonly source_session_id: string;
  readonly target_session_id: string;
  readonly ttl_ms?: number | undefined;
  readonly max_messages?: number | undefined;
}

/** Session record + queued count + recent events (CLI inspect = palette inspect). */
export function inspectSession(deps: SessionActionDeps, session_id: string): InspectResult {
  const session = deps.store.getSession(session_id);
  if (!session) notRegistered('session', session_id);
  const queued = deps.store.getQueuedMessages(session_id);
  const events = deps.store.tailEvents(session_id, { limit: 1000 }).slice(-INSPECT_EVENT_LIMIT);
  return Object.freeze({ session, queued_count: queued.length, events: Object.freeze(events) });
}

/** Bounded event tail for one session (CLI tail = palette tail). */
export function tailSession(
  deps: SessionActionDeps,
  session_id: string,
  opts?: { readonly after_id?: number | undefined; readonly limit?: number | undefined },
): ControlEvent[] {
  if (!deps.store.getSession(session_id)) notRegistered('session', session_id);
  return deps.store.tailEvents(session_id, {
    ...(opts?.after_id !== undefined ? { after_id: opts.after_id } : {}),
    ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
  });
}

/**
 * Best-effort adapter delivery for one freshly queued message. Missing
 * adapters (or no shared delivery capability in this process) leave the
 * message honestly queued (D-01); real adapter failures mark it failed.
 */
async function attemptDelivery(
  deps: SessionActionDeps,
  message: ControlMessage,
  deliver: boolean,
  now: number,
): Promise<SendActionResult> {
  let status: string = message.status;
  let delivery_capability: string | undefined;
  let delivery_detail: string | undefined;
  if (deliver) {
    try {
      const reports = await deps.registry.deliverQueued(message.target_session_id, now);
      const mine = reports.find((r) => r.message_id === message.message_id);
      if (mine) {
        status = mine.ok ? 'delivered' : 'failed';
        delivery_capability = mine.capability;
        delivery_detail = mine.detail;
      }
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'PROVIDER_NOT_CONFIGURED' || code === 'CONTROL_DELIVERY_UNSUPPORTED') {
        // No adapter (or no shared delivery capability) for this provider in
        // this process — the message honestly waits in the mailbox (D-01).
        delivery_detail = (err as Error).message;
      } else {
        throw err;
      }
    }
  }
  return Object.freeze({
    message,
    status,
    ...(delivery_capability !== undefined ? { delivery_capability } : {}),
    ...(delivery_detail !== undefined ? { delivery_detail } : {}),
  });
}

/** Brokered human send + best-effort adapter delivery (CLI send = palette send). */
export async function sendToSession(
  deps: SessionActionDeps,
  input: SendActionInput,
  now: number = Date.now(),
): Promise<SendActionResult> {
  const message = deps.broker.sendMessage(
    {
      source_session_id: input.from ?? DEFAULT_HUMAN_SOURCE,
      target_session_id: input.target_session_id,
      sender_kind: 'human',
      content: input.content,
      ...(input.expires_in_ms !== undefined ? { expires_at: now + input.expires_in_ms } : {}),
    },
    now,
  );
  return attemptDelivery(deps, message, input.deliver ?? true, now);
}

/** Brokered task delegation — target must declare tool_call (D-01). */
export async function delegateToSession(
  deps: SessionActionDeps,
  input: DelegateActionInput,
  now: number = Date.now(),
): Promise<SendActionResult> {
  const message = deps.broker.delegateTask(
    {
      source_session_id: input.from ?? DEFAULT_HUMAN_SOURCE,
      target_session_id: input.target_session_id,
      sender_kind: 'human',
      task: input.task,
    },
    now,
  );
  return attemptDelivery(deps, message, input.deliver ?? true, now);
}

/** Issue a TTL-bound, budgeted grant + grant_issued audit event, atomically. */
export function issueGrant(
  deps: SessionActionDeps,
  input: GrantActionInput,
  now: number = Date.now(),
): ControlGrant {
  if (!deps.store.getSession(input.source_session_id)) {
    notRegistered('source', input.source_session_id);
  }
  if (!deps.store.getSession(input.target_session_id)) {
    notRegistered('target', input.target_session_id);
  }
  const txn = getDb().transaction(() => {
    const grant = deps.store.grant(
      {
        source_session_id: input.source_session_id,
        target_session_id: input.target_session_id,
        ttl_ms: input.ttl_ms ?? DEFAULT_GRANT_TTL_MS,
        max_messages: input.max_messages ?? DEFAULT_GRANT_MAX_MESSAGES,
      },
      now,
    );
    deps.store.appendEvent(
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
  return txn();
}

/** Revoke a grant + grant_revoked audit event, atomically. */
export function revokeGrant(
  deps: SessionActionDeps,
  grant_id: string,
  now: number = Date.now(),
): ControlGrant {
  const txn = getDb().transaction(() => {
    const grant = deps.store.revoke(grant_id, now);
    deps.store.appendEvent(
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
  return txn();
}

// ─── Command palette (08-07 Task 1, D-13/D-15) ──────────────────────────────

/** Result of one palette command — frozen, UI renders it verbatim. */
export type PaletteResult =
  | { readonly ok: true; readonly message: string; readonly select_session_id?: string | undefined }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface PaletteContext {
  readonly deps?: SessionCommandDeps | undefined;
  readonly selected_session_id?: string | undefined;
  readonly now?: number | undefined;
}

/** Palette verbs, in hint order. */
const PALETTE_ACTIONS = [
  'send',
  'delegate',
  'inspect',
  'tail',
  'grant',
  'revoke',
  'pause',
  'resume',
] as const;

/** Usage lines for the palette commands (hints + error guidance). */
export const PALETTE_USAGE: readonly string[] = Object.freeze([
  'send <session> <message…>',
  'delegate <session> <task…>',
  'inspect [session]',
  'tail [session]',
  'grant <source> <target> [ttl] [max]',
  'revoke <grant_id>',
  'pause [session]',
  'resume [session]',
]);

/** Tokenize one palette line into action + args. Unknown verbs are rejected. */
export function parsePaletteCommand(
  line: string,
):
  | { readonly ok: true; readonly action: string; readonly args: readonly string[] }
  | { readonly ok: false; readonly error: string } {
  const tokens = line.trim().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return Object.freeze({ ok: false as const, error: `usage: ${PALETTE_USAGE.join(' · ')}` });
  }
  const action = tokens[0]!.toLowerCase();
  if (!(PALETTE_ACTIONS as readonly string[]).includes(action)) {
    return Object.freeze({
      ok: false as const,
      error: `unknown command "${tokens[0]}" — try: ${PALETTE_ACTIONS.join(', ')}`,
    });
  }
  return Object.freeze({ ok: true as const, action, args: Object.freeze(tokens.slice(1)) });
}

function paletteInvalid(message: string): never {
  throw toRelayException(makeError('INVALID_ARGS', message, false));
}

function paletteOk(message: string, select_session_id?: string): PaletteResult {
  return Object.freeze({
    ok: true as const,
    message,
    ...(select_session_id !== undefined ? { select_session_id } : {}),
  });
}

/** Resolve `[session]` palette args against the rail selection. */
function sessionArgOrSelected(args: readonly string[], ctx: PaletteContext): string {
  const id = args[0] ?? ctx.selected_session_id;
  if (id === undefined || id === '') {
    paletteInvalid('a session id is required (no session selected)');
  }
  return id;
}

async function dispatchPaletteAction(
  action: string,
  args: readonly string[],
  deps: SessionActionDeps,
  ctx: PaletteContext,
  now: number,
): Promise<PaletteResult> {
  switch (action) {
    case 'send': {
      const target = args[0];
      const content = args.slice(1).join(' ').trim();
      if (target === undefined || content === '') {
        paletteInvalid('usage: send <session> <message…>');
      }
      const result = await sendToSession(deps, { target_session_id: target, content }, now);
      const via = result.delivery_capability !== undefined ? ` via ${result.delivery_capability}` : '';
      return paletteOk(`${result.status}${via}: ${result.message.message_id} -> ${target}`);
    }
    case 'delegate': {
      const target = args[0];
      const task = args.slice(1).join(' ').trim();
      if (target === undefined || task === '') {
        paletteInvalid('usage: delegate <session> <task…>');
      }
      const result = await delegateToSession(deps, { target_session_id: target, task }, now);
      return paletteOk(`delegated (${result.status}): ${result.message.message_id} -> ${target}`);
    }
    case 'inspect': {
      const id = sessionArgOrSelected(args, ctx);
      const result = inspectSession(deps, id);
      return paletteOk(
        `${id} · ${result.session.provider} · ${result.session.state} · ` +
          `${result.queued_count} queued · ${result.session.capabilities.join(',')}`,
        id,
      );
    }
    case 'tail': {
      const id = sessionArgOrSelected(args, ctx);
      const events = tailSession(deps, id);
      const last = events.at(-1)?.event_type ?? 'none';
      return paletteOk(`${events.length} event(s) for ${id} (last: ${last})`, id);
    }
    case 'grant': {
      const [source, target, ttlRaw, maxRaw] = args;
      if (source === undefined || target === undefined) {
        paletteInvalid('usage: grant <source> <target> [ttl] [max]');
      }
      let ttl_ms: number | undefined;
      if (ttlRaw !== undefined) {
        try {
          ttl_ms = parseDurationMs(ttlRaw);
        } catch (err) {
          paletteInvalid((err as Error).message);
        }
      }
      const max_messages = maxRaw !== undefined ? Number.parseInt(maxRaw, 10) : undefined;
      const grant = issueGrant(
        deps,
        {
          source_session_id: source,
          target_session_id: target,
          ...(ttl_ms !== undefined ? { ttl_ms } : {}),
          ...(max_messages !== undefined ? { max_messages } : {}),
        },
        now,
      );
      return paletteOk(
        `granted ${grant.grant_id}: ${source} -> ${target} (${grant.max_messages} msgs)`,
      );
    }
    case 'revoke': {
      const grant_id = args[0];
      if (grant_id === undefined) paletteInvalid('usage: revoke <grant_id>');
      const grant = revokeGrant(deps, grant_id, now);
      return paletteOk(`revoked ${grant.grant_id} (${grant.source_session_id} -> ${grant.target_session_id})`);
    }
    case 'pause': {
      const id = sessionArgOrSelected(args, ctx);
      const session = deps.broker.pauseSession(id, now);
      return paletteOk(`paused ${id} (state: ${session.state})`, id);
    }
    case 'resume': {
      const id = sessionArgOrSelected(args, ctx);
      const session = deps.broker.resumeSession(id, now);
      return paletteOk(`resumed ${id} (state: ${session.state})`, id);
    }
    default:
      paletteInvalid(`unknown command "${action}" — try: ${PALETTE_ACTIONS.join(', ')}`);
  }
}

/**
 * Execute one palette command through the SAME shared action functions the
 * CLI uses (D-13). RelayError denials surface as `{ ok:false, code, message }`
 * results — never silent degradation, never UI-local state mutation.
 */
export async function executePaletteCommand(
  line: string,
  ctx: PaletteContext = {},
): Promise<PaletteResult> {
  const parsed = parsePaletteCommand(line);
  if (!parsed.ok) {
    return Object.freeze({ ok: false as const, code: 'INVALID_ARGS', message: parsed.error });
  }
  const store = ctx.deps?.store ?? new ControlSessionStore();
  const broker = ctx.deps?.broker ?? new ControlBroker(store);
  const registry = ctx.deps?.registry ?? new ControlAdapterRegistry(store, broker);
  const deps: SessionActionDeps = { store, broker, registry };
  const now = ctx.now ?? Date.now();
  try {
    return await dispatchPaletteAction(parsed.action, parsed.args, deps, ctx, now);
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return Object.freeze({
      ok: false as const,
      code: typeof code === 'string' && code.length > 0 ? code : 'ERROR',
      message: (err as Error).message,
    });
  }
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
  const actionDeps: SessionActionDeps = { store, broker, registry };

  try {
    switch (options.action) {
      case 'list':
        return runList(options, store, io);
      case 'inspect':
        return runInspect(options, actionDeps, io);
      case 'tail':
        return runTail(options, actionDeps, io);
      case 'send':
        return await runSend(options, actionDeps, io);
      case 'delegate':
        return await runDelegate(options, actionDeps, io);
      case 'grant':
        return runGrant(options, actionDeps, io);
      case 'revoke':
        return runRevoke(options, actionDeps, io);
      case 'pause':
      case 'resume':
        return runPauseResume(options.action, options, actionDeps, io);
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
