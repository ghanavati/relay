/**
 * `relay update [--check] [--apply] [--json]` — self-update for Relay.
 *
 * Default mode: --check (notify only). Compares HEAD to remote main and prints
 * "X commits behind" or "up to date".
 *
 * --apply mode runs `git pull --ff-only && npm run build && npm test` in the
 * detected source directory. Aborts on dirty tree, non-main branch, or any
 * step failure.
 *
 * Source dir detection:
 *   1. Resolve `which relay` to an absolute path
 *   2. Symlinks resolved (e.g. ~/.local/bin/relay -> /repo/dist/cli.js)
 *   3. Walk up from dist/cli.js to the repo root (parent of dist/)
 *   4. If detection fails, falls back to RELAY_REPO_DIR env var
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { CliIO } from './commands.js';
import { c } from './colors.js';

const execFileAsync = promisify(execFile);

export interface UpdateArgs {
  check: boolean;
  apply: boolean;
  json: boolean;
  force: boolean;
}

export interface UpdateResult {
  current_sha: string;
  remote_sha: string;
  commits_behind: number;
  last_remote_commit_ts: number | null;
  applied: boolean;
  status: 'up-to-date' | 'behind' | 'applied' | 'aborted' | 'error';
  reason?: string;
}

/** Injectable runner so tests can mock git/npm subprocesses. */
export interface CommandRunner {
  /** Run a command in `cwd`, returning combined stdout. Throws on non-zero. */
  run(file: string, args: readonly string[], cwd: string): Promise<string>;
  /** Resolve a binary on PATH (`which <name>`). Returns absolute path or null. */
  which(name: string): Promise<string | null>;
  /** Resolve symlinks recursively to the underlying real path. */
  realpath(path: string): Promise<string>;
}

