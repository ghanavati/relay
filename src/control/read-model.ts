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

// ─── Read model ─────────────────────────────────────────────────────────────

/** Well-defined zero state — used when the control store is unreachable. */
export function emptyControlSnapshot(now: number = Date.now()): ControlSnapshot {
  throw new Error(`not implemented (RED) — emptyControlSnapshot(${now})`);
}

/** Gather one bounded, immutable ControlSnapshot through store helpers. */
export function gatherControlSnapshot(opts: GatherControlSnapshotOptions = {}): ControlSnapshot {
  throw new Error(`not implemented (RED) — gatherControlSnapshot(${Object.keys(opts).join(',')})`);
}
