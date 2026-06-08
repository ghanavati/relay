/**
 * Command Central view model (Phase 8 / Plan 08 — maintainer-directed re-layout).
 *
 * PURE data layer for `relay tui` (D-12/D-15). The Ink renderer in cmd-tui.ts
 * only maps this model to Boxes/Texts, so the operator-console shape is testable
 * without a TTY or provider network calls.
 *
 * Option A layout (replaces the prior 3-column + audit-box shape):
 *   - LEFT column, split top/bottom:
 *       top    = "Sessions" roster (state badge, provider, title, ✉queued, ▸sel).
 *       bottom = "Queue" — inbox + grants + pending-actions merged into one
 *                operational list (exp! markers on stale pending requests).
 *   - RIGHT (the centerpiece) = selected session: header + capability badges +
 *       the LIVE event stream. Model-op visibility events render here with
 *       human/llm source badges and pending/approved/denied/executed state;
 *       blocked/audit events fold into this stream (no separate audit box).
 *   - BOTTOM = a single status+hints strip (rollup + health + palette hints +
 *       "live Ns" freshness), rendered by cmd-tui.ts.
 */
import {
  classifyEventDisposition,
  classifyEventSource,
  type ControlEventDisposition,
  type ControlEventSource,
  type ControlSnapshot,
} from '../control/read-model.js';
import type {
  ControlCapability,
  ControlEvent,
  ControlEventType,
  ControlGrant,
  ControlMessage,
  ControlSessionState,
} from '../control/types.js';

/** Pane layout flips to stacked below this terminal width. */
export const NARROW_WIDTH = 110;

/**
 * Display caps per pane — the snapshot is already bounded; these keep the
 * terminal scannable (Herdr-style rollups instead of scrollback walls). The
 * right-side event stream is the centerpiece, so it shows the most rows.
 */
export const PANE_ROWS = Object.freeze({
  events: 14,
  inbox: 5,
  grants: 4,
  pending: 5,
});

/** One left-rail row: state badge + provider + queue rollup (D-15). */
export interface RailRow {
  readonly session_id: string;
  readonly badge: 'ACT' | 'IDL' | 'END';
  readonly blocked: boolean;
  readonly provider: string;
  readonly title: string;
  readonly queued: number;
  readonly selected: boolean;
}

/** One merged operational-queue row (inbox + grants + pending in one list). */
export interface QueueRow {
  readonly kind: 'inbox' | 'grant' | 'pending';
  readonly text: string;
  /** True only for an expired pending control request (operator must re-issue). */
  readonly expired: boolean;
}

/** One live-stream row with the source + lifecycle badges (Part 1 visibility). */
export interface EventLine {
  /** Compact relative age, e.g. "12s". */
  readonly time: string;
  /** Who drove the event — human, llm, or relay-internal (system). */
  readonly source: ControlEventSource;
  /** Escalation lifecycle state, or null for plain events. */
  readonly disposition: ControlEventDisposition;
  /** Compact label + source→target arrow, e.g. "enqueued cc→qwen". */
  readonly text: string;
}

/**
 * Command Central view model. Pure data — the Ink components map it to Text.
 */
export interface CommandCentralView {
  readonly narrow: boolean;
  readonly rail: readonly RailRow[];
  readonly rail_empty: string | null;
  readonly queue: readonly QueueRow[];
  readonly queue_empty: string | null;
  readonly main: {
    readonly header: string;
    readonly badges: string;
    readonly events: readonly EventLine[];
    readonly empty: string | null;
  };
  readonly status: string;
  readonly hints: string;
}

