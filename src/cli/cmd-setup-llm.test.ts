process.env['RELAY_DB_PATH'] = ':memory:';

import { test, describe, beforeEach, afterEach, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { executeSetupLlmCommand, type SetupLlmResult } from './cmd-setup-llm.js';
import type { CliIO } from './commands.js';

/**
 * NOTE on home-directory protection.
 *
 * cmd-setup-llm.ts uses `homedir()` to derive ~/.codex/AGENTS.md and
 * ~/.local/bin/relay-llm paths. We CANNOT redirect HOME safely because
 * `homedir()` is captured per-call (not at import time), but the user's real
 * home is the only thing the OS will return.
 *
 * Strategy:
 *  - For dry-run paths (no --write): we test return codes, JSON shapes, and
 *    output substrings. Nothing is written.
 *  - For --write paths: we BACK UP the real ~/.codex/AGENTS.md and
 *    ~/.local/bin/relay-llm before any test that uses --write, then RESTORE
 *    them after. The before/after hooks at the describe level handle this.
 */

interface CapturedIO {
  io: CliIO;
  stdout: string[];
  stderr: string[];
}

function makeIO(cwd = '/tmp/test-setup-llm'): CapturedIO {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { cwd, stdout: (m) => stdout.push(m), stderr: (m) => stderr.push(m) },
    stdout,
    stderr,
  };
}

function findJsonLine(stdout: string[]): string | undefined {
  return stdout
    .map((s) => s.trim())
    .reverse()
    .find((s) => s.startsWith('{') && s.endsWith('}'));
}

async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

const REAL_CODEX_AGENTS_PATH = join(homedir(), '.codex', 'AGENTS.md');
const REAL_RELAY_LLM_PATH = join(homedir(), '.local', 'bin', 'relay-llm');

let codexAgentsBackup: string | null = null;
let codexAgentsExisted = false;
let relayLlmBackup: string | null = null;
let relayLlmExisted = false;

async function snapshotHomeFiles(): Promise<void> {
  codexAgentsExisted = await fileExists(REAL_CODEX_AGENTS_PATH);
  if (codexAgentsExisted) {
    codexAgentsBackup = await readFile(REAL_CODEX_AGENTS_PATH, 'utf-8');
  }
  relayLlmExisted = await fileExists(REAL_RELAY_LLM_PATH);
  if (relayLlmExisted) {
    relayLlmBackup = await readFile(REAL_RELAY_LLM_PATH, 'utf-8');
  }
}

async function restoreHomeFiles(): Promise<void> {
  if (codexAgentsExisted && codexAgentsBackup !== null) {
    await mkdir(join(homedir(), '.codex'), { recursive: true });
    await writeFile(REAL_CODEX_AGENTS_PATH, codexAgentsBackup, 'utf-8');
  } else if (await fileExists(REAL_CODEX_AGENTS_PATH)) {
    await rm(REAL_CODEX_AGENTS_PATH, { force: true });
  }
  if (relayLlmExisted && relayLlmBackup !== null) {
    await mkdir(join(homedir(), '.local', 'bin'), { recursive: true });
    await writeFile(REAL_RELAY_LLM_PATH, relayLlmBackup, 'utf-8');
  } else if (await fileExists(REAL_RELAY_LLM_PATH)) {
    await rm(REAL_RELAY_LLM_PATH, { force: true });
  }
}

