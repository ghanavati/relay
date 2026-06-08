/**
 * `relay tui` — Command Central: terminal-native operator console (Ink).
 *
 * Option A layout (maintainer-directed re-layout, D-11/D-12/D-15) over the
 * shared ControlSnapshot read model:
 *   - LEFT column, split top/bottom:
 *       Sessions = roster with state badges (ACT/IDL/END), provider, title,
 *                  ✉queued rollup, ▸selection.
 *       Queue    = inbox + grants + pending-actions merged into one operational
 *                  list (exp! markers on stale pending requests).
 *   - RIGHT (the centerpiece) = selected session: header + capability badges +
 *       the LIVE event stream. Model-driven operations render here with
 *       human/llm source badges and pending/approved/denied/executed state;
 *       blocked/audit events fold into this stream (no separate audit box).
 *   - BOTTOM = a single status+hints strip (rollup + health + palette hints +
 *       "live Ns" freshness).
 *
 * The control snapshot refreshes fast (CONTROL_REFRESH_MS) so the stream stays
 * live; provider probes ride a slow cadence (FULL_REFRESH_MS) and are
 * timeout-bounded so an offline backend never blocks the UI (CONTROL-16).
 *
 * `--json` emits ONE bounded snapshot of the same data (no Ink, no refresh
 * loop) and exits — the machine-readable Command Central state contract.
 * Legacy health fields (status, recent_activity, recall_preview) stay
 * top-level for scripts; the shared control read model lives under `control`.
 *
 * Uses `React.createElement` (no JSX) to avoid adding JSX support to tsconfig.
 * Layout content is computed by the PURE buildCommandCentralView (extracted to
 * command-central-view.ts), so render shape is testable without a TTY or
 * provider network calls.
 */

