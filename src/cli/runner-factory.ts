/**
 * Shared provider→runner factory (Phase 9 / 09-01 follow-up).
 *
 * One place that turns a registry-resolved ProviderConfig into a worker
 * runner: env-sourced configs ride the parameterized GenericHttpRunner
 * (DISPATCH-01); the builtins keep their exact runner classes
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
  /** Env used by env-sourced provider runners for key lookup. */
  env?: NodeJS.ProcessEnv;
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
  if (config.source === 'env') {
    const { runnerFromProviderConfig } = await import('../workers/generic-http-runner.js');
    return runnerFromProviderConfig(config, opts.env ?? process.env);
  }
  if (config.name === 'codex') {
    const { CodexRunner } = await import('../workers/codex.js');
    return new CodexRunner();
  }
  if (config.name === 'claude') {
    const { ClaudeRunner } = await import('../workers/claude.js');
    return new ClaudeRunner();
  }
  if (config.name === 'lmstudio') {
    const { LmStudioRunner } = await import('../workers/lmstudio.js');
    return new LmStudioRunner();
  }
  if (config.name === 'openrouter') {
    const { OpenRouterRunner } = await import('../workers/openrouter.js');
    return new OpenRouterRunner();
  }
  if (config.name === 'anthropic') {
    const { AnthropicRunner } = await import('../workers/anthropic.js');
    return new AnthropicRunner();
  }
  if (config.name === 'lmstudio-agentic') {
    const { LmStudioAgenticRunner } = await import('../workers/lmstudio-agentic.js');
    return new LmStudioAgenticRunner(
      opts.agenticExtraToolHandlers ? { extraToolHandlers: opts.agenticExtraToolHandlers } : {}
    );
  }
  if (config.name === 'omlx-agentic') {
    const { OmlxAgenticRunner } = await import('../workers/omlx-agentic.js');
    return new OmlxAgenticRunner(
      opts.agenticExtraToolHandlers ? { extraToolHandlers: opts.agenticExtraToolHandlers } : {}
    );
  }
  // Defensive: a builtin name this factory doesn't know means the registry's
  // builtin table and this mapping drifted — fail loudly (mirrors cmd-run).
  throw new Error(`unsupported provider: ${config.name}`);
}
