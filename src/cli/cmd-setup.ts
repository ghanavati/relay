/**
 * `relay setup --everything` — one-command installer.
 *
 * Wraps four sub-steps and runs them sequentially, aborting on first failure:
 *   1. relay init --auto                                    (config + provider detect)
 *   2. relay memory hook --install --global                 (CC SessionStart hook)
 *   3. relay memory hook --install --global --session-end   (CC SessionEnd hook)
 *   4. relay memory auto-extract --enable --workdir <cwd>   (per-workdir consent)
 *
 * Modes:
 *   relay setup --everything            — non-interactive by default (T14)
 *   relay setup --everything --interactive
 *                                       — opt back into init's Y/n prompts (T14)
 *   relay setup --everything --json     — single JSON object with each step's status
 *   relay setup --everything --yes      — skip any interactive prompts (treated like --auto)
 *   relay setup --everything --workdir <p>  — auto-extract consent target (default: cwd)
 *   relay setup --everything --lm-model <id> — recorded in config (forwarded to init)
 *   relay setup --clean                 — uninstall stale Relay-managed hooks first (T15)
 *                                         (idempotent; can be combined with --everything
 *                                         to guarantee a clean re-install)
 *
 * Exit codes:
 *   0 — all four steps succeeded
 *   1 — one or more steps failed; first failure aborts the rest
 *   2 — usage error (missing --everything, etc.)
 */

import type { CliIO } from './commands.js';

export interface SetupArgs {
  everything: boolean;
  workdir: string | undefined;
  lmModel: string | undefined;
  yes: boolean;
  json: boolean;
  /** T14 — opt back into init's Y/n prompts (default: non-interactive). */
  interactive: boolean;
  /** T15 — strip stale Relay-managed hook entries (global, both events) before install. */
  clean: boolean;
}

/** Result of one sub-step. */
interface StepResult {
  step: string;
  ok: boolean;
  exit_code: number;
  error?: string;
}

/**
 * DI seam: each underlying executor is overridable so tests can mock them
 * without touching the real ~/.relay or .claude/settings.json. In production
 * (no overrides), the real executors are dynamically imported.
 */
export interface SetupExecutors {
  runInit?: (args: { auto: boolean; quick: boolean; json: boolean }, io: CliIO) => Promise<number>;
  runHookInstall?: (
    args: { install: boolean; json: boolean; global?: boolean; sessionEnd?: boolean },
    io: CliIO,
    cwd: string
  ) => Promise<number>;
  runAutoExtractEnable?: (
    args: { workdir: string; json: boolean },
    io: CliIO
  ) => Promise<number>;
}

async function defaultRunInit(
  args: { auto: boolean; quick: boolean; json: boolean },
  io: CliIO
): Promise<number> {
  const { executeInitCommand } = await import('./cmd-init.js');
  return executeInitCommand(args, io);
}

async function defaultRunHookInstall(
  args: { install: boolean; json: boolean; global?: boolean; sessionEnd?: boolean },
  io: CliIO,
  cwd: string
): Promise<number> {
  const mod = (await import('./cmd-memory-ops.js')) as {
    executeMemoryHookCommand: (
      args: { install: boolean; json: boolean; global?: boolean; sessionEnd?: boolean },
      io: CliIO,
      cwd: string
    ) => Promise<number>;
  };
  return mod.executeMemoryHookCommand(args, io, cwd);
}

async function defaultRunAutoExtractEnable(
  args: { workdir: string; json: boolean },
  io: CliIO
): Promise<number> {
  // Module resolved via a string-typed variable so TypeScript does NOT try to
  // resolve it at compile time. The auto-extract pipeline ships in a separate
  // wave-2 task (T16/T20 family). When merged with that work, this dynamic
  // import resolves to the real `executeMemoryAutoExtractEnableCommand`. Until
  // then, we surface a clear error rather than crashing the whole setup.
  const modulePath = './cmd-memory-auto-extract-enable.js';
  try {
    const mod = (await import(modulePath)) as {
      executeMemoryAutoExtractEnableCommand?: (
        args: { allowRemote: boolean; workdir: string; json: boolean },
        io: CliIO
      ) => Promise<number>;
    };
    if (!mod.executeMemoryAutoExtractEnableCommand) {
      io.stderr('auto-extract enable command not available in this build\n');
      return 1;
    }
    return mod.executeMemoryAutoExtractEnableCommand(
      { allowRemote: false, workdir: args.workdir, json: args.json },
      io
    );
  } catch (err) {
    io.stderr(`auto-extract enable unavailable: ${(err as Error).message}\n`);
    return 1;
  }
}

/** Run a single step with discard-stdout in JSON mode so only the summary surfaces. */
async function runStep(
  label: string,
  io: CliIO,
  asJson: boolean,
  exec: (childIo: CliIO) => Promise<number>
): Promise<StepResult> {
  if (!asJson) io.stdout(`==> ${label}\n`);
  const childIo: CliIO = asJson
    ? { cwd: io.cwd, stdout: () => {}, stderr: io.stderr }
    : io;
  try {
    const code = await exec(childIo);
    return { step: label, ok: code === 0, exit_code: code };
  } catch (err) {
    return { step: label, ok: false, exit_code: 1, error: (err as Error).message };
  }
}

