/**
 * `relay run <task>` — single-task delegation to codex / openrouter / lmstudio.
 *
 * Flow:
 *   1. Validate args (task non-empty, provider known, model required for HTTP providers)
 *   2. Generate run_id, insert pending run row
 *   3. Dispatch to the matching worker
 *   4. Capture WorkerResult, complete/error the run row
 *   5. Emit JSON or human-readable output
 *
 * Supported providers in v0.1.0: codex, openrouter, lmstudio.
 * Anthropic deferred (no tool-loop in slim distro).
 */

import { randomUUID } from 'node:crypto';
import type { CliIO } from './commands.js';
import { AGENTIC_SANDBOX_ENV } from '../security/env-sanitize.js';

export interface RunCommandArgs {
  task: string;
  provider: string;
  model?: string;
  workdir: string;
  timeoutMs: number;
  reasoningEffort?: string;
  json: boolean;
}

const HTTP_PROVIDERS = new Set(['openrouter', 'lmstudio', 'anthropic', 'lmstudio-agentic']);

export async function executeRunCommand(args: RunCommandArgs, io: CliIO): Promise<number> {
  // 1. Validate
  if (!args.task.trim()) {
    io.stderr('relay run requires a non-empty task\n');
    return 2;
  }
  if (HTTP_PROVIDERS.has(args.provider) && !args.model) {
    io.stderr(`relay run requires --model when --provider is ${args.provider}\n`);
    return 2;
  }

  // 2. Build run row
  const run_id = randomUUID();
  const queued_at = Date.now();
  const task_excerpt = args.task.length > 200 ? args.task.slice(0, 200) + '…' : args.task;

  const { RunStore } = await import('../runtime/store/run-store.js');
  const runStore = new RunStore();
  runStore.create({
    run_id,
    provider: args.provider,
    model: args.model ?? null,
    workdir: args.workdir,
    status: 'running',
    queued_at,
    task_excerpt,
    timeout_ms: args.timeoutMs,
  });
  runStore.recordEvent(run_id, 'started', {
    task_excerpt,
    provider: args.provider,
    model: args.model ?? null,
  });

  const started_at = Date.now();

  // 3. Get the worker
  let runner;
  try {
    if (args.provider === 'codex') {
      const { CodexRunner } = await import('../workers/codex.js');
      runner = new CodexRunner();
    } else if (args.provider === 'lmstudio') {
      const { LmStudioRunner } = await import('../workers/lmstudio.js');
      runner = new LmStudioRunner();
    } else if (args.provider === 'openrouter') {
      const { OpenRouterRunner } = await import('../workers/openrouter.js');
      runner = new OpenRouterRunner();
    } else if (args.provider === 'anthropic') {
      const { AnthropicRunner } = await import('../workers/anthropic.js');
      runner = new AnthropicRunner();
    } else if (args.provider === 'lmstudio-agentic') {
      // 08-fix HIGH — mark this process as an agentic sandbox. shell_exec children
      // inherit it (and defaultShellExec force-injects it per child), so any `relay`
      // CLI a model shells into refuses mutating control subcommands.
      process.env[AGENTIC_SANDBOX_ENV] = '1';
      const { LmStudioAgenticRunner } = await import('../workers/lmstudio-agentic.js');
      // Phase 7 — env-gated Figma REST tools. registerFigmaTools returns null
      // when PAT is absent (FIGMA-03 graceful — model sees zero Figma tools,
      // no startup error). loadPat is the source of truth for the resolved PAT
      // value (env > ~/.relay/secrets/figma.json).
      const { registerFigmaTools } = await import('../tools/figma/index.js');
      const { loadPat } = await import('../tools/figma/pat-loader.js');
      const { homedir } = await import('node:os');
      const figmaHandlers = registerFigmaTools(process.env, homedir());
      const figmaPat = loadPat(process.env, homedir()) ?? '';
      const figmaNamed = figmaHandlers
        ? figmaHandlers.map((h) => ({
            name: h.def.function.name,
            pat: figmaPat,
            handle: h.handle as (a: unknown, c: { workdir: string; pat: string }) => Promise<unknown>,
          }))
        : [];
      // Phase 8 — every Relay-owned lmstudio-agentic run IS a control session
      // (D-08, CONTROL-07): register it, then expose the relay_* control tools
      // through the same extraToolHandlers path Figma uses (CONTROL-05). The
      // caller session id is bound here — the model cannot spoof its source.
      const { createControlSessionForRun, registerControlTools, toNamedToolHandlers } =
        await import('../control/tools.js');
      createControlSessionForRun({
        run_id,
        workdir: args.workdir,
        model: args.model,
        label: task_excerpt,
      });
      const controlNamed = toNamedToolHandlers(registerControlTools(run_id));
      runner = new LmStudioAgenticRunner({ extraToolHandlers: [...figmaNamed, ...controlNamed] });
    } else {
      io.stderr(`unsupported provider: ${args.provider}\n`);
      runStore.recordError(run_id, {
        error_code: 'INVALID_ARGS',
        error_message: `unsupported provider: ${args.provider}`,
        finished_at: Date.now(),
      });
      return 2;
    }
  } catch (err) {
    const message = (err as Error).message;
    io.stderr(`failed to load ${args.provider} runner: ${message}\n`);
    runStore.recordError(run_id, {
      error_code: 'RUNNER_LOAD_FAILED',
      error_message: message,
      finished_at: Date.now(),
    });
    return 1;
  }

  // 4. Dispatch
  const { buildDelegatedTask } = await import('../context/layers.js');
  const built = await buildDelegatedTask({
    workdir: args.workdir,
    task: args.task,
    run_id,
  });
  // Inject default agentic tools when dispatching to lmstudio-agentic so the
  // runner has a shell_exec tool to offer the model. Worker rejects empty tools[].
  // Phase 7: when registerFigmaTools returned handlers, merge their ToolDefs into
  // the tools[] presented to the model (additive — preserves shell_exec).
  let tools;
  if (args.provider === 'lmstudio-agentic') {
    const { DEFAULT_AGENTIC_TOOLS } = await import('../workers/lmstudio-agentic.js');
    const { registerFigmaTools } = await import('../tools/figma/index.js');
    const { CONTROL_TOOL_DEFS } = await import('../control/tools.js');
    const { homedir } = await import('node:os');
    const figmaHandlers = registerFigmaTools(process.env, homedir());
    // Phase 8 — relay_* control tool defs are always offered to Relay-owned
    // agentic sessions; Figma defs stay env-gated. Additive — preserves shell_exec.
    tools = [
      ...DEFAULT_AGENTIC_TOOLS,
      ...(figmaHandlers ? figmaHandlers.map((h) => h.def) : []),
      ...CONTROL_TOOL_DEFS,
    ];
  }
  let result;
  try {
    result = await runner.run({
      task: built.bareTask,
      contextPrefix: built.contextPrefix,
      workdir: args.workdir,
      timeout_ms: args.timeoutMs,
      model: args.model,
      reasoning_effort: args.reasoningEffort,
      run_id,
      provider: args.provider,
      ...(tools ? { tools } : {}),
    });
  } catch (err) {
    const message = (err as Error).message;
    runStore.recordError(run_id, {
      error_code: 'WORKER_THREW',
      error_message: message,
      finished_at: Date.now(),
    });
    // Phase 8 — close the run's control session on the throw path too.
    if (args.provider === 'lmstudio-agentic') {
      const { endControlSessionForRun } = await import('../control/tools.js');
      endControlSessionForRun(run_id);
    }
    if (args.json) {
      io.stdout(JSON.stringify({ run_id, status: 'error', error: message }) + '\n');
    } else {
      io.stderr(`worker threw: ${message}\n`);
    }
    return 1;
  }

  // 5. Record completion
  const finished_at = Date.now();
  if (result.status === 'error' || result.status === 'timeout') {
    runStore.complete(run_id, {
      status: result.status,
      started_at,
      finished_at,
      duration_ms: result.duration_ms,
      exit_code: result.exit_code,
      token_usage: result.token_usage ?? null,
      prompt_tokens: result.prompt_tokens ?? null,
      completion_tokens: result.completion_tokens ?? null,
      error_code: result.error?.code ?? 'UNKNOWN',
      error_message: result.error?.message ?? '',
    });
  } else {
    runStore.complete(run_id, {
      status: 'success',
      started_at,
      finished_at,
      duration_ms: result.duration_ms,
      exit_code: result.exit_code,
      token_usage: result.token_usage ?? null,
      prompt_tokens: result.prompt_tokens ?? null,
      completion_tokens: result.completion_tokens ?? null,
    });
  }

  // Phase 8 — the run is over: mark its control session ended (audited).
  if (args.provider === 'lmstudio-agentic') {
    const { endControlSessionForRun } = await import('../control/tools.js');
    endControlSessionForRun(run_id);
  }

  // 6. Output
  if (args.json) {
    io.stdout(JSON.stringify({
      run_id,
      status: result.status,
      output: result.output,
      duration_ms: result.duration_ms,
      exit_code: result.exit_code,
      token_usage: result.token_usage ?? null,
      // Agentic-worker metrics — populated when execution_model='tool_loop'.
      ...(result.iterations !== undefined ? { iterations: result.iterations } : {}),
      ...(result.tool_call_count !== undefined ? { tool_call_count: result.tool_call_count } : {}),
      error: result.error ? { code: result.error.code, message: result.error.message } : null,
    }) + '\n');
  } else {
    if (result.status === 'success') {
      io.stdout(result.output);
      if (!result.output.endsWith('\n')) io.stdout('\n');
      io.stderr(`\n[run ${run_id} done in ${result.duration_ms}ms]\n`);
    } else {
      io.stderr(`run ${run_id} ${result.status}: ${result.error?.message ?? 'no error message'}\n`);
      if (result.output) io.stdout(result.output + '\n');
    }
  }

  return result.status === 'success' ? 0 : 1;
}
