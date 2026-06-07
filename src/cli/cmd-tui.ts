/**
 * `relay tui` — interactive terminal UI dashboard (Ink-based).
 *
 * Three-panel layout:
 *   - Top:    last 10 entries from the relay activity log (~/.relay/relay.ndjson)
 *   - Middle: top-5 memory recall preview for the current workdir
 *   - Bottom: status bar (version, db path, hook installed?, providers reachable)
 *
 * Auto-refreshes every 5 seconds. Key bindings:
 *   q | Ctrl-C → quit
 *   r          → manual refresh
 *
 * `--json` flag emits ONE snapshot of the same data structure (no Ink, no
 * refresh loop) and exits — useful for scripting or CI smoke tests.
 *
 * Uses `React.createElement` (no JSX) to avoid adding JSX support to tsconfig.
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

/** Build the Command Central view model from the shared ControlSnapshot. */
export function buildCommandCentralView(
  control: ControlSnapshot,
  opts: { width: number },
): CommandCentralView {
  throw new Error(`not implemented (RED) — buildCommandCentralView(width=${opts.width})`);
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

/**
 * Gather one full snapshot — pure data, no rendering. Used by both `--json` mode
 * and the Ink renderer (which polls this every 5s).
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
 * Render the Ink dashboard. Imported lazily so the `--json` path doesn't pay
 * the Ink/React load cost (and so we can avoid Ink entirely under CI).
 */
async function renderInk(args: TuiArgs): Promise<number> {
  // Lazy imports — Ink + React are only loaded when the interactive UI runs.
  const React = await import('react');
  const { render, Box, Text, useInput, useApp } = await import('ink');
  const ce = React.createElement;
  const { useState, useEffect, useCallback } = React;

  function formatAgo(ts: number): string {
    const delta = Math.max(0, Date.now() - ts);
    if (delta < 60_000) return `${Math.max(1, Math.round(delta / 1000))}s`;
    if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m`;
    if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h`;
    return `${Math.round(delta / 86_400_000)}d`;
  }

  function ActivityPanel(props: { entries: ActivityEntry[] }): React.ReactElement {
    const rows = props.entries.length === 0
      ? [ce(Text, { key: 'empty', dimColor: true }, 'no activity logged yet')]
      : props.entries.map((e, i) =>
          ce(
            Box,
            { key: i, flexDirection: 'row' },
            ce(Text, { color: 'gray' }, `${formatAgo(e.ts).padStart(4)} ago  `),
            ce(Text, { color: 'cyan' }, e.event.padEnd(20)),
            ce(
              Text,
              { color: e.ok === false ? 'red' : e.ok === true ? 'green' : 'gray' },
              e.ok === undefined ? '-' : e.ok ? 'ok' : 'fail',
            ),
          ),
        );
    return ce(
      Box,
      { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', paddingX: 1 },
      ce(Text, { bold: true }, 'Recent activity (last 10)'),
      ...rows,
    );
  }

  function RecallPanel(props: { entries: MemoryPreview[]; cwd: string }): React.ReactElement {
    const rows = props.entries.length === 0
      ? [ce(Text, { key: 'empty', dimColor: true }, 'no memories scored above threshold for this workdir')]
      : props.entries.map((m, i) => {
          const summary = m.content.replace(/\s+/g, ' ').slice(0, 70);
          return ce(
            Box,
            { key: i, flexDirection: 'column' },
            ce(
              Box,
              { flexDirection: 'row' },
              ce(Text, { color: 'yellow' }, m.score.toFixed(3).padStart(6)),
              ce(Text, { color: 'blue' }, `  ${m.memory_type.padEnd(8)}`),
              ce(Text, { color: 'gray' }, `  ${m.memory_id.slice(0, 8)}`),
            ),
            ce(Text, null, `  ${summary}`),
          );
        });
    return ce(
      Box,
      { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', paddingX: 1, marginTop: 1 },
      ce(Text, { bold: true }, `Recall preview (top 5, cwd=${props.cwd})`),
      ...rows,
    );
  }

  function StatusBar(props: { snapshot: Snapshot; lastRefreshMs: number }): React.ReactElement {
    const s = props.snapshot.status;
    const providers = s.providers.map(p => `${p.name}=${p.status}`).join('  ');
    return ce(
      Box,
      { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', paddingX: 1, marginTop: 1 },
      ce(
        Box,
        { flexDirection: 'row' },
        ce(Text, { bold: true }, `relay v${s.binary_version}  `),
        ce(Text, { color: 'gray' }, `db=${s.db_path} (${s.db_entries})  `),
        ce(
          Text,
          { color: s.hook_installed ? 'green' : 'gray' },
          `hook=${s.hook_installed ? 'installed' : 'missing'}`,
        ),
      ),
      ce(Text, { color: 'gray' }, providers),
      ce(Text, { dimColor: true }, `last refresh ${formatAgo(props.lastRefreshMs)} ago  -  q quit  -  r refresh`),
    );
  }

  function App(): React.ReactElement {
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
    const [lastRefresh, setLastRefresh] = useState<number>(Date.now());
    const { exit } = useApp();

    const refresh = useCallback(async () => {
      const snap = await gatherSnapshot({ cwd: args.cwd, version: args.version });
      setSnapshot(snap);
      setLastRefresh(Date.now());
    }, []);

    useEffect(() => {
      void refresh();
      const id = setInterval(() => { void refresh(); }, 5000);
      return () => clearInterval(id);
    }, [refresh]);

    useInput((input, key) => {
      if (input === 'q' || (key.ctrl && input === 'c')) exit();
      if (input === 'r') void refresh();
    });

    if (!snapshot) {
      return ce(Box, { padding: 1 }, ce(Text, null, 'Loading relay snapshot...'));
    }
    return ce(
      Box,
      { flexDirection: 'column' },
      ce(ActivityPanel, { entries: snapshot.recent_activity }),
      ce(RecallPanel, { entries: snapshot.recall_preview, cwd: args.cwd }),
      ce(StatusBar, { snapshot, lastRefreshMs: lastRefresh }),
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
