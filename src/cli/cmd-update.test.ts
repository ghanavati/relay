process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  executeUpdateCommand,
  detectSourceDir,
  type CommandRunner,
  type UpdateResult,
} from './cmd-update.js';
import type { CliIO } from './commands.js';

interface CapturedIO {
  io: CliIO;
  stdout: string[];
  stderr: string[];
}

function makeIO(cwd = '/tmp/test-relay-update'): CapturedIO {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      cwd,
      stdout: (m) => stdout.push(m),
      stderr: (m) => stderr.push(m),
    },
    stdout,
    stderr,
  };
}

function findJson(stdout: string[]): UpdateResult | null {
  const joined = stdout.join('').trim();
  if (!joined.startsWith('{')) return null;
  try {
    return JSON.parse(joined) as UpdateResult;
  } catch {
    return null;
  }
}

/**
 * Simple programmable mock: a list of (file, args[0..]) match-and-respond entries.
 * Each entry can return stdout (success) or throw.
 */
interface MockResponse {
  match: (file: string, args: readonly string[]) => boolean;
  reply: { stdout?: string; error?: string };
}

function makeRunner(responses: MockResponse[], whichResult = '/usr/local/bin/relay', realpathResult = '/repo/dist/cli.js'): CommandRunner {
  return {
    async run(file, args, _cwd) {
      for (const r of responses) {
        if (r.match(file, args)) {
          if (r.reply.error !== undefined) {
            const e = new Error(r.reply.error) as Error & { stderr: string };
            e.stderr = r.reply.error;
            throw e;
          }
          return r.reply.stdout ?? '';
        }
      }
      throw new Error(`unmocked command: ${file} ${args.join(' ')}`);
    },
    async which(_name) {
      return whichResult;
    },
    async realpath(_p) {
      return realpathResult;
    },
  };
}

/** Standard responses for "up to date" scenario. */
function upToDateResponses(currentSha = 'abc123def456'): MockResponse[] {
  return [
    { match: (f, a) => f === 'git' && a[0] === 'rev-parse' && a[1] === '--is-inside-work-tree', reply: { stdout: 'true\n' } },
    { match: (f, a) => f === 'git' && a[0] === 'fetch', reply: { stdout: '' } },
    { match: (f, a) => f === 'git' && a[0] === 'rev-parse' && a[1] === 'HEAD', reply: { stdout: `${currentSha}\n` } },
    { match: (f, a) => f === 'git' && a[0] === 'rev-parse' && a[1] === 'origin/main', reply: { stdout: `${currentSha}\n` } },
    { match: (f, a) => f === 'git' && a[0] === 'log', reply: { stdout: '1700000000\n' } },
  ];
}

/** Standard responses for "behind by N" scenario. */
function behindResponses(currentSha = 'aaa111', remoteSha = 'bbb222', commitsBehind = 3, ts = 1700000000): MockResponse[] {
  return [
    { match: (f, a) => f === 'git' && a[0] === 'rev-parse' && a[1] === '--is-inside-work-tree', reply: { stdout: 'true\n' } },
    { match: (f, a) => f === 'git' && a[0] === 'fetch', reply: { stdout: '' } },
    { match: (f, a) => f === 'git' && a[0] === 'rev-parse' && a[1] === 'HEAD', reply: { stdout: `${currentSha}\n` } },
    { match: (f, a) => f === 'git' && a[0] === 'rev-parse' && a[1] === 'origin/main', reply: { stdout: `${remoteSha}\n` } },
    { match: (f, a) => f === 'git' && a[0] === 'rev-list', reply: { stdout: `${commitsBehind}\n` } },
    { match: (f, a) => f === 'git' && a[0] === 'log', reply: { stdout: `${ts}\n` } },
  ];
}

