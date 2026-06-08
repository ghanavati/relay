/**
 * `relay tui` — Command Central: terminal-native operator console (Ink).
 *
 * Herdr-inspired layout over the shared ControlSnapshot read model (D-11,
 * D-12, D-15, CONTROL-11/12/17):
 *   - Left:   session rail with state badges (ACT/IDL/END), blocked flags,
 *             and queued-message rollups.
 *   - Main:   selected session pane — capability badges + bounded event tail.
 *   - Right:  inbox/grants/pending-actions queue.
 *   - Bottom: audit strip, control status rollup, legacy health line, hints.
 *
 * Auto-refreshes every 5 seconds (one bounded gather per tick). Key bindings:
 *   q | Ctrl-C → quit · r → refresh · j/k or ↑/↓ → select session
 *
 * `--json` emits ONE bounded snapshot of the same data (no Ink, no refresh
 * loop) and exits — the machine-readable Command Central state contract.
 * Legacy health fields (status, recent_activity, recall_preview) stay
 * top-level for scripts; the shared control read model lives under `control`.
 *
 * Uses `React.createElement` (no JSX) to avoid adding JSX support to tsconfig.
 * Layout content is computed by the PURE buildCommandCentralView, so render
 * shape is testable without a TTY or provider network calls.
 */

import type { CliIO } from './commands.js';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseLogLines } from './cmd-memory-tail.js';
import { probeCodex, probeLmStudio, probeEnvKey } from './probes.js';
import {
  emptyControlSnapshot,
  gatherControlSnapshot,
  type ControlSnapshot,
} from '../control/read-model.js';
import type {
  ControlCapability,
  ControlEvent,
  ControlGrant,
  ControlMessage,
  ControlSessionState,
} from '../control/types.js';

// Command Central palette — same shared action functions as `relay session ...`
// (D-13). Defined next to the session command surface; re-exported here so the
// TUI module is the single import point for Command Central behavior.
import { executePaletteCommand, type PaletteResult } from './cmd-session.js';
export { executePaletteCommand, parsePaletteCommand, PALETTE_USAGE } from './cmd-session.js';
export type { PaletteContext, PaletteResult } from './cmd-session.js';

export interface TuiArgs {
  json: boolean;
  cwd: string;
  version: string;
}

interface ActivityEntry {
  ts: number;
  event: string;
  ok?: boolean | undefined;
}

interface MemoryPreview {
  memory_id: string;
  memory_type: string;
  content: string;
  score: number;
  tags: readonly string[];
}

interface Snapshot {
  version: string;
  generated_at: number;
  recent_activity: ActivityEntry[];
  recall_preview: MemoryPreview[];
  /** Shared Command Central read model (D-12) — same shape as `relay tui --json` emits. */
  control: ControlSnapshot;
  status: {
    binary_version: string;
    db_path: string;
    db_entries: number;
    hook_installed: boolean;
    providers: Array<{ name: string; status: string }>;
  };
}

// ─── Command Central view model (pure — render-shape tested without Ink) ────

/** Pane layout flips to stacked below this terminal width. */
export const NARROW_WIDTH = 110;

/** Display caps per pane — the snapshot is already bounded; these keep the
 * terminal scannable (Herdr-style rollups instead of scrollback walls). */
