import { spawn } from 'node:child_process';
import type { WorkerTask, WorkerResult } from './types.js';
import type { WorkerRunner } from './runner.js';
import { getClaudeBin } from '../config/runtime.js';
import { makeError } from '../errors.js';

function taskPrompt(task: WorkerTask): string {
  if (task.contextPrefix && task.contextPrefix.length > 0) {
    return `${task.contextPrefix}\n\n${task.task}`;
  }
  return task.task;
}

function terminateProcessGroup(
  pid: number | undefined,
  signal: 'SIGTERM' | 'SIGKILL',
): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch (err) {
    process.stderr.write(
      `relay: failed to send ${signal} to claude process group ${pid}: ${(err as Error).message}\n`,
    );
  }
}

export async function runClaudeWorker(task: WorkerTask): Promise<WorkerResult> {
  const startTime = Date.now();
  const claudeBin = getClaudeBin();
  // Extraction is a pure text→JSON transform. `--tools ''` sets the AVAILABLE tool set
  // to empty (NOT --allowedTools, which only controls which tools auto-run without a
  // prompt — it leaves every tool available); this makes `claude -p` a constrained
  // completion that can't read files / hit MCP / wander. Prompt arrives on stdin, so the
  // empty value can't be mistaken for it. Forward the requested model so the run matches
  // what Relay recorded instead of silently using the user's default Claude model.
  const args = ['-p', '--tools', ''];
  if (task.model) args.push('--model', task.model);
  const child = spawn(claudeBin, args, {
    cwd: task.workdir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
    detached: true,
  });

  child.stdin?.end(taskPrompt(task));

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stderr += text;
    if (task.onStderr) {
      task.onStderr(text);
      return;
    }
    process.stderr.write(text);
  });

  if (child.pid !== undefined) child.unref();

  let timedOut = false;
  let processExited = false;
  let sigkillHandle: NodeJS.Timeout | null = null;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    terminateProcessGroup(child.pid, 'SIGTERM');
    sigkillHandle = setTimeout(() => {
      if (!processExited) terminateProcessGroup(child.pid, 'SIGKILL');
      sigkillHandle = null;
    }, 5_000);
  }, task.timeout_ms);

  return new Promise<WorkerResult>((resolve) => {
    child.on('close', (code) => {
      processExited = true;
      clearTimeout(timeoutHandle);
      if (sigkillHandle) clearTimeout(sigkillHandle);
      const duration_ms = Date.now() - startTime;
      if (timedOut) {
        resolve({
          status: 'timeout',
          output: stdout,
          duration_ms,
          exit_code: null,
          error: makeError('TIMEOUT', `Claude timed out after ${task.timeout_ms}ms`, true),
        });
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : '';
        resolve({
          status: 'error',
          output: stdout,
          duration_ms,
          exit_code: code,
          error: makeError('PROVIDER_ERROR', `Claude exited with code ${code}${detail}`, false),
        });
        return;
      }
      resolve({ status: 'success', output: stdout.trim(), duration_ms, exit_code: code });
    });

    child.on('error', (err) => {
      processExited = true;
      clearTimeout(timeoutHandle);
      if (sigkillHandle) clearTimeout(sigkillHandle);
      resolve({
        status: 'error',
        output: '',
        duration_ms: Date.now() - startTime,
        exit_code: null,
        error: makeError(
          'BINARY_NOT_FOUND',
          `Failed to spawn claude binary (${claudeBin}): ${err.message}. Set RELAY_CLAUDE_PATH=/full/path/to/claude if needed.`,
          false,
        ),
      });
    });
  });
}

export class ClaudeRunner implements WorkerRunner {
  readonly capabilities = { agentic: true, execution_model: 'subprocess' } as const;

  run(task: WorkerTask): Promise<WorkerResult> {
    return runClaudeWorker(task);
  }
}
