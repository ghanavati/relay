/**
 * Shared ControlSnapshot read model (Phase 8 / Plan 06 / Task 1).
 *
 * D-12 — Command Central (`relay tui`) and `relay tui --json` consume THIS
 * read model. UI code must not add independent SQL paths: every read here
 * goes through ControlSessionStore helpers with explicit limits, and the
 * snapshot is immutable (frozen object, frozen collections, frozen items).
 *
 * CONTROL-11 — the snapshot carries the operator-console working set:
 * session roster, selected session, bounded event tail, queued inbox,
 * active grants, pending model-driven control actions (D-14 lifecycle),
 * recent blocked events, recent audit items, and provider status rollups.
 */
import { ControlSessionStore } from './session-store.js';
import type {
  ControlEvent,
  ControlGrant,
  ControlMessage,
  ControlProvider,
  ControlSession,
} from './types.js';

// ─── Snapshot shapes ────────────────────────────────────────────────────────

/** Per-provider session rollup (counts by lifecycle state). */
export interface ProviderStatusSummary {
  readonly provider: ControlProvider;
  readonly total: number;
  readonly active: number;
  readonly idle: number;
  readonly ended: number;
}

/** Explicit bounds for every store read — no unbounded SELECTs (D-12). */
export interface ControlSnapshotLimits {
  /** Max sessions in the roster. */
  readonly sessions: number;
  /** Max events in the selected-session tail. */
  readonly events: number;
  /** Max queued messages in the inbox pane. */
  readonly inbox: number;
  /** Max active grants listed. */
  readonly grants: number;
  /** Max recent message_blocked events. */
  readonly blocked: number;
  /** Max recent audit events. */
  readonly audit: number;
  /** Max D-14 lifecycle events scanned to resolve pending actions. */
  readonly pending_scan: number;
}

export const DEFAULT_CONTROL_SNAPSHOT_LIMITS: ControlSnapshotLimits = Object.freeze({
  sessions: 50,
  events: 50,
  inbox: 50,
  grants: 25,
  blocked: 20,
  audit: 50,
  pending_scan: 200,
});

/**
 * Immutable Command Central read model. Ordering contracts:
 *   sessions        — last_seen_at DESC (most recently seen first).
 *   events          — selected-session tail, newest N in CHRONOLOGICAL order.
 *   inbox           — queued unexpired messages, oldest first (delivery order).
 *   grants          — active (non-revoked, unexpired) grants, newest first.
 *   pending_actions — unresolved control_requested events, newest first.
 *   blocked         — recent message_blocked events, newest first.
 *   audit           — recent events of any type, newest first.
 *   providers       — rollups sorted by provider name ASC.
 */
export interface ControlSnapshot {
  readonly generated_at: number;
  readonly sessions: readonly ControlSession[];
  readonly selected_session: ControlSession | null;
  readonly events: readonly ControlEvent[];
  readonly inbox: readonly ControlMessage[];
  readonly grants: readonly ControlGrant[];
  readonly pending_actions: readonly ControlEvent[];
  readonly blocked: readonly ControlEvent[];
  readonly audit: readonly ControlEvent[];
  readonly providers: readonly ProviderStatusSummary[];
}

export interface GatherControlSnapshotOptions {
  /** Store to read through (defaults to a fresh ControlSessionStore). */
  readonly store?: ControlSessionStore;
  /** Session to focus; defaults to the most recently seen session. */
  readonly selected_session_id?: string;
  /** Clock override for deterministic reads. */
  readonly now?: number;
  /** Per-pane bound overrides; unspecified panes use the defaults. */
  readonly limits?: Partial<ControlSnapshotLimits>;
}

// ─── Event source / disposition classification (D-14, D-15) ─────────────────

/** Who triggered a control event, for the Command Central source badge. */
export type ControlEventSource = 'human' | 'llm' | 'system';

/**
 * Lifecycle disposition of a control/escalation event, for the operator-visible
 * pending → approved/denied → executed states (D-14). `null` for plain events
 * that carry no escalation lifecycle.
 */
export type ControlEventDisposition = 'pending' | 'approved' | 'denied' | 'executed' | null;

/**
 * Classify the actor behind an event from its payload: model-driven operations
 * stamp `actor_kind`/`sender_kind` ('llm'|'human'); approvals/denials stamp
 * `approved_by_kind`/`denied_by_kind`. Relay-internal lifecycle events (session
 * registered/updated/ended, grant issued) have no actor marker → 'system'.
 */
export function classifyEventSource(event: ControlEvent): ControlEventSource {
  const p = event.payload;
  // Precedence: the direct actor marker, then the message sender, then the
  // approval/denial actor kind. Only 'human'/'llm' are trusted; anything else
  // (missing, or a hand-edited junk value) is relay-internal → 'system'.
  const marker =
    p['actor_kind'] ?? p['sender_kind'] ?? p['approved_by_kind'] ?? p['denied_by_kind'];
  return marker === 'human' || marker === 'llm' ? marker : 'system';
}

