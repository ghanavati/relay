import type { ContextLayer, ContextLayerProvider } from "./layers.js";
import { getRunStore } from "../runtime/store/run-store.js";
import type { RunRow } from "../runtime/store/run-store.js";
import { isTruthy } from "./utils.js";

const HISTORY_LIMIT = 20;
const MAX_DISPLAY_RUNS = 5;
const DEFAULT_SESSION_WINDOW_MS = 4 * 60 * 60 * 1000;

function formatRunLine(run: RunRow): string {
  const shortId = run.run_id.slice(0, 8);
  const excerpt = run.task_excerpt?.trim() || "(no excerpt)";
  const duration = run.duration_ms != null ? `${run.duration_ms}ms` : "?ms";
  const filesChanged: string[] = run.files_changed_json
    ? (JSON.parse(run.files_changed_json) as string[])
    : [];
  const files = filesChanged.length > 0 ? filesChanged.join(", ") : "(none)";
  return `Run ${shortId}: ${excerpt} — ${run.status} in ${duration}\n  Files changed: ${files}`;
}

function isSessionScoped(): boolean {
  return (process.env["RELAY_SESSION_ID"]?.trim().length ?? 0) > 0;
}

function getSessionWindowMs(): number {
  const raw = process.env["RELAY_SESSION_WINDOW_MS"];
  if (!raw) return DEFAULT_SESSION_WINDOW_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_WINDOW_MS;
}

function matchesSessionWindow(run: RunRow, now: number): boolean {
  if (!isSessionScoped()) return true;
  return run.queued_at > now - getSessionWindowMs();
}

export function createRunHistoryLayerProvider(): ContextLayerProvider {
  return {
    id: "run_history",
    async load(args: { workdir: string }): Promise<ContextLayer | null> {
      if (!isTruthy(process.env["RELAY_RUN_HISTORY_LAYERS"])) return null;
      const sessionScoped = isSessionScoped();

      let recentRuns: RunRow[];
      try {
        const store = getRunStore();
        recentRuns = store.list({ status: "success", limit: HISTORY_LIMIT });
      } catch {
        return null;
      }

      const workdirRuns = recentRuns
        .filter((run) => run.workdir === args.workdir)
        .filter((run) => matchesSessionWindow(run, Date.now()))
        .slice(0, MAX_DISPLAY_RUNS);

      if (workdirRuns.length === 0) return null;

      const lines = workdirRuns.map(formatRunLine);
      const title = sessionScoped ? "## Recent Run History (this session)" : "## Recent Run History (same workdir)";
      const content = `${title}\n\n${lines.join("\n")}`;
      return { id: "run_history", content };
    },
  };
}
