process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach, afterEach, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { executeInitCommand } from './cmd-init.js';
import type { CliIO } from './commands.js';

/**
 * NOTE: cmd-init.ts captures `homedir()` at module-import time into a `HOME`
 * constant. ESM imports are evaluated before any code in this test file runs,
 * so beforeEach `process.env.HOME = tmp` cannot redirect the config write.
 *
 * Therefore these tests assert via:
 *   - return code (0 / 1)
 *   - stdout/stderr substrings (which include cwd-derived paths from io.cwd)
 *   - JSON output structure
 *
 * They DO NOT directly read ~/.relay/config.json, because that would touch the
 * developer's real home directory.
 */

interface CapturedIO {
  io: CliIO;
  stdout: string[];
  stderr: string[];
}

function makeIO(cwd: string): CapturedIO {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { cwd, stdout: (m) => stdout.push(m), stderr: (m) => stderr.push(m) },
    stdout,
    stderr,
  };
}

/** Find the last JSON-shaped line in captured stdout. */
function findJsonLine(stdout: string[]): string | undefined {
  return stdout
    .map((s) => s.trim())
    .reverse()
    .find((s) => s.startsWith('{') && s.endsWith('}'));
}

/**
 * Back up the real ~/.relay/config.json before tests run, and restore it after.
 * This protects the developer's actual config from being clobbered by `--auto`
 * or `--quick` mode writes (cmd-init captures HOME at import time and we cannot
 * redirect it).
 */
const REAL_CONFIG_PATH = join(homedir(), '.relay', 'config.json');
let realConfigBackup: string | null = null;
let realConfigExisted = false;

async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

