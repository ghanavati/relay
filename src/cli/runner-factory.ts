/**
 * Shared provider→runner factory (Phase 9 / 09-01 follow-up).
 *
 * One place that turns a registry-resolved ProviderConfig into a worker
 * runner: env-sourced configs ride the parameterized GenericHttpRunner
 * (DISPATCH-01); the five builtins keep their exact runner classes
 * (DISPATCH-02). Extracted so `relay parallel` shares the 09-01 dispatch
 * mapping instead of carrying its own closed provider union.
 *
 * Tool wiring is caller policy: lmstudio-agentic callers pass their own
 * extra tool handlers (cmd-parallel wires Figma; cmd-run additionally wires
 * the run-bound relay_* control tools — that binding cannot live here).
 */

import type { ProviderConfig } from '../workers/provider-registry.js';
import type { WorkerRunner } from '../workers/runner.js';
import type { NamedToolHandler } from '../workers/lmstudio-agentic.js';

export interface RunnerFactoryOpts {
  /**
   * Extra non-shell tool handlers for the lmstudio-agentic runner (Figma,
   * control tools, …). Ignored for every other provider.
   */
  agenticExtraToolHandlers?: NamedToolHandler[];
}

export async function runnerForProvider(
  config: ProviderConfig,
  opts: RunnerFactoryOpts = {}
): Promise<WorkerRunner> {
  void config;
  void opts;
  throw new Error('not implemented — lands with the cmd-parallel registry refactor');
}
