process.env['RELAY_DB_PATH'] = ':memory:';

import { describe, test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeParallelCommand } from './cmd-parallel.js';
import { runnerForProvider } from './runner-factory.js';
import { resolveProvider, type ProviderConfig } from '../workers/provider-registry.js';
import { AGENTIC_SANDBOX_ENV } from '../security/env-sanitize.js';
import { RunStore } from '../runtime/store/run-store.js';
import { CodexRunner } from '../workers/codex.js';
import { ClaudeRunner } from '../workers/claude.js';
import { LmStudioRunner } from '../workers/lmstudio.js';
import { OpenRouterRunner } from '../workers/openrouter.js';
import { AnthropicRunner } from '../workers/anthropic.js';
import { DEFAULT_AGENTIC_TOOLS, LmStudioAgenticRunner } from '../workers/lmstudio-agentic.js';
import { GenericHttpRunner } from '../workers/generic-http-runner.js';
import type { CliIO } from './commands.js';

/**
 * Phase 9 / 09-01 follow-up — `relay parallel` resolves spec providers
 * through the provider registry (no private closed union) and constructs
 * runners via the shared factory.
 */

interface CapturedIO {
  io: CliIO;
  stdout: string[];
  stderr: string[];
}

function makeIO(): CapturedIO {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { cwd: '/tmp', stdout: (m) => stdout.push(m), stderr: (m) => stderr.push(m) },
    stdout,
    stderr,
  };
}

interface ParallelRunJson {
  run_id: string;
  status: string;
  duration_ms?: number;
  output?: string;
  error?: string;
  provider: string;
  model: string | null;
}

interface ParallelJson {
  runs: ParallelRunJson[];
  summary: { success: number; error: number; timeout: number; total: number };
}

const SYNTHETIC_KEY = 'sk-synthetic-never-print-12345';

const tmpDirs: string[] = [];

async function writeSpec(tasks: Array<Record<string, unknown>>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'relay-cmd-parallel-test-'));
  tmpDirs.push(dir);
  const specPath = join(dir, 'spec.json');
  await writeFile(specPath, JSON.stringify({ tasks }), 'utf-8');
  return specPath;
}