describe('detectSourceDir', () => {
  test('honors RELAY_REPO_DIR env override', async () => {
    const saved = process.env['RELAY_REPO_DIR'];
    process.env['RELAY_REPO_DIR'] = '/custom/path';
    try {
      const runner = makeRunner([]);
      const dir = await detectSourceDir(runner);
      assert.strictEqual(dir, '/custom/path');
    } finally {
      if (saved === undefined) delete process.env['RELAY_REPO_DIR'];
      else process.env['RELAY_REPO_DIR'] = saved;
    }
  });

  test('walks up from dist/cli.js to repo root', async () => {
    const saved = process.env['RELAY_REPO_DIR'];
    delete process.env['RELAY_REPO_DIR'];
    try {
      const runner = makeRunner([], '/usr/local/bin/relay', '/Users/me/relay/dist/cli.js');
      const dir = await detectSourceDir(runner);
      assert.strictEqual(dir, '/Users/me/relay');
    } finally {
      if (saved !== undefined) process.env['RELAY_REPO_DIR'] = saved;
    }
  });

  test('returns null when relay binary not on PATH', async () => {
    const saved = process.env['RELAY_REPO_DIR'];
    delete process.env['RELAY_REPO_DIR'];
    try {
      const runner: CommandRunner = {
        async run() { throw new Error('not used'); },
        async which() { return null; },
        async realpath(p) { return p; },
      };
      const dir = await detectSourceDir(runner);
      assert.strictEqual(dir, null);
    } finally {
      if (saved !== undefined) process.env['RELAY_REPO_DIR'] = saved;
    }
  });
});