export const defaultRunner: CommandRunner = {
  async run(file, args, cwd) {
    const { stdout } = await execFileAsync(file, args as string[], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  },
  async which(name) {
    try {
      const { stdout } = await execFileAsync('which', [name], { encoding: 'utf8' });
      const trimmed = stdout.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  },
  async realpath(p) {
    return realpath(p);
  },
};

/**
 * Detect the Relay source directory by resolving the `relay` binary on PATH
 * and walking up to the repo root.
 */
export async function detectSourceDir(runner: CommandRunner): Promise<string | null> {
  const envOverride = process.env['RELAY_REPO_DIR'];
  if (envOverride && envOverride.trim().length > 0) {
    return resolve(envOverride.trim());
  }

  const relayBin = await runner.which('relay');
  if (!relayBin) return null;

  let realBin: string;
  try {
    realBin = await runner.realpath(relayBin);
  } catch {
    return null;
  }

  // Expected layout: <repo>/dist/cli.js -> walk up two levels.
  // realBin is .../<repo>/dist/cli.js
  const distDir = dirname(realBin);
  const repoRoot = dirname(distDir);
  return repoRoot;
}

/**
 * Run a step and return whether it succeeded. Captures stderr in the error.
 */
async function tryStep(
  runner: CommandRunner,
  file: string,
  args: readonly string[],
  cwd: string,
): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
  try {
    const output = await runner.run(file, args, cwd);
    return { ok: true, output };
  } catch (err) {
    const e = err as Error & { stderr?: string; stdout?: string };
    const message = e.stderr || e.stdout || e.message || 'unknown error';
    return { ok: false, error: message.trim() };
  }
}

function emit(io: CliIO, json: boolean, result: UpdateResult, exitCode: number): number {
  if (json) {
    io.stdout(JSON.stringify(result) + '\n');
    return exitCode;
  }

  const lines: string[] = [];
  if (result.status === 'error') {
    io.stderr(`${c.red('relay update failed')}: ${result.reason ?? 'unknown error'}\n`);
    return exitCode;
  }
  if (result.status === 'aborted') {
    io.stderr(`${c.yellow('relay update aborted')}: ${result.reason ?? 'unknown reason'}\n`);
    return exitCode;
  }

  lines.push(c.bold('relay update'));
  lines.push('');
  lines.push(`current:  ${result.current_sha.slice(0, 12)}`);
  lines.push(`remote:   ${result.remote_sha.slice(0, 12)}`);

  if (result.status === 'up-to-date') {
    lines.push(c.green('up to date.'));
  } else if (result.status === 'behind') {
    const ts = result.last_remote_commit_ts;
    const days = ts ? Math.floor((Date.now() - ts) / 86_400_000) : null;
    const last = days === null ? 'unknown date' : days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`;
    lines.push(c.yellow(`${result.commits_behind} commit${result.commits_behind === 1 ? '' : 's'} behind, last update ${last}.`));
    lines.push('');
    lines.push(c.dim('Run `relay update --apply` to pull, build, and test.'));
  } else if (result.status === 'applied') {
    lines.push(c.green(`applied: pulled, built, and tested ${result.commits_behind} commit${result.commits_behind === 1 ? '' : 's'}.`));
  }

  io.stdout(lines.join('\n') + '\n');
  return exitCode;
}

export async function executeUpdateCommand(
  args: UpdateArgs,
  io: CliIO,
  runner: CommandRunner = defaultRunner,
): Promise<number> {
  const sourceDir = await detectSourceDir(runner);
  if (!sourceDir) {
    return emit(io, args.json, {
      current_sha: '',
      remote_sha: '',
      commits_behind: 0,
      last_remote_commit_ts: null,
      applied: false,
      status: 'error',
      reason: 'could not detect Relay source directory (set RELAY_REPO_DIR or ensure `relay` is on PATH)',
    }, 1);
  }

  // Verify it's a git repo
  const insideGit = await tryStep(runner, 'git', ['rev-parse', '--is-inside-work-tree'], sourceDir);
  if (!insideGit.ok) {
    return emit(io, args.json, {
      current_sha: '', remote_sha: '', commits_behind: 0, last_remote_commit_ts: null,
      applied: false, status: 'error', reason: `${sourceDir} is not a git repository`,
    }, 1);
  }

  // Fetch remote (best effort — surface error if it fails)
  const fetchStep = await tryStep(runner, 'git', ['fetch', 'origin', 'main'], sourceDir);
  if (!fetchStep.ok) {
    return emit(io, args.json, {
      current_sha: '', remote_sha: '', commits_behind: 0, last_remote_commit_ts: null,
      applied: false, status: 'error', reason: `git fetch failed: ${fetchStep.error}`,
    }, 1);
  }

  // Get current + remote SHAs
  const currentSha = await tryStep(runner, 'git', ['rev-parse', 'HEAD'], sourceDir);
  const remoteSha = await tryStep(runner, 'git', ['rev-parse', 'origin/main'], sourceDir);
  if (!currentSha.ok || !remoteSha.ok) {
    return emit(io, args.json, {
      current_sha: '', remote_sha: '', commits_behind: 0, last_remote_commit_ts: null,
      applied: false, status: 'error', reason: 'failed to read git refs',
    }, 1);
  }

  const current = currentSha.output.trim();
  const remote = remoteSha.output.trim();

  // Count commits behind
  let commitsBehind = 0;
  if (current !== remote) {
    const countStep = await tryStep(runner, 'git', ['rev-list', '--count', `${current}..${remote}`], sourceDir);
    if (countStep.ok) {
      const parsed = Number.parseInt(countStep.output.trim(), 10);
      if (Number.isFinite(parsed) && parsed >= 0) commitsBehind = parsed;
    }
  }

  // Get remote commit timestamp
  let lastRemoteTs: number | null = null;
  const tsStep = await tryStep(runner, 'git', ['log', '-1', '--format=%ct', remote], sourceDir);
  if (tsStep.ok) {
    const parsed = Number.parseInt(tsStep.output.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) lastRemoteTs = parsed * 1000;
  }

  const baseResult: UpdateResult = {
    current_sha: current,
    remote_sha: remote,
    commits_behind: commitsBehind,
    last_remote_commit_ts: lastRemoteTs,
    applied: false,
    status: commitsBehind === 0 ? 'up-to-date' : 'behind',
  };

  // Default to --check unless --apply explicitly set
  if (!args.apply) {
    return emit(io, args.json, baseResult, 0);
  }

  // --- APPLY MODE ---

  // Safety: refuse if working tree dirty
  const dirtyStep = await tryStep(runner, 'git', ['status', '--porcelain'], sourceDir);
  if (!dirtyStep.ok) {
    return emit(io, args.json, { ...baseResult, status: 'error', reason: 'failed to read git status' }, 1);
  }
  if (dirtyStep.output.trim().length > 0) {
    return emit(io, args.json, {
      ...baseResult, status: 'aborted',
      reason: 'working tree has uncommitted changes; commit or stash before --apply',
    }, 1);
  }

  // Safety: refuse if not on main
  const branchStep = await tryStep(runner, 'git', ['rev-parse', '--abbrev-ref', 'HEAD'], sourceDir);
  if (!branchStep.ok) {
    return emit(io, args.json, { ...baseResult, status: 'error', reason: 'failed to read current branch' }, 1);
  }
  const branch = branchStep.output.trim();
  if (branch !== 'main') {
    return emit(io, args.json, {
      ...baseResult, status: 'aborted',
      reason: `current branch is "${branch}", expected "main"; checkout main before --apply`,
    }, 1);
  }

  // Safety: require --force unless there's at least one signed tag ahead.
  if (!args.force) {
    const tagStep = await tryStep(
      runner, 'git',
      ['tag', '--list', '--contains', current, '--merged', remote, '--sort=-creatordate'],
      sourceDir,
    );
    const hasTag = tagStep.ok && tagStep.output.trim().length > 0;
    // If no tags ahead of current, require --force.
    if (!hasTag) {
      // Check if there are ANY tags between current and remote (including unsigned).
      const anyTagStep = await tryStep(
        runner, 'git',
        ['tag', '--list', '--contains', current, '--merged', remote],
        sourceDir,
      );
      const anyTag = anyTagStep.ok && anyTagStep.output.trim().length > 0;
      if (!anyTag) {
        return emit(io, args.json, {
          ...baseResult, status: 'aborted',
          reason: 'no signed tags ahead of current commit; pass --force to override',
        }, 1);
      }
    }
  }

  // Skip apply if already up to date
  if (commitsBehind === 0) {
    return emit(io, args.json, { ...baseResult, status: 'up-to-date' }, 0);
  }

  // Step 1: git pull --ff-only
  const pullStep = await tryStep(runner, 'git', ['pull', '--ff-only', 'origin', 'main'], sourceDir);
  if (!pullStep.ok) {
    return emit(io, args.json, {
      ...baseResult, status: 'error', reason: `git pull failed: ${pullStep.error}`,
    }, 1);
  }

  // Step 2: npm run build
  const buildStep = await tryStep(runner, 'npm', ['run', 'build'], sourceDir);
  if (!buildStep.ok) {
    return emit(io, args.json, {
      ...baseResult, status: 'error', reason: `npm run build failed: ${buildStep.error}`,
    }, 1);
  }

  // Step 3: npm test
  const testStep = await tryStep(runner, 'npm', ['test'], sourceDir);
  if (!testStep.ok) {
    return emit(io, args.json, {
      ...baseResult, status: 'error', reason: `npm test failed: ${testStep.error}`,
    }, 1);
  }

  // Re-read current sha after pull
  const newShaStep = await tryStep(runner, 'git', ['rev-parse', 'HEAD'], sourceDir);
  const newSha = newShaStep.ok ? newShaStep.output.trim() : remote;

  return emit(io, args.json, {
    ...baseResult,
    current_sha: newSha,
    applied: true,
    status: 'applied',
  }, 0);
}