describe('executeParallelCommand — registry-resolved spec providers', () => {
  const ENV_KEYS: string[] = [
    'RELAY_PROVIDER_GROQ_URL',
    'RELAY_PROVIDER_GROQ_KEY',
    'LMSTUDIO_ENDPOINT',
    'LMSTUDIO_API_KEY',
    'OPENROUTER_API_KEY',
    'ANTHROPIC_API_KEY',
    'RELAY_CODEX_PATH',
    AGENTIC_SANDBOX_ENV,
  ];
  let savedEnv: Record<string, string | undefined>;
  let savedFetch: typeof fetch | undefined;
  let captured: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }>;

  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    savedFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    captured = [];
    (globalThis as { fetch?: typeof fetch }).fetch = (async (
      input: unknown,
      init?: { headers?: Record<string, string>; body?: unknown }
    ) => {
      const url = String(input);
      captured.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body ?? '{}')),
      });
      // lmstudio-agentic probes /v1/models (and /api/v0/models) for the
      // model's tool_use capability before the chat POST — answer it.
      if (url.includes('/models')) {
        return {
          ok: true,
          json: async () => ({
            data: [{ id: 'test-model', capabilities: ['tool_use'] }],
          }),
        } as unknown as Response;
      }
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 'stub-ok' }, finish_reason: 'stop' }],
          content: [{ type: 'text', text: 'stub-ok' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, input_tokens: 1, output_tokens: 1 },
        }),
      } as unknown as Response;
    }) as typeof fetch;
  });

  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    if (savedFetch) (globalThis as { fetch?: typeof fetch }).fetch = savedFetch;
    for (const dir of tmpDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('(a) env-declared provider is accepted and dispatches through the shared factory', async () => {
    process.env['RELAY_PROVIDER_GROQ_URL'] = 'https://api.groq.com/openai/v1';
    process.env['RELAY_PROVIDER_GROQ_KEY'] = SYNTHETIC_KEY;
    const specPath = await writeSpec([
      { task: 'say hi from groq', provider: 'groq', model: 'test-model' },
      { task: 'say hi from lmstudio', provider: 'lmstudio', model: 'test-model' },
    ]);
    const { io, stdout, stderr } = makeIO();
    const code = await executeParallelCommand({ specPath, maxConcurrency: 2, json: true }, io);
    assert.strictEqual(code, 0, `stderr: ${stderr.join('')}`);

    const groqPost = captured.find((c) => c.url === 'https://api.groq.com/openai/v1/chat/completions');
    assert.ok(groqPost, `groq dispatch must hit its derived URL (saw: ${captured.map((c) => c.url).join(', ')})`);
    assert.strictEqual(groqPost.headers['Authorization'], `Bearer ${SYNTHETIC_KEY}`);

    const payload = JSON.parse(stdout.join('')) as ParallelJson;
    assert.strictEqual(payload.summary.total, 2);
    assert.strictEqual(payload.summary.success, 2);
    assert.strictEqual(payload.runs[0]!.provider, 'groq');
    assert.strictEqual(payload.runs[0]!.status, 'success');
    assert.strictEqual(payload.runs[0]!.output, 'stub-ok');

    // Run-store record fields preserved (provider/model/status).
    const store = new RunStore();
    const groqRow = store.getRun(payload.runs[0]!.run_id);
    assert.ok(groqRow);
    assert.strictEqual(groqRow.provider, 'groq');
    assert.strictEqual(groqRow.model, 'test-model');
    assert.strictEqual(groqRow.status, 'success');

    // Non-agentic spec must not mark the process as an agentic sandbox.
    assert.strictEqual(process.env[AGENTIC_SANDBOX_ENV], undefined);
  });

  test('(a2) run row carries the full uniform usage receipt — token_usage + prompt/completion (review fix 3)', async () => {
    // The fetch stub answers with usage { prompt_tokens: 1, completion_tokens: 1,
    // total_tokens: 2 }; the run record must persist all three receipt fields,
    // matching cmd-run's uniform receipt (DISPATCH-04).
    const specPath = await writeSpec([{ task: 'receipt check', provider: 'lmstudio', model: 'test-model' }]);
    const { io, stdout, stderr } = makeIO();
    const code = await executeParallelCommand({ specPath, maxConcurrency: 1, json: true }, io);
    assert.strictEqual(code, 0, `stderr: ${stderr.join('')}`);

    const payload = JSON.parse(stdout.join('')) as ParallelJson;
    const store = new RunStore();
    const row = store.getRun(payload.runs[0]!.run_id);
    assert.ok(row);
    assert.strictEqual(row.token_usage, 2);
    assert.strictEqual(row.prompt_tokens, 1);
    assert.strictEqual(row.completion_tokens, 1);
  });

  test('(b) unknown provider exits 2 with the registry available-provider list, before any dispatch', async () => {
    process.env['RELAY_PROVIDER_GROQ_URL'] = 'https://api.groq.com/openai/v1';
    const specPath = await writeSpec([
      { task: 'valid task', provider: 'nonexistent', model: 'test-model' },
    ]);
    const { io, stderr } = makeIO();
    const code = await executeParallelCommand({ specPath, maxConcurrency: 2, json: true }, io);
    assert.strictEqual(code, 2);
    const err = stderr.join('');
    assert.match(err, /task\[0\]/);
    assert.match(err, /unknown provider "nonexistent"/);
    assert.match(err, /Available providers/);
    assert.match(err, /codex/);
    assert.match(err, /lmstudio-agentic/);
    assert.match(err, /groq/, 'env-discovered providers must appear in the available list');
    assert.strictEqual(captured.length, 0, 'validation must fail before any dispatch');
  });

  test('(c1) builtin parity: lmstudio still routes to LmStudioRunner (default endpoint wire)', async () => {
    const specPath = await writeSpec([{ task: 'hi', provider: 'lmstudio', model: 'test-model' }]);
    const { io, stderr } = makeIO();
    const code = await executeParallelCommand({ specPath, maxConcurrency: 1, json: true }, io);
    assert.strictEqual(code, 0, `stderr: ${stderr.join('')}`);
    assert.strictEqual(captured[0]!.url, 'http://localhost:1234/v1/chat/completions');
  });

  test('(c2) builtin parity: openrouter still routes to OpenRouterRunner (endpoint + bearer key)', async () => {
    process.env['OPENROUTER_API_KEY'] = SYNTHETIC_KEY;
    const specPath = await writeSpec([{ task: 'hi', provider: 'openrouter', model: 'test-model' }]);
    const { io, stderr } = makeIO();
    const code = await executeParallelCommand({ specPath, maxConcurrency: 1, json: true }, io);
    assert.strictEqual(code, 0, `stderr: ${stderr.join('')}`);
    assert.strictEqual(captured[0]!.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.strictEqual(captured[0]!.headers['Authorization'], `Bearer ${SYNTHETIC_KEY}`);
  });

  test('(c3) builtin parity: anthropic still routes to AnthropicRunner (messages wire)', async () => {
    process.env['ANTHROPIC_API_KEY'] = SYNTHETIC_KEY;
    const specPath = await writeSpec([{ task: 'hi', provider: 'anthropic', model: 'test-model' }]);
    const { io, stderr } = makeIO();
    const code = await executeParallelCommand({ specPath, maxConcurrency: 1, json: true }, io);
    assert.strictEqual(code, 0, `stderr: ${stderr.join('')}`);
    assert.strictEqual(captured[0]!.url, 'https://api.anthropic.com/v1/messages');
    assert.strictEqual(captured[0]!.headers['x-api-key'], SYNTHETIC_KEY);
  });

  test('(c4+d) builtin parity: codex needs no model (subprocess type), no HTTP dispatch, fails at binary not validation', async () => {
    process.env['RELAY_CODEX_PATH'] = '/nonexistent/codex-binary-for-test';
    const specPath = await writeSpec([
      { task: 'run via codex', provider: 'codex', timeout_ms: 5000 },
    ]);
    const { io, stdout, stderr } = makeIO();
    const code = await executeParallelCommand({ specPath, maxConcurrency: 1, json: true }, io);
    const err = stderr.join('');
    assert.ok(!/model required/.test(err), `codex must pass validation without model (stderr: ${err})`);
    assert.strictEqual(code, 1, 'failure at the binary is a run error (1), not a validation error (2)');
    assert.strictEqual(captured.length, 0, 'codex is a subprocess — no HTTP dispatch');
    const payload = JSON.parse(stdout.join('')) as ParallelJson;
    assert.strictEqual(payload.runs[0]!.status, 'error');
    assert.strictEqual(payload.summary.error, 1);
  });

  test('(d1) builtin HTTP provider without model is rejected — byte-identical message', async () => {
    const specPath = await writeSpec([{ task: 'hi', provider: 'lmstudio' }]);
    const { io, stderr } = makeIO();
    const code = await executeParallelCommand({ specPath, maxConcurrency: 1, json: true }, io);
    assert.strictEqual(code, 2);
    assert.strictEqual(stderr.join(''), 'task[0].model required for provider=lmstudio\n');
  });

  test('(d2) env HTTP provider without model is rejected — gate derives from ProviderConfig.type', async () => {
    process.env['RELAY_PROVIDER_GROQ_URL'] = 'https://api.groq.com/openai/v1';
    const specPath = await writeSpec([{ task: 'hi', provider: 'groq' }]);
    const { io, stderr } = makeIO();
    const code = await executeParallelCommand({ specPath, maxConcurrency: 1, json: true }, io);
    assert.strictEqual(code, 2);
    assert.strictEqual(stderr.join(''), 'task[0].model required for provider=groq\n');
  });

  test('(e) lmstudio-agentic still wires DEFAULT_AGENTIC_TOOLS and sets the agentic sandbox marker', async () => {
    const specPath = await writeSpec([
      { task: 'do agentic things', provider: 'lmstudio-agentic', model: 'test-model' },
    ]);
    const { io, stderr } = makeIO();
    const code = await executeParallelCommand({ specPath, maxConcurrency: 1, json: true }, io);
    assert.strictEqual(code, 0, `stderr: ${stderr.join('')}`);
    assert.strictEqual(process.env[AGENTIC_SANDBOX_ENV], '1', 'agentic spec must mark the process as a sandbox');

    const chatPost = captured.find((c) => c.url === 'http://localhost:1234/v1/chat/completions');
    assert.ok(chatPost, `agentic runner must POST to LM Studio (saw: ${captured.map((c) => c.url).join(', ')})`);
    const tools = (chatPost.body as { tools?: Array<{ function?: { name?: string } }> }).tools ?? [];
    const names = tools.map((t) => t.function?.name);
    for (const def of DEFAULT_AGENTIC_TOOLS) {
      assert.ok(names.includes(def.function.name), `default agentic tool ${def.function.name} must be offered`);
    }
    // cmd-parallel wires Figma (env-gated) but NOT the run-bound relay_*
    // control tools — that wiring is cmd-run-only. Guard the divergence.
    assert.ok(
      !names.some((n) => n?.startsWith('relay_')),
      `parallel dispatch must not offer relay_* control tools (saw: ${names.join(', ')})`
    );
  });
});