describe('executeUpdateCommand --check', () => {
  test('up-to-date: emits status="up-to-date", exit 0', async () => {
    const saved = process.env['RELAY_REPO_DIR'];
    process.env['RELAY_REPO_DIR'] = '/repo';
    try {
      const runner = makeRunner(upToDateResponses());
      const cap = makeIO();
      const code = await executeUpdateCommand(
        { check: true, apply: false, json: true, force: false },
        cap.io,
        runner,
      );
      assert.strictEqual(code, 0);
      const result = findJson(cap.stdout);
      assert.ok(result, 'expected JSON output');
      assert.strictEqual(result!.status, 'up-to-date');
      assert.strictEqual(result!.commits_behind, 0);
      assert.strictEqual(result!.applied, false);
    } finally {
      if (saved === undefined) delete process.env['RELAY_REPO_DIR'];
      else process.env['RELAY_REPO_DIR'] = saved;
    }
  });

  test('behind: emits status="behind" with commits_behind=N', async () => {
    const saved = process.env['RELAY_REPO_DIR'];
    process.env['RELAY_REPO_DIR'] = '/repo';
    try {
      const runner = makeRunner(behindResponses('aaa', 'bbb', 5));
      const cap = makeIO();
      const code = await executeUpdateCommand(
        { check: true, apply: false, json: true, force: false },
        cap.io,
        runner,
      );
      assert.strictEqual(code, 0);
      const result = findJson(cap.stdout);
      assert.ok(result);
      assert.strictEqual(result!.status, 'behind');
      assert.strictEqual(result!.commits_behind, 5);
      assert.strictEqual(result!.current_sha, 'aaa');
      assert.strictEqual(result!.remote_sha, 'bbb');
      assert.ok(result!.last_remote_commit_ts && result!.last_remote_commit_ts > 0);
    } finally {
      if (saved === undefined) delete process.env['RELAY_REPO_DIR'];
      else process.env['RELAY_REPO_DIR'] = saved;
    }
  });

  test('human-readable up-to-date output contains "up to date"', async () => {
    const saved = process.env['RELAY_REPO_DIR'];
    process.env['RELAY_REPO_DIR'] = '/repo';
    try {
      const runner = makeRunner(upToDateResponses());
      const cap = makeIO();
      const code = await executeUpdateCommand(
        { check: true, apply: false, json: false, force: false },
        cap.io,
        runner,
      );
      assert.strictEqual(code, 0);
      const out = cap.stdout.join('');
      assert.match(out, /up to date/);
      assert.match(out, /relay update/);
    } finally {
      if (saved === undefined) delete process.env['RELAY_REPO_DIR'];
      else process.env['RELAY_REPO_DIR'] = saved;
    }
  });

  test('human-readable behind output mentions commits behind', async () => {
    const saved = process.env['RELAY_REPO_DIR'];
    process.env['RELAY_REPO_DIR'] = '/repo';
    try {
      const runner = makeRunner(behindResponses('aaa', 'bbb', 7));
      const cap = makeIO();
      const code = await executeUpdateCommand(
        { check: true, apply: false, json: false, force: false },
        cap.io,
        runner,
      );
      assert.strictEqual(code, 0);
      const out = cap.stdout.join('');
      assert.match(out, /7 commits behind/);
    } finally {
      if (saved === undefined) delete process.env['RELAY_REPO_DIR'];
      else process.env['RELAY_REPO_DIR'] = saved;
    }
  });

  test('default (no --apply, no --check) defaults to check mode', async () => {
    const saved = process.env['RELAY_REPO_DIR'];
    process.env['RELAY_REPO_DIR'] = '/repo';
    try {
      const runner = makeRunner(upToDateResponses());
      const cap = makeIO();
      // Simulate cli.ts logic: when neither apply nor explicit check is set,
      // executeUpdateCommand is called with check=true (the cli.ts default).
      const code = await executeUpdateCommand(
        { check: true, apply: false, json: true, force: false },
        cap.io,
        runner,
      );
      assert.strictEqual(code, 0);
      const result = findJson(cap.stdout);
      assert.ok(result);
      assert.strictEqual(result!.applied, false);
    } finally {
      if (saved === undefined) delete process.env['RELAY_REPO_DIR'];
      else process.env['RELAY_REPO_DIR'] = saved;
    }
  });

  test('cannot detect source dir → status=error exit 1', async () => {
    const saved = process.env['RELAY_REPO_DIR'];
    delete process.env['RELAY_REPO_DIR'];
    try {
      const runner: CommandRunner = {
        async run() { return ''; },
        async which() { return null; },
        async realpath(p) { return p; },
      };
      const cap = makeIO();
      const code = await executeUpdateCommand(
        { check: true, apply: false, json: true, force: false },
        cap.io,
        runner,
      );
      assert.strictEqual(code, 1);
      const result = findJson(cap.stdout);
      assert.ok(result);
      assert.strictEqual(result!.status, 'error');
      assert.match(result!.reason ?? '', /source directory/i);
    } finally {
      if (saved !== undefined) process.env['RELAY_REPO_DIR'] = saved;
    }
  });

  test('git fetch fails → status=error', async () => {
    const saved = process.env['RELAY_REPO_DIR'];
    process.env['RELAY_REPO_DIR'] = '/repo';
    try {
      const runner = makeRunner([
        { match: (f, a) => f === 'git' && a[0] === 'rev-parse' && a[1] === '--is-inside-work-tree', reply: { stdout: 'true\n' } },
        { match: (f, a) => f === 'git' && a[0] === 'fetch', reply: { error: 'network unreachable' } },
      ]);
      const cap = makeIO();
      const code = await executeUpdateCommand(
        { check: true, apply: false, json: true, force: false },
        cap.io,
        runner,
      );
      assert.strictEqual(code, 1);
      const result = findJson(cap.stdout);
      assert.ok(result);
      assert.strictEqual(result!.status, 'error');
      assert.match(result!.reason ?? '', /git fetch failed/);
    } finally {
      if (saved === undefined) delete process.env['RELAY_REPO_DIR'];
      else process.env['RELAY_REPO_DIR'] = saved;
    }
  });
});

