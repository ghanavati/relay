process.env['RELAY_DB_PATH'] = ':memory:';

import { describe, test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { executeProvidersCommand, type ProviderJsonEntry } from './cmd-providers.js';
import { executeRunCommand } from './cmd-run.js';
import type { CliIO } from './commands.js';

/**
 * Phase 9 / 09-01 Task 3 — registry-resolved `relay run` + `relay providers`
 * (DISPATCH-02, DISPATCH-03).
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

const SYNTHETIC_KEY = 'sk-synthetic-never-print-12345';

describe('executeProvidersCommand — key-safe inventory (Test 4)', () => {
  function groqEnv(withKey: boolean): NodeJS.ProcessEnv {
    return {
      RELAY_PROVIDER_GROQ_URL: 'https://api.groq.com/openai/v1',
      ...(withKey ? { RELAY_PROVIDER_GROQ_KEY: SYNTHETIC_KEY } : {}),
    };
  }

  test('table lists builtin + env providers with source/type/url, codex URL is n/a', async () => {
    const { io, stdout } = makeIO();
    const code = await executeProvidersCommand({ json: false, env: groqEnv(true) }, io);
    assert.strictEqual(code, 0);
    const out = stdout.join('');
    for (const name of ['codex', 'claude', 'openrouter', 'lmstudio', 'lmstudio-agentic', 'omlx-agentic', 'anthropic', 'groq']) {
      assert.match(out, new RegExp(name), `must list ${name}`);
    }
    assert.match(out, /builtin/);
    assert.match(out, /env/);
    assert.match(out, /n\/a/, 'codex has no URL');
  });

  test('key column shows env-var name + set/unset — never a value', async () => {
    const { io, stdout } = makeIO();
    const code = await executeProvidersCommand({ json: false, env: groqEnv(true) }, io);
    assert.strictEqual(code, 0);
    const out = stdout.join('');
    assert.match(out, /RELAY_PROVIDER_GROQ_KEY/);
    assert.match(out, /\(set\)/);
    assert.ok(!out.includes(SYNTHETIC_KEY), 'key VALUE must never be printed');
  });

  test('unset builtin keys render as (unset); keyless providers as -', async () => {
    const { io, stdout } = makeIO();
    // Env with no keys at all: builtins with keyEnvVar show (unset), codex shows -.
    const code = await executeProvidersCommand({ json: false, env: groqEnv(false) }, io);
    assert.strictEqual(code, 0);
    const out = stdout.join('');
    assert.match(out, /\(unset\)/);
  });

  test('--json emits the same inventory as JSON, keys masked by construction', async () => {
    const { io, stdout } = makeIO();
    const code = await executeProvidersCommand({ json: true, env: groqEnv(true) }, io);
    assert.strictEqual(code, 0);
    const raw = stdout.join('');
    assert.ok(!raw.includes(SYNTHETIC_KEY), 'JSON must never contain a key value');
    const entries = JSON.parse(raw) as ProviderJsonEntry[];
    assert.strictEqual(entries.length, 8);
    const groq = entries.find((e) => e.name === 'groq');
    assert.ok(groq);
    assert.strictEqual(groq.source, 'env');
    assert.strictEqual(groq.type, 'openai');
    assert.strictEqual(groq.url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.strictEqual(groq.key_env_var, 'RELAY_PROVIDER_GROQ_KEY');
    assert.strictEqual(groq.key_set, true);
    const codex = entries.find((e) => e.name === 'codex');
    assert.ok(codex);
    assert.strictEqual(codex.source, 'builtin');
    assert.strictEqual(codex.url, null);
    const claude = entries.find((e) => e.name === 'claude');
    assert.ok(claude);
    assert.strictEqual(claude.source, 'builtin');
    assert.strictEqual(claude.type, 'subprocess');
    assert.strictEqual(claude.url, null);
  });
});

describe('executeProvidersCommand — URL credential redaction (review fix 1)', () => {
  // Runtime-built secrets (result.test.ts idiom) — no literal credential in source.
  const urlPassword = (): string => ['hunter', '2-url-pass'].join('');
  const urlApiKey = (): string => 'sk-' + 'urlparam0123456789abcdef0123';
  const credUrl = (): string =>
    `https://relay-user:${urlPassword()}@demo.example/v1?api_key=${urlApiKey()}`;

  function demoEnv(): NodeJS.ProcessEnv {
    return { RELAY_PROVIDER_DEMO_URL: credUrl() };
  }

  test('table never prints userinfo password or query api_key value', async () => {
    const { io, stdout } = makeIO();
    const code = await executeProvidersCommand({ json: false, env: demoEnv() }, io);
    assert.strictEqual(code, 0);
    const out = stdout.join('');
    assert.match(out, /demo/, 'the provider itself must still be listed');
    assert.ok(!out.includes(urlPassword()), 'userinfo password must never be printed');
    assert.ok(!out.includes(urlApiKey()), 'query api_key value must never be printed');
    assert.ok(!out.includes(`relay-user:${urlPassword()}`), 'userinfo must be scrubbed');
    assert.match(out, /\[REDACTED/, 'redaction placeholder must mark the scrubbed URL');
    assert.match(out, /demo\.example/, 'host stays visible so the listing is useful');
  });

  test('--json carries the redacted display URL — never raw credentials', async () => {
    const { io, stdout } = makeIO();
    const code = await executeProvidersCommand({ json: true, env: demoEnv() }, io);
    assert.strictEqual(code, 0);
    const raw = stdout.join('');
    assert.ok(!raw.includes(urlPassword()), 'JSON must never contain the userinfo password');
    assert.ok(!raw.includes(urlApiKey()), 'JSON must never contain the query api_key value');
    const entries = JSON.parse(raw) as ProviderJsonEntry[];
    const demo = entries.find((e) => e.name === 'demo');
    assert.ok(demo?.url, 'demo entry must keep a url');
    assert.match(demo.url, /\[REDACTED/);
    assert.match(demo.url, /demo\.example/, 'host preserved in the display URL');
  });
});

describe('executeProvidersCommand — builtin/env collision rendering (review fix 5)', () => {
  function collisionEnv(): NodeJS.ProcessEnv {
    return { RELAY_PROVIDER_LMSTUDIO_URL: 'http://elsewhere.example:9999' };
  }

  test('table shows the colliding env definition as an explicit CONFLICT row — exit stays 0', async () => {
    const { io, stdout } = makeIO();
    const code = await executeProvidersCommand({ json: false, env: collisionEnv() }, io);
    assert.strictEqual(code, 0, 'listing is not an error');
    const out = stdout.join('');
    assert.match(out, /CONFLICT/, 'the collision must be visible in the table');
    assert.match(out, /elsewhere\.example/, 'the conflicting URL is shown so the user sees what is ignored');
    // The builtin row survives untouched alongside the flagged env row.
    const lmstudioRows = out.split('\n').filter((l) => l.startsWith('lmstudio '));
    assert.strictEqual(lmstudioRows.length, 2, `builtin + conflict row (got: ${JSON.stringify(lmstudioRows)})`);
  });

  test('--json marks the colliding row with conflict:true; builtin row stays unflagged', async () => {
    const { io, stdout } = makeIO();
    const code = await executeProvidersCommand({ json: true, env: collisionEnv() }, io);
    assert.strictEqual(code, 0);
    const entries = JSON.parse(stdout.join('')) as ProviderJsonEntry[];
    const lmstudio = entries.filter((e) => e.name === 'lmstudio');
    assert.strictEqual(lmstudio.length, 2);
    const builtin = lmstudio.find((e) => e.source === 'builtin');
    const envRow = lmstudio.find((e) => e.source === 'env');
    assert.ok(builtin && envRow);
    assert.strictEqual(builtin.conflict, false);
    assert.strictEqual(envRow.conflict, true);
    // Every non-colliding entry is explicitly unflagged.
    for (const e of entries.filter((x) => x.name !== 'lmstudio')) {
      assert.strictEqual(e.conflict, false, `${e.name} must not be flagged`);
    }
  });
});

describe('executeProvidersCommand — collision with invalid _TYPE (Codex round 2)', () => {
  function bogusCollisionEnv(): NodeJS.ProcessEnv {
    return {
      RELAY_PROVIDER_LMSTUDIO_URL: 'http://elsewhere.example:9999',
      RELAY_PROVIDER_LMSTUDIO_TYPE: 'bogus',
    };
  }

  test('exit 0; table renders the CONFLICT row with an error note instead of crashing', async () => {
    const { io, stdout, stderr } = makeIO();
    const code = await executeProvidersCommand({ json: false, env: bogusCollisionEnv() }, io);
    assert.strictEqual(code, 0, `listing must not fail (stderr: ${stderr.join('')})`);
    const out = stdout.join('');
    assert.match(out, /CONFLICT/, 'the collision must stay visible');
    assert.match(out, /RELAY_PROVIDER_LMSTUDIO_TYPE/, 'the error note names the offending var');
    const lmstudioRows = out.split('\n').filter((l) => l.startsWith('lmstudio '));
    assert.strictEqual(lmstudioRows.length, 2, `builtin + conflict row (got: ${JSON.stringify(lmstudioRows)})`);
  });

  test('--json carries conflict:true plus the error note for the row', async () => {
    const { io, stdout } = makeIO();
    const code = await executeProvidersCommand({ json: true, env: bogusCollisionEnv() }, io);
    assert.strictEqual(code, 0);
    const entries = JSON.parse(stdout.join('')) as ProviderJsonEntry[];
    const envRow = entries.find((e) => e.name === 'lmstudio' && e.source === 'env');
    assert.ok(envRow, 'the colliding env row must be present');
    assert.strictEqual(envRow.conflict, true);
    assert.match(envRow.error ?? '', /RELAY_PROVIDER_LMSTUDIO_TYPE/);
    // Healthy rows carry an explicit null — the field is part of the schema.
    const builtin = entries.find((e) => e.name === 'lmstudio' && e.source === 'builtin');
    assert.ok(builtin);
    assert.strictEqual(builtin.error, null);
  });
});

describe('executeRunCommand — registry resolution (Tests 1-3)', () => {
  const ENV_KEYS = [
    'RELAY_PROVIDER_GROQ_URL',
    'RELAY_PROVIDER_GROQ_KEY',
    'LMSTUDIO_ENDPOINT',
    'LMSTUDIO_API_KEY',
    'OPENROUTER_API_KEY',
    'ANTHROPIC_API_KEY',
    'RELAY_CODEX_PATH',
    'RELAY_CLAUDE_PATH',
    'RELAY_AGENTIC_SANDBOX',
  ] as const;
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

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    if (savedFetch) (globalThis as { fetch?: typeof fetch }).fetch = savedFetch;
  });

  function runArgs(provider: string) {
    return {
      task: 'say hi',
      provider,
      model: 'test-model',
      workdir: '/tmp',
      timeoutMs: 5_000,
      json: true,
    };
  }

  test('Test 1: env-declared provider dispatches through GenericHttpRunner with its config', async () => {
    process.env['RELAY_PROVIDER_GROQ_URL'] = 'https://api.groq.com/openai/v1';
    process.env['RELAY_PROVIDER_GROQ_KEY'] = SYNTHETIC_KEY;
    const { io, stdout, stderr } = makeIO();
    const code = await executeRunCommand(runArgs('groq'), io);
    assert.strictEqual(code, 0, `stderr: ${stderr.join('')}`);
    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0]!.url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.strictEqual(captured[0]!.headers['Authorization'], `Bearer ${SYNTHETIC_KEY}`);
    const payload = JSON.parse(stdout.join('')) as { status: string; output: string };
    assert.strictEqual(payload.status, 'success');
    assert.strictEqual(payload.output, 'stub-ok');
  });

  test('Test 2: unknown provider exits 2 with the available-provider list', async () => {
    const { io, stderr } = makeIO();
    const code = await executeRunCommand(runArgs('nonexistent'), io);
    assert.strictEqual(code, 2);
    const err = stderr.join('');
    assert.match(err, /Available providers/);
    assert.match(err, /codex/);
    assert.match(err, /openrouter/);
  });

  test('Test 3a: lmstudio still routes to LmStudioRunner (default endpoint)', async () => {
    const { io } = makeIO();
    const code = await executeRunCommand(runArgs('lmstudio'), io);
    assert.strictEqual(code, 0);
    assert.strictEqual(captured[0]!.url, 'http://localhost:1234/v1/chat/completions');
  });

  test('Test 3b: openrouter still routes to OpenRouterRunner (key gate + endpoint)', async () => {
    process.env['OPENROUTER_API_KEY'] = SYNTHETIC_KEY;
    const { io } = makeIO();
    const code = await executeRunCommand(runArgs('openrouter'), io);
    assert.strictEqual(code, 0);
    assert.strictEqual(captured[0]!.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.strictEqual(captured[0]!.headers['Authorization'], `Bearer ${SYNTHETIC_KEY}`);
  });

  test('Test 3c: anthropic still routes to AnthropicRunner (messages wire)', async () => {
    process.env['ANTHROPIC_API_KEY'] = SYNTHETIC_KEY;
    const { io } = makeIO();
    const code = await executeRunCommand(runArgs('anthropic'), io);
    assert.strictEqual(code, 0);
    assert.strictEqual(captured[0]!.url, 'https://api.anthropic.com/v1/messages');
    assert.strictEqual(captured[0]!.headers['x-api-key'], SYNTHETIC_KEY);
  });

  test('Test 3d: codex still routes to CodexRunner (binary load path)', async () => {
    process.env['RELAY_CODEX_PATH'] = '/nonexistent/codex-binary-for-test';
    const { io, stdout, stderr } = makeIO();
    const code = await executeRunCommand({ ...runArgs('codex'), model: undefined }, io);
    assert.notStrictEqual(code, 0);
    const all = stdout.join('') + stderr.join('');
    assert.match(all, /codex/i, 'failure must come from the codex runner path');
    assert.strictEqual(captured.length, 0, 'codex is a subprocess — no HTTP dispatch');
  });

  test('Test 3d2: claude routes to ClaudeRunner (binary load path)', async () => {
    process.env['RELAY_CLAUDE_PATH'] = '/nonexistent/claude-binary-for-test';
    const { io, stdout, stderr } = makeIO();
    const code = await executeRunCommand({ ...runArgs('claude'), model: undefined }, io);
    assert.notStrictEqual(code, 0);
    const all = stdout.join('') + stderr.join('');
    assert.match(all, /claude/i, 'failure must come from the claude runner path');
    assert.strictEqual(captured.length, 0, 'claude is a subprocess — no HTTP dispatch');
  });

  test('Test 3e: lmstudio-agentic still routes to LmStudioAgenticRunner', async () => {
    const { io } = makeIO();
    await executeRunCommand(runArgs('lmstudio-agentic'), io);
    // The agentic runner probes /v1/models first, then POSTs the tool loop.
    const chatPost = captured.find((c) =>
      c.url === 'http://localhost:1234/v1/chat/completions'
    );
    assert.ok(chatPost, `agentic runner must POST to LM Studio (saw: ${captured.map((c) => c.url).join(', ')})`);
    const body = chatPost.body as { tools?: unknown[] };
    assert.ok(Array.isArray(body.tools) && body.tools.length > 0, 'agentic run offers tools');
  });
});

describe('relay --help (Test 5)', () => {
  test('contains the providers command and keeps pre-existing sections', () => {
    const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url));
    const res = spawnSync(process.execPath, [cliPath, '--help'], { encoding: 'utf8' });
    assert.strictEqual(res.status, 0);
    assert.match(res.stdout, /relay providers/);
    for (const section of ['MEMORY COMMANDS', 'DELEGATION COMMANDS', 'SESSION COMMANDS', 'relay run <task>', 'relay parallel']) {
      assert.ok(res.stdout.includes(section), `help must keep: ${section}`);
    }
  });
});