export const PANE_ROWS = Object.freeze({
  events: 12,
  inbox: 6,
  grants: 4,
  pending: 4,
  audit: 4,
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

/**
 * Herdr-inspired Command Central view: left session rail, main selected
 * session pane, right inbox/grants/pending queue, bottom audit/status strip
 * and command hints. Pure data — the Ink components only map it to Text.
 */
export interface CommandCentralView {
  readonly narrow: boolean;
  readonly rail: readonly RailRow[];
  readonly rail_empty: string | null;
  readonly main: {
    readonly header: string;
    readonly badges: string;
    readonly events: readonly string[];
    readonly empty: string | null;
  };
  readonly inbox: readonly string[];
  readonly grants: readonly string[];
  readonly pending: readonly string[];
  readonly audit: readonly string[];
  readonly status: string;
  readonly hints: string;
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

/** Compact relative time for a non-negative millisecond delta. */
function formatAgoMs(delta: number): string {
  const d = Math.max(0, delta);
  if (d < 60_000) return `${Math.max(1, Math.round(d / 1000))}s`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h`;
  return `${Math.round(d / 86_400_000)}d`;
}

function shortId(id: string): string {
  return id.length > 10 ? id.slice(0, 10) : id;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

function formatEventLine(event: ControlEvent, now: number): string {
  const ago = formatAgoMs(now - event.created_at).padStart(4);
  const arrow =
    event.source_session_id !== null && event.target_session_id !== null
      ? ` ${shortId(event.source_session_id)}→${shortId(event.target_session_id)}`
      : '';
  return `${ago} ${event.event_type}${arrow}`;
}

function formatInboxLine(message: ControlMessage, now: number): string {
  const kind = message.sender_kind === 'human' ? 'h' : 'l';
  const preview = truncate(message.content.replace(/\s+/g, ' '), 24);
  return (
    `[${kind}] ${shortId(message.source_session_id)}→${shortId(message.target_session_id)}` +
    ` ${formatAgoMs(now - message.created_at)} "${preview}"`
  );
}

function formatGrantLine(grant: ControlGrant, now: number): string {
  return (
    `${shortId(grant.source_session_id)}→${shortId(grant.target_session_id)}` +
    ` ${grant.used_messages}/${grant.max_messages} ttl ${formatAgoMs(grant.expires_at - now)}`
  );
}

function formatPendingLine(event: ControlEvent, now: number): string {
  const requestId =
    typeof event.payload['request_id'] === 'string' ? event.payload['request_id'] : '(no id)';
  const action = typeof event.payload['action'] === 'string' ? ` ${event.payload['action']}` : '';
  // Approval-window expiry (broker requestGrant payload, D-14): mark stale
  // requests so the operator knows approve will refuse them.
  const expires = event.payload['expires_at'];
  const expired = typeof expires === 'number' && expires <= now ? ' exp!' : '';
  return `${formatAgoMs(now - event.created_at)} ${requestId}${action}${expired} @${shortId(event.session_id)}`;
}

/** Build the Command Central view model from the shared ControlSnapshot. */
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

  const rail = control.sessions.map(
    (session): RailRow =>
      Object.freeze({
        session_id: session.session_id,
        badge: STATE_BADGES[session.state],
        blocked: blockedSessions.has(session.session_id),
        provider: session.provider,
        title: truncate(session.label ?? session.session_id, 20),
        queued: queuedByTarget.get(session.session_id) ?? 0,
        selected: session.session_id === selectedId,
      }),
  );

  const selected = control.selected_session;
  // control.events is the chronological newest-N tail; keep the TAIL end
  // when display-capping so the newest events stay visible.
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
    main,
    inbox: Object.freeze(
      control.inbox.slice(0, PANE_ROWS.inbox).map((message) => formatInboxLine(message, now)),
    ),
    grants: Object.freeze(
      control.grants.slice(0, PANE_ROWS.grants).map((grant) => formatGrantLine(grant, now)),
    ),
    pending: Object.freeze(
      control.pending_actions
        .slice(0, PANE_ROWS.pending)
        .map((event) => formatPendingLine(event, now)),
    ),
    audit: Object.freeze(
      control.audit.slice(0, PANE_ROWS.audit).map((event) => formatEventLine(event, now)),
    ),
    status,
    hints: 'q quit · r refresh · j/k or ↑/↓ select session · : command palette',
  });
}

/** Resolve the ndjson activity-log path the same way `relay memory tail` does. */
function resolveLogPath(): string {
  const env = process.env['RELAY_LOG_PATH'];
  if (env) return env;
  return join(homedir(), '.relay', 'relay.ndjson');
}

/** Read the last N entries of the relay activity log. Returns [] if missing. */
async function readRecentActivity(limit: number): Promise<ActivityEntry[]> {
  try {
    const raw = await readFile(resolveLogPath(), 'utf-8');
    const all = parseLogLines(raw);
    return all
      .slice(-limit)
      .reverse()
      .map((e) => ({ ts: e.ts, event: e.event, ok: typeof e.ok === 'boolean' ? e.ok : undefined }));
  } catch {
    return [];
  }
}

/** Top-N memory recall for current cwd, recency-weighted (no query). */
async function readRecallPreview(workdir: string, limit: number): Promise<MemoryPreview[]> {
  try {
    const { MemoryStore } = await import('../memory/memory-store.js');
    const { budgetedRecall } = await import('../memory/memory-engine.js');
    const { computeSemanticSimilarities } = await import('../memory/semantic-similarities.js');
    const store = new MemoryStore();
    const query = { query: undefined, tags: [], token_budget: 4000, workdir } as Parameters<typeof budgetedRecall>[1];
    const candidates = store.getCandidates(query);
    // PLAN-4 T6 — Compute semantic similarities at impure boundary BEFORE scoring.
    // Empty Map (returned when query.query is undefined or RELAY_EMBEDDING_MODEL unset)
    // makes the engine fall through to word-overlap. Never throws.
    const similarities = await computeSemanticSimilarities(store, query, candidates);
    const result = budgetedRecall(candidates, query, Date.now(), similarities);
    return result.memories.slice(0, limit).map((m) => ({
      memory_id: m.memory_id,
      memory_type: m.memory_type,
      content: m.content,
      score: Math.round(m.score * 1000) / 1000,
      tags: m.tags,
    }));
  } catch {
    return [];
  }
}

/** Resolve display DB path the same way `relay info` does. */
function resolveDbPath(): string {
  return process.env['RELAY_DB_PATH']
    ? process.env['RELAY_DB_PATH']
    : '~/.relay/relay.db';
}

/** Best-effort row count of the memories table. 0 if DB unreachable. */
async function readDbEntries(): Promise<number> {
  try {
    const { MemoryStore } = await import('../memory/memory-store.js');
    return new MemoryStore().count();
  } catch {
    return 0;
  }
}

/** Best-effort: is any SessionStart hook command containing the literal `relay ` installed in ~/.claude/settings.json? */
async function readHookInstalled(): Promise<boolean> {
  try {
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    const text = await readFile(settingsPath, 'utf-8');
    const json = JSON.parse(text) as { hooks?: { SessionStart?: unknown } };
    const events = json.hooks?.SessionStart;
    if (!Array.isArray(events)) return false;
    for (const entry of events as Array<{ hooks?: Array<{ command?: unknown }> }>) {
      const inner = Array.isArray(entry.hooks) ? entry.hooks : [];
      for (const h of inner) {
        if (typeof h.command === 'string' && /\brelay\b/.test(h.command)) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Bounded Command Central read model (D-12) — reads through the shared
 * gatherControlSnapshot, never its own SQL. Falls back to the empty snapshot
 * when the control store is unreachable so the legacy panes stay usable.
 */
function readControlSnapshot(selected_session_id?: string): ControlSnapshot {
  try {
    return gatherControlSnapshot(
      selected_session_id === undefined ? {} : { selected_session_id },
    );
  } catch {
    return emptyControlSnapshot();
  }
}

// ─── Async resilience for Command Central (CONTROL-16, D-15) ────────────────

/** Provider probes are network calls — bound them so a hung backend never
 *  freezes the render path; a timed-out probe degrades to offline. */
export const PROVIDER_PROBE_TIMEOUT_MS = 2500;

/** Fast control-snapshot cadence (cheap synchronous DB read — keeps the live
 *  event stream fresh). */
export const CONTROL_REFRESH_MS = 1000;

/** Slow full-snapshot cadence (provider probes + legacy health). */
export const FULL_REFRESH_MS = 5000;

/**
 * Resolve `p`, but fall back to `fallback` if it does not settle within `ms`.
 * Never rejects — a hung or failing probe degrades to the fallback instead of
 * blocking Command Central. The pending timer is always cleared so it cannot
 * keep the event loop alive after the race resolves.
 */
export async function withTimeout<T>(_p: Promise<T>, _ms: number, _fallback: T): Promise<T> {
  // STUB (08-08 RED).
  throw new Error('withTimeout not implemented (08-08)');
}

/** Drops results from a refresh older than the latest one started, so a slow
 *  gather can never clobber a newer snapshot (stale-refresh cancellation). */
export interface RefreshSequencer {
  /** Start a new refresh; returns its monotonically increasing token. */
  begin(): number;
  /** True only for the most recently started refresh token. */
  isCurrent(token: number): boolean;
}

export function createRefreshSequencer(): RefreshSequencer {
  // STUB (08-08 RED).
  throw new Error('createRefreshSequencer not implemented (08-08)');
}

/**
 * Gather one full snapshot — pure data, no rendering. Used by both `--json` mode
 * and the Ink renderer (which polls this on the slow cadence).
 *
 * Exported for tests.
 */
export async function gatherSnapshot(args: {
  cwd: string;
  version: string;
  selected_session_id?: string;
}): Promise<Snapshot> {
  const [activity, preview, dbEntries, hookInstalled, codex, lmstudio] = await Promise.all([
    readRecentActivity(10),
    readRecallPreview(args.cwd, 5),
    readDbEntries(),
    readHookInstalled(),
    probeCodex(),
    probeLmStudio(),
  ]);
  const openrouter = probeEnvKey('OPENROUTER_API_KEY', 'openrouter');
  const anthropic = probeEnvKey('ANTHROPIC_API_KEY', 'anthropic');

  return {
    version: args.version,
    generated_at: Date.now(),
    recent_activity: activity,
    recall_preview: preview,
    control: readControlSnapshot(args.selected_session_id),
    status: {
      binary_version: args.version,
      db_path: resolveDbPath(),
      db_entries: dbEntries,
      hook_installed: hookInstalled,
      providers: [
        { name: 'codex', status: codex.status },
        { name: 'lm-studio', status: lmstudio.status },
        { name: 'openrouter', status: openrouter.status },
        { name: 'anthropic', status: anthropic.status },
      ],
    },
  };
}

/**
 * Render the Command Central Ink layout. Imported lazily so the `--json`
 * path doesn't pay the Ink/React load cost (and so we can avoid Ink under
 * CI). All pane CONTENT comes from buildCommandCentralView — components
 * here only map the view model to Boxes and Texts.
 */
async function renderInk(args: TuiArgs): Promise<number> {
  // Lazy imports — Ink + React are only loaded when the interactive UI runs.
  const React = await import('react');
  const { render, Box, Text, useInput, useApp } = await import('ink');
  const ce = React.createElement;
  const { useState, useEffect, useCallback } = React;

  function badgeColor(badge: RailRow['badge']): string {
    return badge === 'ACT' ? 'green' : badge === 'IDL' ? 'yellow' : 'gray';
  }

  /** Left rail — session roster with state badges and queue rollups. */
  function RailPane(props: { view: CommandCentralView }): React.ReactElement {
    const { rail, rail_empty, narrow } = props.view;
    const rows =
      rail.length === 0
        ? [ce(Text, { key: 'empty', dimColor: true }, rail_empty ?? 'no sessions')]
        : rail.map((row) =>
            ce(
              Box,
              { key: row.session_id, flexDirection: 'row' },
              ce(Text, { color: 'cyan' }, row.selected ? '▸ ' : '  '),
              ce(Text, { color: badgeColor(row.badge), bold: row.selected }, row.badge),
              ce(Text, { color: 'red' }, row.blocked ? '!' : ' '),
              ce(Text, { color: 'blue' }, ` ${row.provider.padEnd(11)}`),
              ce(Text, { bold: row.selected }, row.title),
              row.queued > 0 ? ce(Text, { color: 'magenta' }, ` ✉${row.queued}`) : null,
            ),
          );
    return ce(
      Box,
      {
        flexDirection: 'column',
        borderStyle: 'round',
        borderColor: 'gray',
        paddingX: 1,
        width: narrow ? undefined : 40,
      },
      ce(Text, { bold: true }, 'Sessions'),
      ...rows,
    );
  }

  /** Main pane — selected session header, capability badges, event tail. */
  function MainPane(props: { view: CommandCentralView }): React.ReactElement {
    const { main } = props.view;
    const body: React.ReactNode[] = [];
    if (main.header !== '') {
      body.push(ce(Text, { key: 'header', bold: true, color: 'cyan' }, main.header));
      body.push(ce(Text, { key: 'badges', dimColor: true }, main.badges));
    }
    if (main.empty !== null) {
      body.push(ce(Text, { key: 'empty', dimColor: true }, main.empty));
    }
    main.events.forEach((line, i) =>
      body.push(ce(Text, { key: `ev-${i}`, color: 'gray' }, line)),
    );
    return ce(
      Box,
      { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', paddingX: 1, flexGrow: 1 },
      ce(Text, { bold: true }, 'Selected session'),
      ...body,
    );
  }

  /** Right pane — queued inbox, active grants, pending control actions. */
  function QueuePane(props: { view: CommandCentralView }): React.ReactElement {
    const { inbox, grants, pending, narrow } = props.view;
    const section = (
      title: string,
      lines: readonly string[],
      emptyText: string,
      keyPrefix: string,
    ): React.ReactNode[] => [
      ce(Text, { key: `${keyPrefix}-title`, bold: true }, title),
      ...(lines.length === 0
        ? [ce(Text, { key: `${keyPrefix}-empty`, dimColor: true }, emptyText)]
        : lines.map((line, i) => ce(Text, { key: `${keyPrefix}-${i}`, color: 'gray' }, line))),
    ];
    return ce(
      Box,
      {
        flexDirection: 'column',
        borderStyle: 'round',
        borderColor: 'gray',
        paddingX: 1,
        width: narrow ? undefined : 46,
      },
      ...section('Inbox (queued)', inbox, 'empty', 'inbox'),
      ...section('Grants', grants, 'none active', 'grants'),
      ...section('Pending actions', pending, 'none', 'pending'),
    );
  }

  /** Bottom strip — audit tail, control rollup, legacy health, hints. */
  function BottomStrip(props: {
    view: CommandCentralView;
    snapshot: Snapshot;
    lastRefreshMs: number;
  }): React.ReactElement {
    const s = props.snapshot.status;
    const providers = s.providers.map((p) => `${p.name}=${p.status}`).join('  ');
    const auditLines =
      props.view.audit.length === 0
        ? [ce(Text, { key: 'audit-empty', dimColor: true }, 'no audit events yet')]
        : props.view.audit.map((line, i) =>
            ce(Text, { key: `audit-${i}`, color: 'gray' }, line),
          );
    return ce(
      Box,
      { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', paddingX: 1 },
      ce(Text, { bold: true }, 'Audit'),
      ...auditLines,
      ce(Text, { color: 'yellow' }, props.view.status),
      ce(
        Box,
        { flexDirection: 'row' },
        ce(Text, { bold: true }, `relay v${s.binary_version}  `),
        ce(Text, { color: 'gray' }, `db=${s.db_path} (${s.db_entries})  `),
        ce(
          Text,
          { color: s.hook_installed ? 'green' : 'gray' },
          `hook=${s.hook_installed ? 'installed' : 'missing'}  `,
        ),
        ce(Text, { color: 'gray' }, providers),
      ),
      ce(
        Text,
        { dimColor: true },
        `${props.view.hints} · last refresh ${formatAgoMs(Date.now() - props.lastRefreshMs)} ago`,
      ),
    );
  }

  function App(): React.ReactElement {
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
    const [lastRefresh, setLastRefresh] = useState<number>(Date.now());
    const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
    const [palette, setPaletteState] = useState<{ open: boolean; input: string }>({
      open: false,
      input: '',
    });
    const [paletteResult, setPaletteResult] = useState<PaletteResult | null>(null);
    const { exit } = useApp();

    const refresh = useCallback(async (sel: string | undefined) => {
      const snap = await gatherSnapshot({
        cwd: args.cwd,
        version: args.version,
        ...(sel !== undefined ? { selected_session_id: sel } : {}),
      });
      setSnapshot(snap);
      setLastRefresh(Date.now());
    }, []);

    useEffect(() => {
      void refresh(selectedId);
      const id = setInterval(() => { void refresh(selectedId); }, 5000);
      return () => clearInterval(id);
    }, [refresh, selectedId]);

    // Palette commands mutate ONLY through the shared broker/session-command
    // path (D-13); the store stays the source of truth — after every command
    // we re-gather the snapshot instead of patching UI state.
    const runPaletteLine = useCallback(
      async (line: string, sel: string | undefined) => {
        const result = await executePaletteCommand(line, {
          ...(sel !== undefined ? { selected_session_id: sel } : {}),
        });
        setPaletteResult(result);
        const nextSel =
          result.ok && result.select_session_id !== undefined ? result.select_session_id : sel;
        if (result.ok && result.select_session_id !== undefined) {
          setSelectedId(result.select_session_id);
        }
        await refresh(nextSel);
      },
      [refresh],
    );

    useInput((input, key) => {
      if (palette.open) {
        if (key.return) {
          const line = palette.input;
          setPaletteState({ open: false, input: '' });
          if (line.trim() !== '') {
            void runPaletteLine(
              line,
              selectedId ?? snapshot?.control.selected_session?.session_id,
            );
          }
          return;
        }
        if (key.escape) {
          setPaletteState({ open: false, input: '' });
          return;
        }
        if (key.backspace || key.delete) {
          setPaletteState((p) => ({ open: true, input: p.input.slice(0, -1) }));
          return;
        }
        if (input !== '' && !key.ctrl && !key.meta) {
          setPaletteState((p) => ({ open: true, input: p.input + input }));
        }
        return;
      }
      if (input === ':') {
        setPaletteState({ open: true, input: '' });
        setPaletteResult(null);
        return;
      }
      if (input === 'q' || (key.ctrl && input === 'c')) exit();
      if (input === 'r') void refresh(selectedId);
      const down = input === 'j' || key.downArrow;
      const up = input === 'k' || key.upArrow;
      if (snapshot !== null && (down || up)) {
        const ids = snapshot.control.sessions.map((s) => s.session_id);
        if (ids.length === 0) return;
        const current = snapshot.control.selected_session?.session_id;
        const idx = current === undefined ? -1 : ids.indexOf(current);
        const nextIdx = Math.min(
          Math.max(idx === -1 ? 0 : idx + (down ? 1 : -1), 0),
          ids.length - 1,
        );
        const next = ids[nextIdx];
        if (next !== undefined && next !== current) setSelectedId(next);
      }
    });

    if (!snapshot) {
      return ce(Box, { padding: 1 }, ce(Text, null, 'Loading Command Central...'));
    }

    const view = buildCommandCentralView(snapshot.control, {
      width: process.stdout.columns ?? 120,
    });
    const panes = [
      ce(RailPane, { key: 'rail', view }),
      ce(MainPane, { key: 'main', view }),
      ce(QueuePane, { key: 'queue', view }),
    ];
    const paletteLine = palette.open
      ? ce(Text, { key: 'palette', color: 'cyan' }, `: ${palette.input}▌`)
      : paletteResult !== null
        ? ce(
            Text,
            { key: 'palette-result', color: paletteResult.ok ? 'green' : 'red' },
            paletteResult.ok
              ? `ok · ${paletteResult.message}`
              : `${paletteResult.code}: ${paletteResult.message}`,
          )
        : null;
    return ce(
      Box,
      { flexDirection: 'column' },
      ce(Box, { flexDirection: view.narrow ? 'column' : 'row' }, ...panes),
      ce(BottomStrip, { view, snapshot, lastRefreshMs: lastRefresh }),
      paletteLine,
    );
  }

  const instance = render(ce(App));
  await instance.waitUntilExit();
  return 0;
}

/**
 * Entry point — `relay tui [--json]`.
 *
 * In `--json` mode we render a single Snapshot to stdout and exit immediately,
 * which is what CI / scripting / test suites should use. Ink is only loaded
 * for the interactive path so we don't pay the React tax on non-TTY runs.
 */
export async function executeTuiCommand(args: TuiArgs, io: CliIO): Promise<number> {
  if (args.json) {
    const snap = await gatherSnapshot({ cwd: args.cwd, version: args.version });
    io.stdout(JSON.stringify(snap) + '\n');
    return 0;
  }
  if (!process.stdout.isTTY) {
    io.stderr('relay tui requires an interactive TTY. Use --json for scripting.\n');
    return 2;
  }
  return renderInk(args);
}