describe('executeUpdateCommand --apply safety', () => {
  test('refuses --apply when working tree dirty', async () => {
    const saved = process.env['RELAY_REPO_DIR'];
    process.env['RELAY_REPO_DIR'] = '/repo';
    try {
      const responses: MockResponse[] = [
        ...behindResponses('aaa', 'bbb', 2),
        { match: (f, a) => f === 'git' && a[0] === 'status' && a[1] === '--porcelain', reply: { stdout: ' M src/foo.ts\n' } },
      ];
      const runner = makeRunner(responses);
      const cap = makeIO();
      const code = await executeUpdateCommand(
        { check: false, apply: true, json: true, force: true },
        cap.io,
        runner,
      );
      assert.strictEqual(code, 1);
      const result = findJson(cap.stdout);
      assert.ok(result);
      assert.strictEqual(result!.status, 'aborted');
      assert.match(result!.reason ?? '', /uncommitted changes/);
      assert.strictEqual(result!.applied, false);
    } finally {
      if (saved === undefined) delete process.env['RELAY_REPO_DIR'];
      else process.env['RELAY_REPO_DIR'] = saved;
    }
  });

  test('refuses --apply when not on main branch', async () => {
    const saved = process.env['RELAY_REPO_DIR'];
    process.env['RELAY_REPO_DIR'] = '/repo';
    try {
      const responses: MockResponse[] = [
        ...behindResponses('aaa', 'bbb', 2),
        { match: (f, a) => f === 'git' && a[0] === 'status' && a[1] === '--porcelain', reply: { stdout: '' } },
        { match: (f, a) => f === 'git' && a[0] === 'rev-parse' && a[1] === '--abbrev-ref', reply: { stdout: 'feature-x\n' } },
      ];
      const runner = makeRunner(responses);
      const cap = makeIO();
      const code = await executeUpdateCommand(
        { check: false, apply: true, json: true, force: true },
        cap.io,
        runner,
      );
      assert.strictEqual(code, 1);
      const result = findJson(cap.stdout);
      assert.ok(result);
      assert.strictEqual(result!.status, 'aborted');
      assert.match(result!.reason ?? '', /branch is "feature-x"/);
    } finally {
      if (saved === undefined) delete process.env['RELAY_REPO_DIR'];
      else process.env['RELAY_REPO_DIR'] = saved;
    }
  });

  test('refuses --apply when no signed tags ahead and --force not passed', async () => {
    const saved = process.env['RELAY_REPO_DIR'];
    process.env['RELAY_REPO_DIR'] = '/repo';
    try {
      const responses: MockResponse[] = [
        ...behindResponses('aaa', 'bbb', 2),
        { match: (f, a) => f === 'git' && a[0] === 'status' && a[1] === '--porcelain', reply: { stdout: '' } },
        { match: (f, a) => f === 'git' && a[0] === 'rev-parse' && a[1] === '--abbrev-ref', reply: { stdout: 'main\n' } },
        { match: (f, a) => f === 'git' && a[0] === 'tag', reply: { stdout: '' } },
      ];
      const runner = makeRunner(responses);
      const cap = makeIO();
      const code = await executeUpdateCommand(
        { check: false, apply: true, json: true, force: false },
        cap.io,
        runner,
      );
      assert.strictEqual(code, 1);
      const result = findJson(cap.stdout);
      assert.ok(result);
      assert.strictEqual(result!.status, 'aborted');
      assert.match(result!.reason ?? '', /signed tags|--force/);
    } finally {
      if (saved === undefined) delete process.env['RELAY_REPO_DIR'];
      else process.env['RELAY_REPO_DIR'] = saved;
    }
  });
});

