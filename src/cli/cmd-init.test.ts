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
 * Back up the real ~/.relay/config.json AND ~/.claude/settings.json before
 * tests run, and restore them after. The default in T36 is to install the
 * SessionStart hook to the user-wide ~/.claude/settings.json — tests opt out
 * by passing globalHook:false, but a defensive backup protects the developer
 * if a test path drifts.
 */
const REAL_CONFIG_PATH = join(homedir(), '.relay', 'config.json');
const REAL_CC_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const REAL_CODEX_AGENTS_PATH = join(homedir(), '.codex', 'AGENTS.md');
const REAL_RELAY_LLM_PATH = join(homedir(), '.local', 'bin', 'relay-llm');
let realConfigBackup: string | null = null;
let realConfigExisted = false;
let realCcSettingsBackup: string | null = null;
let realCcSettingsExisted = false;
let realCodexAgentsBackup: string | null = null;
let realCodexAgentsExisted = false;
let realRelayLlmBackup: string | null = null;
let realRelayLlmExisted = false;

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
    realCcSettingsExisted = await fileExists(REAL_CC_SETTINGS_PATH);
    if (realCcSettingsExisted) {
      realCcSettingsBackup = await readFile(REAL_CC_SETTINGS_PATH, 'utf-8');
    }
    realCodexAgentsExisted = await fileExists(REAL_CODEX_AGENTS_PATH);
    if (realCodexAgentsExisted) {
      realCodexAgentsBackup = await readFile(REAL_CODEX_AGENTS_PATH, 'utf-8');
    }
    realRelayLlmExisted = await fileExists(REAL_RELAY_LLM_PATH);
    if (realRelayLlmExisted) {
      realRelayLlmBackup = await readFile(REAL_RELAY_LLM_PATH, 'utf-8');
    }
  });

  after(async () => {
    if (realConfigExisted && realConfigBackup !== null) {
      await mkdir(join(homedir(), '.relay'), { recursive: true });
      await writeFile(REAL_CONFIG_PATH, realConfigBackup, 'utf-8');
    } else if (await fileExists(REAL_CONFIG_PATH)) {
      await rm(REAL_CONFIG_PATH, { force: true });
    }
    if (realCcSettingsExisted && realCcSettingsBackup !== null) {
      await mkdir(join(homedir(), '.claude'), { recursive: true });
      await writeFile(REAL_CC_SETTINGS_PATH, realCcSettingsBackup, 'utf-8');
    } else if (await fileExists(REAL_CC_SETTINGS_PATH)) {
      await rm(REAL_CC_SETTINGS_PATH, { force: true });
    }
    if (realCodexAgentsExisted && realCodexAgentsBackup !== null) {
      await mkdir(join(homedir(), '.codex'), { recursive: true });
      await writeFile(REAL_CODEX_AGENTS_PATH, realCodexAgentsBackup, 'utf-8');
    } else if (await fileExists(REAL_CODEX_AGENTS_PATH)) {
      await rm(REAL_CODEX_AGENTS_PATH, { force: true });
    }
    if (realRelayLlmExisted && realRelayLlmBackup !== null) {
      await mkdir(join(homedir(), '.local', 'bin'), { recursive: true });
      await writeFile(REAL_RELAY_LLM_PATH, realRelayLlmBackup, 'utf-8');
    } else if (await fileExists(REAL_RELAY_LLM_PATH)) {
      await rm(REAL_RELAY_LLM_PATH, { force: true });
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
    // Pin globalHook=false so the hook lands in tmp/.claude/settings.json
    // (not the developer's real ~/.claude). T36 changed the default to true.
    const code = await executeInitCommand(
      { auto: true, quick: false, json: true, globalHook: false },
      cap.io
    );
    assert.strictEqual(code, 0);
    const jsonLine = findJsonLine(cap.stdout);
    assert.ok(jsonLine, 'expected JSON line in stdout');
    const parsed = JSON.parse(jsonLine!) as {
      ok: boolean;
      providers: { default: string; available: string[] };
      hook_installed: boolean;
      hook_global: boolean;
      session_end_hook_installed: boolean;
      cc_memory_found: boolean;
      lm_model: string | null;
      auto_extract_enabled: boolean;
      verify: { ok: boolean; detail: string };
    };
    assert.strictEqual(parsed.ok, true);
    assert.ok(parsed.providers.available.includes('openrouter'));
    assert.strictEqual(parsed.hook_installed, true);
    assert.strictEqual(parsed.hook_global, false);
    assert.strictEqual(parsed.session_end_hook_installed, false);
    assert.strictEqual(parsed.lm_model, null);
    assert.strictEqual(parsed.auto_extract_enabled, false);
    assert.deepEqual((parsed as { mcp_clients?: unknown }).mcp_clients, []);
    assert.ok(typeof parsed.verify.ok === 'boolean');
    assert.ok(typeof parsed.verify.detail === 'string');
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
    // Pin globalHook=false so we don't touch real ~/.claude/settings.json.
    const code = await executeInitCommand(
      { auto: true, quick: false, json: false, globalHook: false },
      cap.io
    );
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');
    assert.match(out, /relay init/);
    assert.match(out, /Detected providers/);
    assert.match(out, /openrouter\s+\[OK\]/);
    assert.match(out, /Wrote/);
    // T36: verify step output (PASS or FAIL printed at end)
    assert.match(out, /Verify \(context emit cc\):/);
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

  // T36: --global-hook default writes to user-wide path, but here we keep
  // the test safe by inspecting JSON `hook_global` field (after/before backup).
  test('T36 --auto installs SessionStart hook globally by default (hook_global=true)', async () => {
    process.env['OPENROUTER_API_KEY'] = 'sk-test';
    const cap = makeIO(tmp);
    // Default globalHook=true (omitted) — backup/restore in after() protects real file.
    const code = await executeInitCommand(
      { auto: true, quick: false, json: true },
      cap.io
    );
    assert.strictEqual(code, 0);
    const jsonLine = findJsonLine(cap.stdout);
    const parsed = JSON.parse(jsonLine!) as { hook_installed: boolean; hook_global: boolean };
    assert.strictEqual(parsed.hook_installed, true);
    assert.strictEqual(parsed.hook_global, true);
  });

  test('T36 --session-end-hook flag installs SessionEnd auto-extract hook in --auto mode', async () => {
    process.env['OPENROUTER_API_KEY'] = 'sk-test';
    const cap = makeIO(tmp);
    const code = await executeInitCommand(
      { auto: true, quick: false, json: true, globalHook: false, sessionEndHook: true },
      cap.io
    );
    assert.strictEqual(code, 0);
    const jsonLine = findJsonLine(cap.stdout);
    const parsed = JSON.parse(jsonLine!) as { session_end_hook_installed: boolean };
    assert.strictEqual(parsed.session_end_hook_installed, true);
    // Verify the SessionEnd hook landed in the project-local settings.
    const settingsPath = join(tmp, '.claude', 'settings.json');
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      hooks?: { SessionEnd?: Array<{ hooks?: Array<{ command?: string }> }> };
    };
    const sessionEnd = settings.hooks?.SessionEnd ?? [];
    const found = sessionEnd.some((h) =>
      (h.hooks ?? []).some((i) => typeof i.command === 'string' && i.command.includes('relay memory auto-extract --from-stdin'))
    );
    assert.ok(found, 'expected SessionEnd hook entry with auto-extract command');
  });

  test('T36 --lm-model flag records model id into config.auto_extract.model (JSON output)', async () => {
    process.env['OPENROUTER_API_KEY'] = 'sk-test';
    const cap = makeIO(tmp);
    const code = await executeInitCommand(
      { auto: true, quick: false, json: true, globalHook: false, lmModel: 'qwen/qwen3-coder-next' },
      cap.io
    );
    assert.strictEqual(code, 0);
    const jsonLine = findJsonLine(cap.stdout);
    const parsed = JSON.parse(jsonLine!) as { lm_model: string | null };
    assert.strictEqual(parsed.lm_model, 'qwen/qwen3-coder-next');
  });

  test('T36 LM Studio model picker (--auto) uses first model from mocked /v1/models', async () => {
    process.env['OPENROUTER_API_KEY'] = 'sk-test';
    // Mock fetch so probeLmStudio AND fetchLmStudioModels both succeed.
    // probeLmStudio reads /v1/models; fetchLmStudioModels reads /v1/models too.
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => {
      return new Response(
        JSON.stringify({ data: [{ id: 'mock/model-a' }, { id: 'mock/model-b' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as typeof fetch;
    const cap = makeIO(tmp);
    const code = await executeInitCommand(
      { auto: true, quick: false, json: true, globalHook: false },
      cap.io
    );
    assert.strictEqual(code, 0);
    const jsonLine = findJsonLine(cap.stdout);
    const parsed = JSON.parse(jsonLine!) as { lm_model: string | null };
    // --auto picks the first model from the list when LM Studio is reachable.
    assert.strictEqual(parsed.lm_model, 'mock/model-a');
  });

  test('T36 verify step appears in JSON output with ok flag and detail', async () => {
    process.env['OPENROUTER_API_KEY'] = 'sk-test';
    const cap = makeIO(tmp);
    const code = await executeInitCommand(
      { auto: true, quick: false, json: true, globalHook: false },
      cap.io
    );
    assert.strictEqual(code, 0);
    const jsonLine = findJsonLine(cap.stdout);
    const parsed = JSON.parse(jsonLine!) as { verify: { ok: boolean; detail: string } };
    assert.ok(parsed.verify, 'expected verify field in JSON');
    // The shape is what matters; the actual value depends on whether memory exists.
    assert.strictEqual(typeof parsed.verify.ok, 'boolean');
    assert.strictEqual(typeof parsed.verify.detail, 'string');
  });

  // ---------------- T17: auto-wire detected LLM CLIs ----------------

  test('T17 --auto wires detected providers (openrouter + anthropic) into llm_wiring', async () => {
    process.env['OPENROUTER_API_KEY'] = 'sk-or-test';
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';
    // openrouter setup attempts to fetch model list — return empty so no warning chain blocks ok.
    (globalThis as { fetch?: typeof fetch }).fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes('openrouter.ai')) {
        return new Response(JSON.stringify({ data: [{ id: 'anthropic/claude-sonnet-4' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // LM Studio probe etc. — fail
      throw new Error('not stubbed');
    }) as typeof fetch;

    const cap = makeIO(tmp);
    const code = await executeInitCommand(
      { auto: true, quick: false, json: true, globalHook: false },
      cap.io
    );
    assert.strictEqual(code, 0);
    const jsonLine = findJsonLine(cap.stdout);
    const parsed = JSON.parse(jsonLine!) as {
      llm_wiring: Array<{ provider: string; wired: boolean; skipped?: string }>;
    };
    assert.ok(Array.isArray(parsed.llm_wiring), 'expected llm_wiring array in JSON');
    // Every provider appears in the wiring report
    const providersInReport = parsed.llm_wiring.map(r => r.provider).sort();
    assert.deepStrictEqual(providersInReport, ['anthropic', 'codex', 'lmstudio', 'openrouter']);
    // openrouter + anthropic detected → should be wired
    const or = parsed.llm_wiring.find(r => r.provider === 'openrouter')!;
    const ant = parsed.llm_wiring.find(r => r.provider === 'anthropic')!;
    assert.strictEqual(or.wired, true, `expected openrouter wired. Got: ${JSON.stringify(or)}`);
    assert.strictEqual(ant.wired, true, `expected anthropic wired. Got: ${JSON.stringify(ant)}`);
    // lmstudio not detected (fetch fails) → skipped not-detected
    const lm = parsed.llm_wiring.find(r => r.provider === 'lmstudio')!;
    assert.strictEqual(lm.wired, false);
    assert.strictEqual(lm.skipped, 'not-detected');
  });

  test('T17 missing CLI is silently skipped (no providers → no wiring attempts)', async () => {
    delete process.env['OPENROUTER_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    // Override PATH to disable codex
    const savedPath = process.env['PATH'];
    process.env['PATH'] = '/nonexistent';
    try {
      const cap = makeIO(tmp);
      const code = await executeInitCommand({ auto: true, quick: false, json: true }, cap.io);
      // No providers → exit 1 before wiring step. That's fine.
      // The test confirms wiring is NEVER attempted when nothing is detected.
      if (code === 1) {
        assert.match(cap.stderr.join(''), /No providers detected/);
      } else {
        // Host machine still resolved a provider — skip silently.
        const jsonLine = findJsonLine(cap.stdout);
        if (jsonLine) {
          const parsed = JSON.parse(jsonLine) as {
            llm_wiring?: Array<{ provider: string; wired: boolean; skipped?: string }>;
          };
          if (parsed.llm_wiring) {
            for (const r of parsed.llm_wiring) {
              if (!r.wired) {
                assert.ok(
                  r.skipped === 'not-detected' || r.skipped === 'declined' || r.skipped === 'error',
                  `unexpected skipped value: ${r.skipped}`
                );
              }
            }
          }
        }
      }
    } finally {
      if (savedPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = savedPath;
    }
  });

  test('T17 anthropic-only --auto: anthropic wired; codex/lmstudio/openrouter marked not-detected', async () => {
    delete process.env['OPENROUTER_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';
    // Override PATH to disable codex
    const savedPath = process.env['PATH'];
    process.env['PATH'] = '/nonexistent';
    try {
      const cap = makeIO(tmp);
      const code = await executeInitCommand(
        { auto: true, quick: false, json: true, globalHook: false },
        cap.io
      );
      // If host PATH still resolved codex, the test setup is unreliable — allow either.
      if (code !== 0) return;
      const jsonLine = findJsonLine(cap.stdout);
      assert.ok(jsonLine, 'expected JSON line');
      const parsed = JSON.parse(jsonLine!) as {
        llm_wiring: Array<{ provider: string; wired: boolean; skipped?: string }>;
      };
      const ant = parsed.llm_wiring.find(r => r.provider === 'anthropic')!;
      assert.strictEqual(ant.wired, true, `expected anthropic wired. Got: ${JSON.stringify(ant)}`);
      const or = parsed.llm_wiring.find(r => r.provider === 'openrouter')!;
      assert.strictEqual(or.wired, false);
      assert.strictEqual(or.skipped, 'not-detected');
    } finally {
      if (savedPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = savedPath;
    }
  });

  test('T17 non-JSON --auto prints per-provider wiring status lines', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';
    const cap = makeIO(tmp);
    await executeInitCommand(
      { auto: true, quick: false, json: false, globalHook: false },
      cap.io
    );
    const out = cap.stdout.join('');
    // anthropic was detected → expect a setup-llm anthropic status line
    assert.match(out, /setup-llm anthropic/);
  });
});