describe('runnerForProvider — shared 09-01 factory', () => {
  test('builtin parity: builtin names construct their existing runner classes', async () => {
    assert.ok((await runnerForProvider(resolveProvider('codex', {}))) instanceof CodexRunner);
    assert.ok((await runnerForProvider(resolveProvider('claude', {}))) instanceof ClaudeRunner);
    assert.ok((await runnerForProvider(resolveProvider('lmstudio', {}))) instanceof LmStudioRunner);
    assert.ok((await runnerForProvider(resolveProvider('openrouter', {}))) instanceof OpenRouterRunner);
    assert.ok((await runnerForProvider(resolveProvider('anthropic', {}))) instanceof AnthropicRunner);
    assert.ok(
      (await runnerForProvider(resolveProvider('lmstudio-agentic', {}))) instanceof LmStudioAgenticRunner
    );
  });

  test('env-sourced config constructs the parameterized GenericHttpRunner', async () => {
    const config = resolveProvider('groq', {
      RELAY_PROVIDER_GROQ_URL: 'https://api.groq.com/openai/v1',
    });
    assert.strictEqual(config.source, 'env');
    assert.ok((await runnerForProvider(config)) instanceof GenericHttpRunner);
  });

  test('unknown builtin-source name fails loudly (registry/factory drift guard)', async () => {
    const bogus: ProviderConfig = {
      name: 'bogus',
      source: 'builtin',
      type: 'openai',
      url: null,
      keyEnvVar: null,
      headers: {},
      agentic: false,
    };
    await assert.rejects(runnerForProvider(bogus), /unsupported provider/);
  });
});