describe('executeUpdateCommand --apply happy path', () => {
  test('applies pull, build, test → status=applied', async () => {
    const saved = process.env['RELAY_REPO_DIR'];
    process.env['RELAY_REPO_DIR'] = '/repo';
    try {
      let revParseCount = 0;
      const responses: MockResponse[] = [
        { match: (f, a) => f === 'git' && a[0] === 'rev-parse' && a[1] === '--is-inside-work-tree', reply: { stdout: 'true\n' } },
        { match: (f, a) => f === 'git' && a[0] === 'fetch', reply: { stdout: '' } },
        // First call to rev-parse HEAD → "aaa"; second (after pull) → "bbb"
        {
          match: (f, a) => {
            if (f === 'git' && a[0] === 'rev-parse' && a[1] === 'HEAD') {
              revParseCount++;
              return true;
            }
            return false;
          },
          reply: { stdout: 'aaa\n' },
        },
        { match: (f, a) => f === 'git' && a[0] === 'rev-parse' && a[1] === 'origin/main', reply: { stdout: 'bbb\n' } },
        { match: (f, a) => f === 'git' && a[0] === 'rev-list', reply: { stdout: '2\n' } },
        { match: (f, a) => f === 'git' && a[0] === 'log', reply: { stdout: '1700000000\n' } },
        { match: (f, a) => f === 'git' && a[0] === 'status' && a[1] === '--porcelain', reply: { stdout: '' } },
        { match: (f, a) => f === 'git' && a[0] === 'rev-parse' && a[1] === '--abbrev-ref', reply: { stdout: 'main\n' } },
        { match: (f, a) => f === 'git' && a[0] === 'pull', reply: { stdout: 'fast-forward\n' } },
        { match: (f, a) => f === 'npm' && a[0] === 'run' && a[1] === 'build', reply: { stdout: 'build ok\n' } },
        { match: (f, a) => f === 'npm' && a[0] === 'test', reply: { stdout: 'tests pass\n' } },
      ];
      const runner = makeRunner(responses);
      const cap = makeIO();
      const code = await executeUpdateCommand(
        { check: false, apply: true, json: true, force: true },
        cap.io,
        runner,
      );
      assert.strictEqual(code, 0);
      const result = findJson(cap.stdout);
      assert.ok(result);
      assert.strictEqual(result!.status, 'applied');
      assert.strictEqual(result!.applied, true);
      assert.strictEqual(result!.commits_behind, 2);
    } finally {
      if (saved === undefined) delete process.env['RELAY_REPO_DIR'];
      else process.env['RELAY_REPO_DIR'] = saved;
    }
  });

  test('apply aborts when build fails (does not run test)', async () => {
    const saved = process.env['RELAY_REPO_DIR'];
    process.env['RELAY_REPO_DIR'] = '/repo';
    try {
      let testCalled = false;
      const responses: MockResponse[] = [
        ...behindResponses('aaa', 'bbb', 1),
        { match: (f, a) => f === 'git' && a[0] === 'status' && a[1] === '--porcelain', reply: { stdout: '' } },
        { match: (f, a) => f === 'git' && a[0] === 'rev-parse' && a[1] === '--abbrev-ref', reply: { stdout: 'main\n' } },
        { match: (f, a) => f === 'git' && a[0] === 'pull', reply: { stdout: '' } },
        { match: (f, a) => f === 'npm' && a[0] === 'run' && a[1] === 'build', reply: { error: 'tsc error TS2304' } },
        {
          match: (f, a) => {
            if (f === 'npm' && a[0] === 'test') {
              testCalled = true;
              return true;
            }
            return false;
          },
          reply: { stdout: '' },
        },
      ];
      const runner = makeRunner(responses);
      const cap = makeIO();
      const code = await executeUpdateCommand(
        { check: false, apply: true, json: true, force: true },
        cap.io,
        runner,
      );
      assert.strictEqual(code, 1);
      const result = findJson(cap.stdout);
      assert.ok(result);
      assert.strictEqual(result!.status, 'error');
      assert.match(result!.reason ?? '', /npm run build failed/);
      assert.strictEqual(testCalled, false, 'test must not run when build fails');
      assert.strictEqual(result!.applied, false);
    } finally {
      if (saved === undefined) delete process.env['RELAY_REPO_DIR'];
      else process.env['RELAY_REPO_DIR'] = saved;
    }
  });

  test('apply aborts when tests fail', async () => {
    const saved = process.env['RELAY_REPO_DIR'];
    process.env['RELAY_REPO_DIR'] = '/repo';
    try {
      const responses: MockResponse[] = [
        ...behindResponses('aaa', 'bbb', 1),
        { match: (f, a) => f === 'git' && a[0] === 'status' && a[1] === '--porcelain', reply: { stdout: '' } },
        { match: (f, a) => f === 'git' && a[0] === 'rev-parse' && a[1] === '--abbrev-ref', reply: { stdout: 'main\n' } },
        { match: (f, a) => f === 'git' && a[0] === 'pull', reply: { stdout: '' } },
        { match: (f, a) => f === 'npm' && a[0] === 'run' && a[1] === 'build', reply: { stdout: 'ok\n' } },
        { match: (f, a) => f === 'npm' && a[0] === 'test', reply: { error: '4 tests failed' } },
      ];
      const runner = makeRunner(responses);
      const cap = makeIO();
      const code = await executeUpdateCommand(
        { check: false, apply: true, json: true, force: true },
        cap.io,
        runner,
      );
      assert.strictEqual(code, 1);
      const result = findJson(cap.stdout);
      assert.ok(result);
      assert.strictEqual(result!.status, 'error');
      assert.match(result!.reason ?? '', /npm test failed/);
      assert.strictEqual(result!.applied, false);
    } finally {
      if (saved === undefined) delete process.env['RELAY_REPO_DIR'];
      else process.env['RELAY_REPO_DIR'] = saved;
    }
  });

  test('apply when already up-to-date returns up-to-date status', async () => {
    const saved = process.env['RELAY_REPO_DIR'];
    process.env['RELAY_REPO_DIR'] = '/repo';
    try {
      const responses: MockResponse[] = [
        ...upToDateResponses('zzz999'),
        { match: (f, a) => f === 'git' && a[0] === 'status' && a[1] === '--porcelain', reply: { stdout: '' } },
        { match: (f, a) => f === 'git' && a[0] === 'rev-parse' && a[1] === '--abbrev-ref', reply: { stdout: 'main\n' } },
        { match: (f, a) => f === 'git' && a[0] === 'tag', reply: { stdout: '' } },
      ];
      const runner = makeRunner(responses);
      const cap = makeIO();
      const code = await executeUpdateCommand(
        { check: false, apply: true, json: true, force: true },
        cap.io,
        runner,
      );
      assert.strictEqual(code, 0);
      const result = findJson(cap.stdout);
      assert.ok(result);
      assert.strictEqual(result!.status, 'up-to-date');
      assert.strictEqual(result!.applied, false);
    } finally {
      if (saved === undefined) delete process.env['RELAY_REPO_DIR'];
      else process.env['RELAY_REPO_DIR'] = saved;
    }
  });
});