describe('executeSetupLlmCommand', () => {
  let savedFetch: typeof fetch | undefined;
  let savedOR: string | undefined;
  let savedAnth: string | undefined;
  let savedLmStudioEndpoint: string | undefined;
  let tmp: string;

  before(async () => {
    await snapshotHomeFiles();
  });

  after(async () => {
    await restoreHomeFiles();
  });

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-setup-llm-'));
    savedFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    savedOR = process.env['OPENROUTER_API_KEY'];
    savedAnth = process.env['ANTHROPIC_API_KEY'];
    savedLmStudioEndpoint = process.env['LMSTUDIO_ENDPOINT'];
    delete process.env['OPENROUTER_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    // Default fetch override: fail. Individual tests override to succeed.
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => {
      throw new Error('fetch not stubbed for this test');
    }) as typeof fetch;
  });

  afterEach(async () => {
    if (savedFetch) (globalThis as { fetch?: typeof fetch }).fetch = savedFetch;
    if (savedOR === undefined) delete process.env['OPENROUTER_API_KEY'];
    else process.env['OPENROUTER_API_KEY'] = savedOR;
    if (savedAnth === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = savedAnth;
    if (savedLmStudioEndpoint === undefined) delete process.env['LMSTUDIO_ENDPOINT'];
    else process.env['LMSTUDIO_ENDPOINT'] = savedLmStudioEndpoint;
    await rm(tmp, { recursive: true, force: true });
    // Always restore home files after each test that might have written
    await restoreHomeFiles();
  });

  // ---------------- generic dispatch ----------------

  test('unsupported target via direct call (TypeScript would catch, but runtime guard)', async () => {
    // Bypass TS to test the default branch
    const cap = makeIO(tmp);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const code = await executeSetupLlmCommand({ target: 'foo' as any, write: false, json: true }, cap.io);
    assert.strictEqual(code, 2);
    assert.match(cap.stderr.join(''), /unsupported --target/);
  });

  // ---------------- codex ----------------

  test('codex --json dry-run returns structured result with codex_auth_ok flag', async () => {
    const cap = makeIO(tmp);
    const code = await executeSetupLlmCommand({ target: 'codex', write: false, json: true }, cap.io);
    // Returns 0 for codex regardless of auth (codex setup is informational only)
    assert.strictEqual(code, 0);
    const jsonLine = findJsonLine(cap.stdout);
    assert.ok(jsonLine, 'expected JSON output');
    const parsed = JSON.parse(jsonLine!) as SetupLlmResult;
    assert.strictEqual(parsed.target, 'codex');
    assert.strictEqual(parsed.write, false);
    assert.strictEqual(typeof (parsed.details['codex_auth_ok'] as boolean), 'boolean');
    assert.ok(typeof parsed.details['agents_path'] === 'string');
  });

  test('codex dry-run human output mentions dry-run hint', async () => {
    const cap = makeIO(tmp);
    await executeSetupLlmCommand({ target: 'codex', write: false, json: false }, cap.io);
    const out = cap.stdout.join('');
    assert.match(out, /relay setup-llm codex/);
    assert.match(out, /dry-run/);
  });

  test('codex --write actually writes the relay-managed block', async () => {
    // Snapshot the real file so we can detect writes
    const before = await fileExists(REAL_CODEX_AGENTS_PATH);
    const beforeContent = before ? await readFile(REAL_CODEX_AGENTS_PATH, 'utf-8') : '';
    const cap = makeIO(tmp);
    await executeSetupLlmCommand({ target: 'codex', write: true, json: true }, cap.io);
    // After --write, file MUST exist and contain our block markers
    const exists = await fileExists(REAL_CODEX_AGENTS_PATH);
    assert.ok(exists, 'AGENTS.md should exist after --write');
    const content = await readFile(REAL_CODEX_AGENTS_PATH, 'utf-8');
    assert.match(content, /relay-managed-start/);
    assert.match(content, /relay-managed-end/);
    assert.match(content, /Relay Memory Integration/);
    // If file existed before, the prior content (outside the block) is preserved
    if (before) {
      // Verify nothing outside the block is destroyed.
      // We just check that any non-relay-managed content from `beforeContent`
      // (lines that don't include the block markers themselves) is still present.
      const beforeLines = beforeContent
        .split('\n')
        .filter(l => !l.includes('relay-managed') && !l.includes('Relay Memory Integration'));
      const nontrivialLines = beforeLines.filter(l => l.trim().length > 0).slice(0, 3);
      for (const line of nontrivialLines) {
        // Only assert preservation if line content is non-trivial and unique
        if (line.length > 20) {
          assert.ok(
            content.includes(line),
            `expected pre-existing line "${line.slice(0, 40)}..." to be preserved`
          );
        }
      }
    }
  });

  test('codex --write is idempotent — re-running does not duplicate block', async () => {
    const cap1 = makeIO(tmp);
    await executeSetupLlmCommand({ target: 'codex', write: true, json: true }, cap1.io);
    const afterFirst = await readFile(REAL_CODEX_AGENTS_PATH, 'utf-8');
    const firstStartCount = (afterFirst.match(/relay-managed-start/g) ?? []).length;

    const cap2 = makeIO(tmp);
    await executeSetupLlmCommand({ target: 'codex', write: true, json: true }, cap2.io);
    const afterSecond = await readFile(REAL_CODEX_AGENTS_PATH, 'utf-8');
    const secondStartCount = (afterSecond.match(/relay-managed-start/g) ?? []).length;

    assert.strictEqual(firstStartCount, 1, 'first write should produce exactly 1 block start marker');
    assert.strictEqual(secondStartCount, 1, 'second write should NOT duplicate the block');
  });

  // ---------------- lmstudio ----------------

  test('lmstudio dry-run with LM Studio unreachable returns failed status', async () => {
    // Default fetch override throws (set in beforeEach)
    const cap = makeIO(tmp);
    const code = await executeSetupLlmCommand({ target: 'lmstudio', write: false, json: true }, cap.io);
    assert.strictEqual(code, 1, 'unreachable LM Studio → exit 1');
    const parsed = JSON.parse(findJsonLine(cap.stdout)!) as SetupLlmResult;
    assert.strictEqual(parsed.target, 'lmstudio');
    assert.strictEqual(parsed.ok, false);
    assert.ok(parsed.warnings.length > 0, 'expected warnings about unreachable LM Studio');
  });

  test('lmstudio dry-run with mocked-OK fetch returns model list and ok status', async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'llama-3.1-8b' }, { id: 'qwen3-coder' }] }),
    } as unknown as Response)) as typeof fetch;

    const cap = makeIO(tmp);
    const code = await executeSetupLlmCommand({ target: 'lmstudio', write: false, json: true }, cap.io);
    assert.strictEqual(code, 0, 'LM Studio reachable → exit 0');
    const parsed = JSON.parse(findJsonLine(cap.stdout)!) as SetupLlmResult;
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.details['model_count'], 2);
    assert.deepStrictEqual(parsed.details['models'], ['llama-3.1-8b', 'qwen3-coder']);
    // The recommended invocation should reference the first model
    assert.ok(
      parsed.actions.some(a => a.includes('llama-3.1-8b')),
      `expected actions to mention first model. Got: ${parsed.actions.join(' | ')}`
    );
  });

  test('lmstudio dry-run mentions wrapper but does not write it', async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => ({
      ok: true,
      json: async () => ({ data: [] }),
    } as unknown as Response)) as typeof fetch;

    const wrapperBefore = await fileExists(REAL_RELAY_LLM_PATH);
    const cap = makeIO(tmp);
    await executeSetupLlmCommand({ target: 'lmstudio', write: false, json: true }, cap.io);
    const wrapperAfter = await fileExists(REAL_RELAY_LLM_PATH);
    // Dry-run must NOT install the wrapper if it didn't exist before
    if (!wrapperBefore) {
      assert.strictEqual(wrapperAfter, false, 'dry-run must NOT install wrapper');
    }
    const parsed = JSON.parse(findJsonLine(cap.stdout)!) as SetupLlmResult;
    if (!wrapperBefore) {
      assert.ok(
        parsed.actions.some(a => a.includes('would install wrapper')),
        `expected dry-run hint about wrapper. Got: ${parsed.actions.join(' | ')}`
      );
    }
  });

  test('lmstudio --write installs the wrapper script when missing', async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'm-1' }] }),
    } as unknown as Response)) as typeof fetch;

    // Remove any existing wrapper first so we test the install path
    if (await fileExists(REAL_RELAY_LLM_PATH)) {
      await rm(REAL_RELAY_LLM_PATH, { force: true });
    }
    const cap = makeIO(tmp);
    await executeSetupLlmCommand({ target: 'lmstudio', write: true, json: true }, cap.io);
    const exists = await fileExists(REAL_RELAY_LLM_PATH);
    assert.ok(exists, 'wrapper should be installed after --write');
    const content = await readFile(REAL_RELAY_LLM_PATH, 'utf-8');
    assert.match(content, /^#!\/usr\/bin\/env bash/);
    assert.match(content, /relay-llm/);
  });

  // ---------------- openrouter ----------------

  test('openrouter without API key returns failed status with setup instructions', async () => {
    delete process.env['OPENROUTER_API_KEY'];
    const cap = makeIO(tmp);
    const code = await executeSetupLlmCommand({ target: 'openrouter', write: false, json: true }, cap.io);
    assert.strictEqual(code, 1);
    const parsed = JSON.parse(findJsonLine(cap.stdout)!) as SetupLlmResult;
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.details['probe_status'], 'missing');
    assert.ok(
      parsed.actions.some(a => a.includes('OPENROUTER_API_KEY not set')),
      `expected setup instructions. Got: ${parsed.actions.join(' | ')}`
    );
  });

  test('openrouter with API key + mocked model fetch lists top models', async () => {
    process.env['OPENROUTER_API_KEY'] = 'sk-or-test';
    let observedAuthHeader = '';
    (globalThis as { fetch?: typeof fetch }).fetch = (async (input: unknown, init?: RequestInit) => {
      observedAuthHeader = String((init?.headers as Record<string, string> | undefined)?.['Authorization'] ?? '');
      const url = String(input);
      assert.match(url, /openrouter\.ai\/api\/v1\/models/);
      return {
        ok: true,
        json: async () => ({
          data: [
            { id: 'anthropic/claude-sonnet-4' },
            { id: 'openai/gpt-4o' },
            { id: 'meta-llama/llama-3.1-70b' },
          ],
        }),
      } as unknown as Response;
    }) as typeof fetch;

    const cap = makeIO(tmp);
    const code = await executeSetupLlmCommand({ target: 'openrouter', write: false, json: true }, cap.io);
    assert.strictEqual(code, 0);
    assert.match(observedAuthHeader, /Bearer sk-or-test/);
    const parsed = JSON.parse(findJsonLine(cap.stdout)!) as SetupLlmResult;
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.details['model_count'], 3);
    const top = parsed.details['top_models'] as string[];
    assert.ok(top.includes('anthropic/claude-sonnet-4'));
  });

  test('openrouter with API key but failed fetch returns warning', async () => {
    process.env['OPENROUTER_API_KEY'] = 'sk-or-test';
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    } as unknown as Response)) as typeof fetch;

    const cap = makeIO(tmp);
    const code = await executeSetupLlmCommand({ target: 'openrouter', write: false, json: true }, cap.io);
    // probe_status='ok' (env var set) → ok=true even though model list empty
    assert.strictEqual(code, 0);
    const parsed = JSON.parse(findJsonLine(cap.stdout)!) as SetupLlmResult;
    assert.strictEqual(parsed.details['model_count'], 0);
    assert.ok(parsed.warnings.length > 0);
  });

  // ---------------- anthropic ----------------

  test('anthropic without API key returns failed status with setup instructions', async () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const cap = makeIO(tmp);
    const code = await executeSetupLlmCommand({ target: 'anthropic', write: false, json: true }, cap.io);
    assert.strictEqual(code, 1);
    const parsed = JSON.parse(findJsonLine(cap.stdout)!) as SetupLlmResult;
    assert.strictEqual(parsed.ok, false);
    assert.ok(
      parsed.actions.some(a => a.includes('ANTHROPIC_API_KEY not set')),
      `expected setup instructions. Got: ${parsed.actions.join(' | ')}`
    );
  });

  test('anthropic with API key returns ok status', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';
    const cap = makeIO(tmp);
    const code = await executeSetupLlmCommand({ target: 'anthropic', write: false, json: true }, cap.io);
    assert.strictEqual(code, 0);
    const parsed = JSON.parse(findJsonLine(cap.stdout)!) as SetupLlmResult;
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.details['probe_status'], 'ok');
  });

  // ---------------- output formatting ----------------

  test('--json output ends with newline and is single-line compact JSON', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';
    const cap = makeIO(tmp);
    await executeSetupLlmCommand({ target: 'anthropic', write: false, json: true }, cap.io);
    const joined = cap.stdout.join('');
    assert.ok(joined.endsWith('\n'), 'JSON output must end with newline');
    // Compact: no pretty-print — no indented lines
    assert.ok(!joined.includes('\n  "'), 'must be compact JSON, not pretty-printed');
    const parsed = JSON.parse(joined.trim());
    assert.ok(parsed.target);
  });

  test('non-JSON anthropic missing-key output mentions setup steps', async () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const cap = makeIO(tmp);
    await executeSetupLlmCommand({ target: 'anthropic', write: false, json: false }, cap.io);
    const out = cap.stdout.join('');
    assert.match(out, /relay setup-llm anthropic/);
    assert.match(out, /ANTHROPIC_API_KEY not set/);
    assert.match(out, /console\.anthropic\.com/);
  });

  // ---------------- codex control capability discovery (Phase 8 / CONTROL-08) ----------------

  test('codex --json reports discovered control capabilities and never claims live control', async () => {
    const cap = makeIO(tmp);
    const code = await executeSetupLlmCommand({ target: 'codex', write: false, json: true }, cap.io);
    assert.strictEqual(code, 0);
    const parsed = JSON.parse(findJsonLine(cap.stdout)!) as SetupLlmResult;

    const caps = parsed.details['control_capabilities'];
    assert.ok(Array.isArray(caps), 'control_capabilities must be an array');
    assert.ok((caps as string[]).includes('register'), 'register is always discoverable');
    assert.ok(!(caps as string[]).includes('live_stdin'), 'live_stdin must never be claimed');
    assert.ok(!(caps as string[]).includes('resume_send'), 'resume_send must never be claimed');
    assert.strictEqual(typeof parsed.details['control_instructions_present'], 'boolean');
    assert.strictEqual(typeof parsed.details['control_mcp_configured'], 'boolean');
  });

  test('codex output explains the conservative control posture', async () => {
    const cap = makeIO(tmp);
    await executeSetupLlmCommand({ target: 'codex', write: false, json: true }, cap.io);
    const parsed = JSON.parse(findJsonLine(cap.stdout)!) as SetupLlmResult;
    assert.ok(
      parsed.actions.some(a => a.includes('live_stdin/resume_send are never claimed')),
      `expected conservative-control explanation in actions. Got: ${parsed.actions.join(' | ')}`
    );
  });

  test('codex --write makes context_inject discoverable (instructions block present)', async () => {
    const cap = makeIO(tmp);
    await executeSetupLlmCommand({ target: 'codex', write: true, json: true }, cap.io);
    const parsed = JSON.parse(findJsonLine(cap.stdout)!) as SetupLlmResult;
    assert.strictEqual(parsed.details['control_instructions_present'], true);
    const caps = parsed.details['control_capabilities'] as string[];
    assert.ok(caps.includes('context_inject'), 'instructions block enables context_inject');
    assert.ok(caps.includes('mailbox'), 'instructions block enables mailbox delivery');
    assert.ok(!caps.includes('live_stdin') && !caps.includes('resume_send'), 'still no live control');
  });
});