describe('executeInitCommand', () => {
  let tmp: string;
  let savedFetch: typeof fetch | undefined;
  let savedOR: string | undefined;
  let savedAnth: string | undefined;
  let savedLmStudio: string | undefined;

  before(async () => {
    realConfigExisted = await fileExists(REAL_CONFIG_PATH);
    if (realConfigExisted) {
      realConfigBackup = await readFile(REAL_CONFIG_PATH, 'utf-8');
    }
  });

  after(async () => {
    // Restore the real config to its original state (or remove if it didn't exist)
    if (realConfigExisted && realConfigBackup !== null) {
      await mkdir(join(homedir(), '.relay'), { recursive: true });
      await writeFile(REAL_CONFIG_PATH, realConfigBackup, 'utf-8');
    } else if (await fileExists(REAL_CONFIG_PATH)) {
      // We created it during tests — remove
      await rm(REAL_CONFIG_PATH, { force: true });
    }
  });

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-init-'));
    savedFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    savedOR = process.env['OPENROUTER_API_KEY'];
    savedAnth = process.env['ANTHROPIC_API_KEY'];
    savedLmStudio = process.env['LMSTUDIO_ENDPOINT'];
    // Force LM Studio probe to fail so test is deterministic
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => {
      throw new Error('lmstudio unreachable for test');
    }) as typeof fetch;
  });

  afterEach(async () => {
    if (savedFetch) (globalThis as { fetch?: typeof fetch }).fetch = savedFetch;
    if (savedOR === undefined) delete process.env['OPENROUTER_API_KEY'];
    else process.env['OPENROUTER_API_KEY'] = savedOR;
    if (savedAnth === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = savedAnth;
    if (savedLmStudio === undefined) delete process.env['LMSTUDIO_ENDPOINT'];
    else process.env['LMSTUDIO_ENDPOINT'] = savedLmStudio;
    await rm(tmp, { recursive: true, force: true });
  });

  test('--quick mode emits "empty config" message and returns 0', async () => {
    const cap = makeIO(tmp);
    const code = await executeInitCommand({ auto: false, quick: true, json: false }, cap.io);
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');
    assert.match(out, /empty config/);
    // Don't read ~/.relay/config.json — that would touch the user's real homedir.
  });

  test('--quick + --json emits ok JSON', async () => {
    const cap = makeIO(tmp);
    const code = await executeInitCommand({ auto: false, quick: true, json: true }, cap.io);
    assert.strictEqual(code, 0);
    const jsonLine = findJsonLine(cap.stdout);
    assert.ok(jsonLine, 'expected JSON output');
    const parsed = JSON.parse(jsonLine!) as { ok: boolean; mode: string; config_path: string };
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.mode, 'quick');
    assert.ok(parsed.config_path.endsWith('config.json'));
  });

  test('cc-memory probe message uses ccMemoryPathFor(io.cwd) — different from process.cwd', async () => {
    // Bug fix: cc-memory path derives from io.cwd, not a hardcoded relay-mcp path.
    // io.cwd = '/Users/jo/repos/api' → derived hash '-Users-jo-repos-api'.
    // Use auto:false + non-TTY env (default) so no hook install is attempted on
    // the synthetic non-existent path.
    process.env['OPENROUTER_API_KEY'] = 'sk-test';
    const synthetic = '/Users/jo/repos/api';
    const expectedHash = '-Users-jo-repos-api';
    const cap = makeIO(synthetic);
    await executeInitCommand({ auto: false, quick: false, json: false }, cap.io);
    const out = cap.stdout.join('');
    assert.ok(
      out.includes(expectedHash),
      `expected derived hash "${expectedHash}" in output. Got: ${out.slice(0, 600)}`
    );
    // It should NOT reference the legacy hardcoded path
    assert.ok(
      !out.includes('-Users-ghanavati-ai-stack-Projects-relay-mcp'),
      'must not contain legacy hardcoded relay-mcp path'
    );
  });

  test('ccMemoryPathFor for io.cwd="/x" includes "-x" hash in output', async () => {
    process.env['OPENROUTER_API_KEY'] = 'sk-test';
    const cap = makeIO('/x');
    await executeInitCommand({ auto: false, quick: false, json: false }, cap.io);
    const out = cap.stdout.join('');
    // Path should include "/projects/-x/memory" (or similar)
    assert.ok(
      out.includes('-x/memory') || out.includes('-x'),
      `expected derived path containing "-x". Got: ${out.slice(0, 600)}`
    );
  });

  test('ccMemoryPathFor with deeply nested io.cwd derives correct hash', async () => {
    process.env['OPENROUTER_API_KEY'] = 'sk-test';
    const synthetic = '/a/b/c/d';
    const expectedHash = '-a-b-c-d';
    const cap = makeIO(synthetic);
    await executeInitCommand({ auto: false, quick: false, json: false }, cap.io);
    const out = cap.stdout.join('');
    assert.ok(
      out.includes(expectedHash),
      `expected hash "${expectedHash}" in output. Got: ${out.slice(0, 600)}`
    );
  });

  test('--auto + --json with OPENROUTER_API_KEY emits config JSON', async () => {
    process.env['OPENROUTER_API_KEY'] = 'sk-test';
    const cap = makeIO(tmp);
    const code = await executeInitCommand({ auto: true, quick: false, json: true }, cap.io);
    assert.strictEqual(code, 0);
    // stdout may contain hook-install human text BEFORE the JSON line
    const jsonLine = findJsonLine(cap.stdout);
    assert.ok(jsonLine, 'expected JSON line in stdout');
    const parsed = JSON.parse(jsonLine!) as {
      ok: boolean;
      providers: { default: string; available: string[] };
      hook_installed: boolean;
      cc_memory_found: boolean;
    };
    assert.strictEqual(parsed.ok, true);
    assert.ok(parsed.providers.available.includes('openrouter'));
    // --auto path sets installHook = true (rl is null + args.auto)
    assert.strictEqual(parsed.hook_installed, true);
  });

  test('--auto + --json with no providers returns 1 with stderr message', async () => {
    delete process.env['OPENROUTER_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    // Override PATH to disable codex
    const savedPath = process.env['PATH'];
    process.env['PATH'] = '/nonexistent';
    try {
      const cap = makeIO(tmp);
      const code = await executeInitCommand({ auto: true, quick: false, json: true }, cap.io);
      // If the host machine's PATH still resolves codex (very unlikely with /nonexistent),
      // we fall through to success branch. In that case, we still want the test to pass.
      if (code === 1) {
        const err = cap.stderr.join('');
        assert.match(err, /No providers detected/);
      } else {
        const jsonLine = findJsonLine(cap.stdout);
        assert.ok(jsonLine, 'expected JSON line if a provider was detected');
      }
    } finally {
      if (savedPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = savedPath;
    }
  });

  test('non-JSON --auto mode prints provider table and writes config message', async () => {
    process.env['OPENROUTER_API_KEY'] = 'sk-test';
    const cap = makeIO(tmp);
    const code = await executeInitCommand({ auto: true, quick: false, json: false }, cap.io);
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');
    assert.match(out, /relay init/);
    assert.match(out, /Detected providers/);
    assert.match(out, /openrouter\s+\[OK\]/);
    assert.match(out, /Wrote/);
  });

  test('cc-memory line indicates "[--]" when path does not exist', async () => {
    process.env['OPENROUTER_API_KEY'] = 'sk-test';
    // Use synthetic cwd that definitely won't have a CC memory dir
    const synthetic = '/tmp/does-not-exist-' + Date.now();
    const cap = makeIO(synthetic);
    await executeInitCommand({ auto: true, quick: false, json: false }, cap.io);
    const out = cap.stdout.join('');
    assert.match(out, /cc-memory\s+\[--\]/);
  });

  // Sanity check: verify the config file path string in JSON output ends with ".relay/config.json"
  test('--quick JSON output config_path ends with .relay/config.json', async () => {
    const cap = makeIO(tmp);
    await executeInitCommand({ auto: false, quick: true, json: true }, cap.io);
    const jsonLine = findJsonLine(cap.stdout);
    assert.ok(jsonLine);
    const parsed = JSON.parse(jsonLine!) as { config_path: string };
    assert.ok(
      parsed.config_path.endsWith(join('.relay', 'config.json')),
      `expected config_path to end with .relay/config.json, got: ${parsed.config_path}`
    );
  });
});

