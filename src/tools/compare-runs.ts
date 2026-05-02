import type { CompareRunsArgs, CompareRunsResult, PerRunProfile } from "../contracts/compare-runs.js";
import { RunStore } from "../runtime/store/run-store.js";
import { toMcpResult } from './mcp-result.js';

type McpToolResult = { content: Array<{ type: "text"; text: string }> };

export function handleCompareRuns(args: CompareRunsArgs): McpToolResult {
  const store = new RunStore();

  const profiles: PerRunProfile[] = args.run_ids.map((runId) => {
    const row = store.getRun(runId);
    const filesChanged: string[] = row?.files_changed_json
      ? (JSON.parse(row.files_changed_json) as string[])
      : [];
    return {
      run_id: runId,
      provider: row?.provider ?? null,
      model: row?.model ?? null,
      status: row?.status ?? null,
      files_changed: filesChanged,
      unique_files: [],
    };
  });

  const sets = profiles.map((p) => new Set(p.files_changed));

  const union = new Set(sets.flatMap((s) => [...s]));
  const intersection = new Set([...sets[0]].filter((f) => sets.every((s) => s.has(f))));
  const diverged = new Set([...union].filter((f) => !intersection.has(f)));

  const withUniques = profiles.map((p, i) => ({
    ...p,
    unique_files: p.files_changed
      .filter((f) => sets.every((s, j) => j === i || !s.has(f)))
      .sort(),
  }));

  const raw = union.size === 0 ? 0 : 1 - intersection.size / union.size;
  const divergenceScore = Math.round(raw * 1000) / 1000;
  const agreementScore = Math.round((1 - divergenceScore) * 1000) / 1000;

  const result: CompareRunsResult = {
    run_ids: args.run_ids,
    files_union: [...union].sort(),
    files_intersection: [...intersection].sort(),
    files_diverged: [...diverged].sort(),
    per_run: withUniques,
    divergence_score: divergenceScore,
    agreement_score: agreementScore,
  };

  return toMcpResult(result);
}