import type { CliIO } from './commands.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseLogLines } from './cmd-memory-tail.js';
import { probeCodex, probeLmStudio, probeEnvKey } from './probes.js';
import {
  emptyControlSnapshot,
  gatherControlSnapshot,
  type ControlSnapshot,
} from '../control/read-model.js';
import {
  buildCommandCentralView,
  formatAgoMs,
  NARROW_WIDTH,
  PANE_ROWS,
  type CommandCentralView,
  type EventLine,
  type QueueRow,
  type RailRow,
} from './command-central-view.js';
// Re-exported so cmd-tui.ts stays the single Command Central entry point.
export { buildCommandCentralView, NARROW_WIDTH, PANE_ROWS };
export type { CommandCentralView, RailRow, QueueRow, EventLine };

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
export async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    // p.catch degrades a rejection to the fallback; the timeout degrades a hang.
    return await Promise.race([p.catch(() => fallback), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
  let latest = 0;
  return {
    begin: () => (latest += 1),
    isCurrent: (token: number) => token === latest,
  };
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
  // Provider probes are network calls — bound them so a hung/offline backend
  // degrades to offline instead of blocking Command Central (CONTROL-16).
  const [activity, preview, dbEntries, hookInstalled, codex, lmstudio] = await Promise.all([
    readRecentActivity(10),
    readRecallPreview(args.cwd, 5),
    readDbEntries(),
    readHookInstalled(),
    withTimeout(probeCodex(), PROVIDER_PROBE_TIMEOUT_MS, {
      name: 'codex',
      status: 'failed',
      detail: 'probe timed out',
    }),
    withTimeout(probeLmStudio(), PROVIDER_PROBE_TIMEOUT_MS, {
      name: 'lmstudio',
      status: 'failed',
      detail: 'probe timed out',
    }),
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
  const { useState, useEffect, useCallback, useRef } = React;

  function badgeColor(badge: RailRow['badge']): string {
    return badge === 'ACT' ? 'green' : badge === 'IDL' ? 'yellow' : 'gray';
  }

  /** Event-stream source badge: human vs llm vs relay-internal (D-15). */
  const SOURCE_BADGE: Record<EventLine['source'], string> = {
    human: 'h',
    llm: 'l',
    system: '·',
  };
  function sourceColor(source: EventLine['source']): string {
    return source === 'human' ? 'cyan' : source === 'llm' ? 'magenta' : 'gray';
  }
  function dispositionColor(disposition: NonNullable<EventLine['disposition']>): string {
    return disposition === 'denied' ? 'red' : disposition === 'pending' ? 'yellow' : 'green';
  }
  function queueColor(kind: QueueRow['kind'], expired: boolean): string {
    if (expired) return 'red';
    return kind === 'inbox' ? 'magenta' : kind === 'grant' ? 'blue' : 'yellow';
  }

  /** Top-left — Sessions roster with state badges and queue rollups. */
  function RailPane(props: { view: CommandCentralView }): React.ReactElement {
    const { rail, rail_empty } = props.view;
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
              ce(Text, { color: 'blue' }, ` ${row.provider.padEnd(10)}`),
              ce(Text, { bold: row.selected }, row.title),
              row.queued > 0 ? ce(Text, { color: 'magenta' }, ` ✉${row.queued}`) : null,
            ),
          );
    return ce(
      Box,
      { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', paddingX: 1 },
      ce(Text, { bold: true }, 'Sessions'),
      ...rows,
    );
  }

  /** Bottom-left — merged operational Queue (inbox + grants + pending). */
  function QueuePane(props: { view: CommandCentralView }): React.ReactElement {
    const { queue, queue_empty } = props.view;
    const rows =
      queue.length === 0
        ? [ce(Text, { key: 'q-empty', dimColor: true }, queue_empty ?? 'empty')]
        : queue.map((row, i) =>
            ce(Text, { key: `q-${i}`, color: queueColor(row.kind, row.expired) }, row.text),
          );
    return ce(
      Box,
      { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', paddingX: 1 },
      ce(Text, { bold: true }, 'Queue'),
      ...rows,
    );
  }

  /** Right (centerpiece) — selected session header, capability badges, and the
   *  live event stream with source + disposition badges. */
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
      body.push(
        ce(
          Box,
          { key: `ev-${i}`, flexDirection: 'row' },
          ce(Text, { color: 'gray' }, `${line.time.padStart(4)} `),
          ce(Text, { color: sourceColor(line.source) }, `${SOURCE_BADGE[line.source]} `),
          ce(Text, null, line.text),
          line.disposition !== null
            ? ce(Text, { color: dispositionColor(line.disposition) }, ` ‹${line.disposition}›`)
            : null,
        ),
      ),
    );
    return ce(
      Box,
      { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', paddingX: 1, flexGrow: 1 },
      ce(Text, { bold: true }, 'Live'),
      ...body,
    );
  }

  /** Single bottom status+hints strip (no separate audit box). Health comes
   *  from the slow snapshot; until it lands the panes are already live. */
  function StatusStrip(props: {
    view: CommandCentralView;
    snapshot: Snapshot | null;
    lastRefreshMs: number;
  }): React.ReactElement {
    const s = props.snapshot?.status;
    const health =
      s === undefined
        ? 'probing providers…'
        : `relay v${s.binary_version} · db=${s.db_path} (${s.db_entries}) · ` +
          `hook=${s.hook_installed ? 'on' : 'off'} · ` +
          s.providers.map((p) => `${p.name}=${p.status}`).join(' ');
    return ce(
      Box,
      { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', paddingX: 1 },
      ce(Text, { color: 'yellow' }, props.view.status),
      ce(Text, { dimColor: true }, health),
      ce(
        Text,
        { dimColor: true },
        `${props.view.hints} · live ${formatAgoMs(Date.now() - props.lastRefreshMs)}`,
      ),
    );
  }

  function App(): React.ReactElement {
    // Two cadences (CONTROL-16): the control snapshot is a cheap synchronous DB
    // read refreshed fast (CONTROL_REFRESH_MS) so the live event stream stays
    // fresh; the full snapshot (provider probes + legacy health) is refreshed
    // slowly (FULL_REFRESH_MS) so network probes never gate the UI.
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
    const [control, setControl] = useState<ControlSnapshot | null>(null);
    const [lastRefresh, setLastRefresh] = useState<number>(Date.now());
    const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
    const [palette, setPaletteState] = useState<{ open: boolean; input: string }>({
      open: false,
      input: '',
    });
    const [paletteResult, setPaletteResult] = useState<PaletteResult | null>(null);
    const { exit } = useApp();

    // Stale-refresh guards: a slow gather that finishes after a newer one
    // started is dropped instead of clobbering the fresher snapshot.
    const controlSeq = useRef(createRefreshSequencer()).current;
    const fullSeq = useRef(createRefreshSequencer()).current;

    /** Fast, synchronous control refresh — no await on the render path. */
    const refreshControl = useCallback((sel: string | undefined) => {
      const token = controlSeq.begin();
      const next = readControlSnapshot(sel);
      if (controlSeq.isCurrent(token)) {
        setControl(next);
        setLastRefresh(Date.now());
      }
    }, [controlSeq]);

    /** Slow full refresh — provider probes are already timeout-bounded inside
     *  gatherSnapshot, and a stale result is dropped by the sequencer. */
    const refreshFull = useCallback(async (sel: string | undefined) => {
      const token = fullSeq.begin();
      const snap = await gatherSnapshot({
        cwd: args.cwd,
        version: args.version,
        ...(sel !== undefined ? { selected_session_id: sel } : {}),
      });
      if (fullSeq.isCurrent(token)) setSnapshot(snap);
    }, [fullSeq]);

    useEffect(() => {
      refreshControl(selectedId);
      const id = setInterval(() => refreshControl(selectedId), CONTROL_REFRESH_MS);
      return () => clearInterval(id);
    }, [refreshControl, selectedId]);

    useEffect(() => {
      void refreshFull(selectedId);
      const id = setInterval(() => { void refreshFull(selectedId); }, FULL_REFRESH_MS);
      return () => clearInterval(id);
    }, [refreshFull, selectedId]);

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
        // Immediate (synchronous) control refresh so the operator sees the
        // result without waiting for the next tick; full refresh in background.
        refreshControl(nextSel);
        void refreshFull(nextSel);
      },
      [refreshControl, refreshFull],
    );

    useInput((input, key) => {
      if (palette.open) {
        if (key.return) {
          const line = palette.input;
          setPaletteState({ open: false, input: '' });
          if (line.trim() !== '') {
            void runPaletteLine(
              line,
              selectedId ?? control?.selected_session?.session_id,
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
      if (input === 'r') {
        refreshControl(selectedId);
        void refreshFull(selectedId);
      }
      const down = input === 'j' || key.downArrow;
      const up = input === 'k' || key.upArrow;
      if (control !== null && (down || up)) {
        const ids = control.sessions.map((s) => s.session_id);
        if (ids.length === 0) return;
        const current = control.selected_session?.session_id;
        const idx = current === undefined ? -1 : ids.indexOf(current);
        const nextIdx = Math.min(
          Math.max(idx === -1 ? 0 : idx + (down ? 1 : -1), 0),
          ids.length - 1,
        );
        const next = ids[nextIdx];
        if (next !== undefined && next !== current) setSelectedId(next);
      }
    });

    // Panes render from the fast control snapshot the moment it lands — they do
    // not wait for provider probes (CONTROL-16: offline providers never block).
    const liveControl = control ?? snapshot?.control ?? null;
    if (liveControl === null) {
      return ce(Box, { padding: 1 }, ce(Text, null, 'Loading Command Central...'));
    }

    const view = buildCommandCentralView(liveControl, {
      width: process.stdout.columns ?? 120,
    });
    // LEFT column = Sessions over Queue (two stacked panes); RIGHT = live stream.
    const leftColumn = ce(
      Box,
      { flexDirection: 'column', width: view.narrow ? undefined : 40 },
      ce(RailPane, { key: 'rail', view }),
      ce(QueuePane, { key: 'queue', view }),
    );
    const body = ce(
      Box,
      { flexDirection: view.narrow ? 'column' : 'row' },
      leftColumn,
      ce(MainPane, { key: 'main', view }),
    );
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
      body,
      ce(StatusStrip, { view, snapshot, lastRefreshMs: lastRefresh }),
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