/** Map an event type to its operator-visible escalation disposition (D-14). */
export function classifyEventDisposition(event: ControlEvent): ControlEventDisposition {
  switch (event.event_type) {
    case 'control_requested':
      return 'pending';
    case 'control_approved':
      return 'approved';
    case 'control_executed':
      return 'executed';
    case 'control_denied':
    case 'message_blocked':
      return 'denied';
    default:
      return null;
  }
}

// ─── Read model ─────────────────────────────────────────────────────────────

interface SnapshotParts {
  generated_at: number;
  sessions: ControlSession[];
  selected_session: ControlSession | null;
  events: ControlEvent[];
  inbox: ControlMessage[];
  grants: ControlGrant[];
  pending_actions: ControlEvent[];
  blocked: ControlEvent[];
  audit: ControlEvent[];
  providers: ProviderStatusSummary[];
}

/** Freeze the snapshot and every collection. Items are already frozen. */
function freezeSnapshot(parts: SnapshotParts): ControlSnapshot {
  return Object.freeze({
    generated_at: parts.generated_at,
    sessions: Object.freeze(parts.sessions),
    selected_session: parts.selected_session,
    events: Object.freeze(parts.events),
    inbox: Object.freeze(parts.inbox),
    grants: Object.freeze(parts.grants),
    pending_actions: Object.freeze(parts.pending_actions),
    blocked: Object.freeze(parts.blocked),
    audit: Object.freeze(parts.audit),
    providers: Object.freeze(parts.providers),
  });
}

/** Well-defined zero state — used when the control store is unreachable. */
export function emptyControlSnapshot(now: number = Date.now()): ControlSnapshot {
  return freezeSnapshot({
    generated_at: now,
    sessions: [],
    selected_session: null,
    events: [],
    inbox: [],
    grants: [],
    pending_actions: [],
    blocked: [],
    audit: [],
    providers: [],
  });
}

/**
 * D-14 pending actions: `control_requested` events with no `control_approved`
 * / `control_denied` / `control_executed` event naming the same
 * `payload.request_id` inside the bounded scan window. Requested events
 * WITHOUT a request_id can never be matched — they stay visible for operator
 * attention until they age out of the scan window.
 */
function resolvePendingActions(store: ControlSessionStore, scanLimit: number): ControlEvent[] {
  const lifecycle = store.listRecentEvents({
    event_types: ['control_requested', 'control_approved', 'control_denied', 'control_executed'],
    limit: scanLimit,
  });
  const resolved = new Set<string>();
  for (const event of lifecycle) {
    if (event.event_type === 'control_requested') continue;
    const requestId = event.payload['request_id'];
    if (typeof requestId === 'string') resolved.add(requestId);
  }
  return lifecycle.filter((event) => {
    if (event.event_type !== 'control_requested') return false;
    const requestId = event.payload['request_id'];
    return typeof requestId !== 'string' || !resolved.has(requestId);
  });
}

/** Fold the bounded provider/state aggregate into per-provider rollups. */
function summarizeProviders(store: ControlSessionStore): ProviderStatusSummary[] {
  const byProvider = new Map<
    ControlProvider,
    { total: number; active: number; idle: number; ended: number }
  >();
  for (const row of store.countSessionsByProviderState()) {
    const entry = byProvider.get(row.provider) ?? { total: 0, active: 0, idle: 0, ended: 0 };
    entry.total += row.count;
    entry[row.state] += row.count;
    byProvider.set(row.provider, entry);
  }
  return [...byProvider.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([provider, counts]) => Object.freeze({ provider, ...counts }));
}

/** Gather one bounded, immutable ControlSnapshot through store helpers. */
export function gatherControlSnapshot(opts: GatherControlSnapshotOptions = {}): ControlSnapshot {
  const store = opts.store ?? new ControlSessionStore();
  const now = opts.now ?? Date.now();
  const limits: ControlSnapshotLimits = { ...DEFAULT_CONTROL_SNAPSHOT_LIMITS, ...opts.limits };

  const sessions = store.listSessions({ limit: limits.sessions });

  let selected: ControlSession | null;
  if (opts.selected_session_id !== undefined) {
    // Resolve outside the bounded roster too — a selected session must not
    // disappear just because newer sessions pushed it past the roster limit.
    selected =
      sessions.find((s) => s.session_id === opts.selected_session_id) ??
      store.getSession(opts.selected_session_id) ??
      null;
  } else {
    selected = sessions[0] ?? null;
  }

  // Newest N events fetched DESC, then reversed (fresh array) so the pane
  // reads chronologically like a terminal transcript.
  const events =
    selected === null
      ? []
      : store
          .listRecentEvents({ session_id: selected.session_id, limit: limits.events })
          .reverse();

  return freezeSnapshot({
    generated_at: now,
    sessions,
    selected_session: selected,
    events,
    inbox: store.listQueuedMessages({ now, limit: limits.inbox }),
    grants: store.listGrants({ active_at: now, limit: limits.grants }),
    pending_actions: resolvePendingActions(store, limits.pending_scan),
    blocked: store.listRecentEvents({ event_types: ['message_blocked'], limit: limits.blocked }),
    audit: store.listRecentEvents({ limit: limits.audit }),
    providers: summarizeProviders(store),
  });
}