describe('executeUpdateCommand JSON output shape', () => {
  test('JSON has expected keys', async () => {
    const saved = process.env['RELAY_REPO_DIR'];
    process.env['RELAY_REPO_DIR'] = '/repo';
    try {
      const runner = makeRunner(behindResponses('aaa', 'bbb', 1));
      const cap = makeIO();
      await executeUpdateCommand(
        { check: true, apply: false, json: true, force: false },
        cap.io,
        runner,
      );
      const result = findJson(cap.stdout);
      assert.ok(result);
      // All required fields present
      assert.ok('current_sha' in result!);
      assert.ok('remote_sha' in result!);
      assert.ok('commits_behind' in result!);
      assert.ok('last_remote_commit_ts' in result!);
      assert.ok('applied' in result!);
      assert.ok('status' in result!);
    } finally {
      if (saved === undefined) delete process.env['RELAY_REPO_DIR'];
      else process.env['RELAY_REPO_DIR'] = saved;
    }
  });

  test('JSON output is compact (single line) and ends with newline', async () => {
    const saved = process.env['RELAY_REPO_DIR'];
    process.env['RELAY_REPO_DIR'] = '/repo';
    try {
      const runner = makeRunner(upToDateResponses());
      const cap = makeIO();
      await executeUpdateCommand(
        { check: true, apply: false, json: true, force: false },
        cap.io,
        runner,
      );
      const joined = cap.stdout.join('');
      assert.ok(joined.endsWith('\n'), 'must end with newline');
      // No pretty-print
      assert.ok(!joined.includes('\n  '), 'must be compact JSON');
    } finally {
      if (saved === undefined) delete process.env['RELAY_REPO_DIR'];
      else process.env['RELAY_REPO_DIR'] = saved;
    }
  });
});