export async function executeSetupCommand(
  args: SetupArgs,
  io: CliIO,
  executors: SetupExecutors = {}
): Promise<number> {
  // Validate flag combinations: at least one of --everything or --clean must be
  // present. --clean without --everything = idempotent uninstall-only run.
  if (!args.everything && !args.clean) {
    io.stderr('relay setup requires --everything or --clean (or both)\n');
    return 2;
  }

  const runInit = executors.runInit ?? defaultRunInit;
  const runHookInstall = executors.runHookInstall ?? defaultRunHookInstall;
  const runAutoExtractEnable = executors.runAutoExtractEnable ?? defaultRunAutoExtractEnable;

  // T14 — Default non-interactive. Init is interactive ONLY when caller passes
  // --interactive AND we're not in --json mode (json mode is always machine-
  // facing, so prompts would dead-lock). --yes is kept as an alias for the
  // legacy "force non-interactive" intent and overrides --interactive.
  const auto = args.yes || args.json || !args.interactive;
  const workdir = args.workdir ?? io.cwd;
  const results: StepResult[] = [];

  // T15 — Optional --clean: strip stale Relay-managed hook entries first.
  // We target BOTH the global settings (`~/.claude/settings.json`) and the
  // project settings (`<cwd>/.claude/settings.json`), and within each file
  // both SessionStart (HOOK_MARKER_SESSION_START = 'relay-context-emit-v1')
  // and SessionEnd (HOOK_MARKER_SESSION_END = 'relay-session-end-v1').
  //
  // The underlying executeMemoryHookCommand uses the marker fields to
  // identify Relay's entries — it never matches by command substring, so
  // foreign hooks are preserved untouched. Idempotent: running --clean
  // twice is a no-op the second time (uninstall on an empty hook list still
  // returns 0 and leaves foreign entries alone).
  if (args.clean) {
    const cleanupTargets: Array<{ global: boolean; sessionEnd: boolean; label: string }> = [
      { global: true, sessionEnd: false, label: 'relay memory hook --uninstall --global (SessionStart cleanup)' },
      { global: true, sessionEnd: true, label: 'relay memory hook --uninstall --global --session-end (SessionEnd cleanup)' },
      { global: false, sessionEnd: false, label: 'relay memory hook --uninstall (project SessionStart cleanup)' },
      { global: false, sessionEnd: true, label: 'relay memory hook --uninstall --session-end (project SessionEnd cleanup)' },
    ];

    for (const target of cleanupTargets) {
      results.push(
        await runStep(
          target.label,
          io,
          args.json,
          (childIo) =>
            runHookInstall(
              { install: false, json: args.json, global: target.global, sessionEnd: target.sessionEnd },
              childIo,
              io.cwd
            )
        )
      );
      if (!results.at(-1)!.ok) return finalize(io, args.json, results);
    }
  }

  // --clean alone (without --everything) returns after cleanup — idempotent
  // uninstall-only run is a valid use case for users who want to rip Relay
  // hooks out of CC without re-installing.
  if (!args.everything) {
    return finalize(io, args.json, results);
  }

  // Step 1 — init --auto (non-interactive by default per T14)
  results.push(
    await runStep('relay init --auto', io, args.json, (childIo) =>
      runInit({ auto, quick: false, json: args.json }, childIo)
    )
  );
  if (!results.at(-1)!.ok) return finalize(io, args.json, results);

  // Step 2 — memory hook --install --global (SessionStart)
  results.push(
    await runStep('relay memory hook --install --global', io, args.json, (childIo) =>
      runHookInstall(
        { install: true, json: args.json, global: true, sessionEnd: false },
        childIo,
        io.cwd
      )
    )
  );
  if (!results.at(-1)!.ok) return finalize(io, args.json, results);

  // Step 3 — memory hook --install --global --session-end (SessionEnd)
  results.push(
    await runStep(
      'relay memory hook --install --global --session-end',
      io,
      args.json,
      (childIo) =>
        runHookInstall(
          { install: true, json: args.json, global: true, sessionEnd: true },
          childIo,
          io.cwd
        )
    )
  );
  if (!results.at(-1)!.ok) return finalize(io, args.json, results);

  // Step 4 — memory auto-extract --enable --workdir <path>
  results.push(
    await runStep(
      `relay memory auto-extract --enable --workdir ${workdir}`,
      io,
      args.json,
      (childIo) => runAutoExtractEnable({ workdir, json: args.json }, childIo)
    )
  );

  return finalize(io, args.json, results);
}

function finalize(io: CliIO, asJson: boolean, results: readonly StepResult[]): number {
  const allOk = results.length > 0 && results.every((r) => r.ok);
  const exit = allOk ? 0 : 1;
  if (asJson) {
    io.stdout(JSON.stringify({ ok: allOk, steps: results }) + '\n');
  } else if (allOk) {
    io.stdout(`\n[ok] relay setup: ${results.length} steps completed\n`);
  } else {
    const failed = results.find((r) => !r.ok);
    io.stderr(
      `\n[fail] relay setup aborted at step "${failed?.step ?? 'unknown'}" (exit=${failed?.exit_code ?? 1})${failed?.error ? `: ${failed.error}` : ''}\n`
    );
  }
  return exit;
}