/** Compact relative time for a non-negative millisecond delta. */
export function formatAgoMs(delta: number): string {
  const d = Math.max(0, delta);
  if (d < 60_000) return `${Math.max(1, Math.round(d / 1000))}s`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h`;
  return `${Math.round(d / 86_400_000)}d`;
}

const STATE_BADGES: Record<ControlSessionState, RailRow['badge']> = {
  active: 'ACT',
  idle: 'IDL',
  ended: 'END',
};

/** Compact per-capability codes — badges over verbose text (D-15). */
const CAPABILITY_BADGES: Record<ControlCapability, string> = {
  register: 'reg',
  observe: 'obs',
  tail: 'tail',
  context_inject: 'inj',
  mailbox: 'mbx',
  resume_send: 'res',
  live_stdin: 'stdin',
  interrupt: 'int',
  fork: 'fork',
  spawn: 'spawn',
  tool_call: 'tool',
};

/** Compact operator-facing labels for the live stream (D-15). */
const EVENT_LABELS: Partial<Record<ControlEventType, string>> = {
  session_registered: 'registered',
  session_updated: 'updated',
  session_ended: 'ended',
  message_enqueued: 'enqueued',
  message_blocked: 'blocked',
  message_delivered: 'delivered',
  message_acknowledged: 'acked',
  message_failed: 'failed',
  message_expired: 'expired',
  grant_issued: 'grant',
  grant_revoked: 'revoked',
  delivery_attempted: 'attempt',
  control_requested: 'request',
  control_approved: 'approved',
  control_denied: 'denied',
  control_executed: 'executed',
};

function shortId(id: string): string {
  return id.length > 10 ? id.slice(0, 10) : id;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

/** A pending control request whose approval window has elapsed (broker D-14). */
function isPendingExpired(event: ControlEvent, now: number): boolean {
  const expires = event.payload['expires_at'];
  return typeof expires === 'number' && expires <= now;
}

function formatInboxLine(message: ControlMessage, now: number): string {
  const kind = message.sender_kind === 'human' ? 'h' : 'l';
  const preview = truncate(message.content.replace(/\s+/g, ' '), 20);
  return (
    `✉[${kind}] ${shortId(message.source_session_id)}→${shortId(message.target_session_id)}` +
    ` ${formatAgoMs(now - message.created_at)} "${preview}"`
  );
}

function formatGrantLine(grant: ControlGrant, now: number): string {
  return (
    `grant ${shortId(grant.source_session_id)}→${shortId(grant.target_session_id)}` +
    ` ${grant.used_messages}/${grant.max_messages} ttl ${formatAgoMs(grant.expires_at - now)}`
  );
}

function formatPendingLine(event: ControlEvent, now: number): string {
  const requestId =
    typeof event.payload['request_id'] === 'string' ? event.payload['request_id'] : '(no id)';
  const action = typeof event.payload['action'] === 'string' ? ` ${event.payload['action']}` : '';
  const expired = isPendingExpired(event, now) ? ' exp!' : '';
  return `pend ${requestId}${action} @${shortId(event.session_id)}${expired}`;
}

/** Build one live-stream EventLine: compact label + arrow + source/disposition. */
function formatEventLine(event: ControlEvent, now: number): EventLine {
  const arrow =
    event.source_session_id !== null && event.target_session_id !== null
      ? `${shortId(event.source_session_id)}→${shortId(event.target_session_id)}`
      : '';
  const label = EVENT_LABELS[event.event_type] ?? event.event_type;
  return Object.freeze({
    time: formatAgoMs(now - event.created_at),
    source: classifyEventSource(event),
    disposition: classifyEventDisposition(event),
    text: arrow ? `${label} ${arrow}` : label,
  });
}

/**
 * Build the Option A Command Central view from the shared ControlSnapshot.
 */
export function buildCommandCentralView(
  control: ControlSnapshot,
  opts: { width: number },
): CommandCentralView {
  const now = control.generated_at;
  const selectedId = control.selected_session?.session_id;

  const queuedByTarget = new Map<string, number>();
  for (const message of control.inbox) {
    queuedByTarget.set(
      message.target_session_id,
      (queuedByTarget.get(message.target_session_id) ?? 0) + 1,
    );
  }
  // message_blocked events are source-anchored (broker D-05) — the flagged
  // session is the denied actor.
  const blockedSessions = new Set(control.blocked.map((event) => event.session_id));

  // ── Top-left: Sessions roster ──────────────────────────────────────────────
  const rail = control.sessions.map(
    (session): RailRow =>
      Object.freeze({
        session_id: session.session_id,
        badge: STATE_BADGES[session.state],
        blocked: blockedSessions.has(session.session_id),
        provider: session.provider,
        title: truncate(session.label ?? session.session_id, 18),
        queued: queuedByTarget.get(session.session_id) ?? 0,
        selected: session.session_id === selectedId,
      }),
  );

  // ── Bottom-left: merged operational Queue (inbox + grants + pending) ────────
  const queue: QueueRow[] = [
    ...control.inbox.slice(0, PANE_ROWS.inbox).map(
      (message): QueueRow =>
        Object.freeze({ kind: 'inbox' as const, text: formatInboxLine(message, now), expired: false }),
    ),
    ...control.grants.slice(0, PANE_ROWS.grants).map(
      (grant): QueueRow =>
        Object.freeze({ kind: 'grant' as const, text: formatGrantLine(grant, now), expired: false }),
    ),
    ...control.pending_actions.slice(0, PANE_ROWS.pending).map(
      (event): QueueRow =>
        Object.freeze({
          kind: 'pending' as const,
          text: formatPendingLine(event, now),
          expired: isPendingExpired(event, now),
        }),
    ),
  ];

  // ── Right (centerpiece): selected session live stream ───────────────────────
  // control.events is the chronological newest-N tail; keep the TAIL when
  // display-capping so the freshest events stay visible (newest at the bottom).
  const selected = control.selected_session;
  const eventLines =
    selected === null
      ? []
      : control.events.slice(-PANE_ROWS.events).map((event) => formatEventLine(event, now));
  const main = Object.freeze({
    header:
      selected === null
        ? ''
        : `${truncate(selected.session_id, 40)} · ${selected.provider} · ` +
          `${STATE_BADGES[selected.state]}${blockedSessions.has(selected.session_id) ? ' !BLK' : ''}`,
    badges:
      selected === null
        ? ''
        : selected.capabilities.map((capability) => CAPABILITY_BADGES[capability]).join(' '),
    events: Object.freeze(eventLines),
    empty:
      selected === null
        ? 'no session selected — sessions appear here once adapters register'
        : eventLines.length === 0
          ? 'no events yet for this session'
          : null,
  });

  // ── Bottom strip rollup ─────────────────────────────────────────────────────
  const activeCount = control.sessions.filter((s) => s.state === 'active').length;
  const budgetUsed = control.grants.reduce((sum, g) => sum + g.used_messages, 0);
  const budgetMax = control.grants.reduce((sum, g) => sum + g.max_messages, 0);
  const status =
    `sessions ${control.sessions.length} (${activeCount} act) · inbox ${control.inbox.length}` +
    ` · blocked ${control.blocked.length} · pending ${control.pending_actions.length}` +
    ` · grants ${control.grants.length} (budget ${budgetUsed}/${budgetMax})`;

  return Object.freeze({
    narrow: opts.width < NARROW_WIDTH,
    rail: Object.freeze(rail),
    rail_empty:
      rail.length === 0 ? 'no sessions registered — waiting for adapters to register' : null,
    queue: Object.freeze(queue),
    queue_empty: queue.length === 0 ? 'no inbox, grants, or pending requests' : null,
    main,
    status,
    hints: ': palette (send · grant · tail · pause) · j/k select · q quit',
  });
}
