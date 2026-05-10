/**
 * T15 + T29 — Berry hallucination check helper.
 *
 * Optional gate before auto-extracted memory is written to the store.
 *
 * # Why a shell-command hook (T29)
 *
 * Berry exposes its API through MCP tooling (`mcp__berry__detect_hallucination`).
 * MCP tools are routed by the Claude Code runtime — there is **no callable
 * MCP client from a standalone Node CLI** like the relay binary. The earlier
 * HTTP fallback (a localhost endpoint) assumed an out-of-tree shim that
 * doesn't exist in any user's environment, so in practice every call
 * returned `unavailable` and the gate did nothing.
 *
 * Replacement: a configurable shell command via `RELAY_BERRY_CMD`.
 *
 *   - When `RELAY_BERRY_CMD` is set → spawn the command, pipe the lesson
 *     content on stdin. Exit 0 → `pass`, non-zero → `flagged`. Spawn errors
 *     (ENOENT, timeout, etc.) → `unavailable`.
 *   - When `RELAY_BERRY_CMD` is unset → return `unavailable` with the
 *     specific reason `'berry-not-configured'`. The caller treats this as a
 *     non-blocking skip (lessons still write through) and logs
 *     `skipped:berry-not-configured` in the per-lesson detail audit field.
 *
 * The command receives the lesson content on stdin. Operators can wire any
 * verifier (a python script that calls Berry, an LLM grader, a custom regex
 * filter — whatever fits their security model) without rebuilding relay.
 */

import { spawn } from 'node:child_process';

export type BerryCheckOutcome = 'pass' | 'flagged' | 'unavailable';

export interface BerryCheckResult {
  readonly ok: BerryCheckOutcome;
  readonly details?: unknown;
}

export interface TranscriptSpan {
  readonly source: string;
  readonly text: string;
}

export interface CheckLessonOptions {
  readonly lessonContent: string;
  readonly transcriptSpans: readonly TranscriptSpan[];
  readonly timeoutMs?: number;
  /** Override of `process.env['RELAY_BERRY_CMD']`. For tests. */
  readonly cmd?: string;
  /** Spawn override. Wired in tests; defaults to `child_process.spawn`. */
  readonly spawnFn?: typeof spawn;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Detect whether the auto-extracted lesson is grounded.
 *
 * Returns:
 *   - `'pass'`        → command exited 0
 *   - `'flagged'`     → command exited non-zero
 *   - `'unavailable'` → no command configured, spawn failed, or timed out.
 *                       When details.reason is `'berry-not-configured'` the
 *                       caller MUST NOT block the write.
 */
export async function checkLessonViaBerry(
  opts: CheckLessonOptions,
): Promise<BerryCheckResult> {
  if (!opts.lessonContent.trim()) {
    return { ok: 'unavailable', details: { reason: 'empty_lesson' } };
  }

  const cmd = opts.cmd ?? process.env['RELAY_BERRY_CMD'];
  if (!cmd || !cmd.trim()) {
    return { ok: 'unavailable', details: { reason: 'berry-not-configured' } };
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawner = opts.spawnFn ?? spawn;

  return new Promise<BerryCheckResult>((resolve) => {
    let settled = false;
    const settle = (value: BerryCheckResult): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child: ReturnType<typeof spawn>;
    try {
      // Run via the user's shell so they can use pipes / args / quoting in
      // RELAY_BERRY_CMD without us having to re-parse it ourselves.
      child = spawner(cmd, { shell: true });
    } catch (err) {
      settle({ ok: 'unavailable', details: { error: (err as Error).message } });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore — child may already be gone
      }
      settle({ ok: 'unavailable', details: { reason: 'timeout', timeoutMs } });
    }, timeoutMs);

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      settle({ ok: 'unavailable', details: { error: err.message } });
    });

    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (code === 0) settle({ ok: 'pass', details: { code } });
      else settle({ ok: 'flagged', details: { code } });
    });

    // Pipe lesson content on stdin then close. Some implementations may not
    // be reading stdin, so EPIPE on write is non-fatal.
    if (child.stdin) {
      child.stdin.on('error', () => {
        /* ignore EPIPE / etc. — exit code is the real signal */
      });
      try {
        child.stdin.end(opts.lessonContent, 'utf8');
      } catch {
        // already errored above; nothing more to do
      }
    }
  });
}
