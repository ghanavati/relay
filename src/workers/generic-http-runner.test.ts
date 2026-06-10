process.env["RELAY_DB_PATH"] = ":memory:";

import { describe, test, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import {
  GenericHttpRunner,
  runnerFromProviderConfig,
  extractUsageReceipt,
} from "./generic-http-runner.js";
import type { ProviderConfig } from "./provider-registry.js";
import { RunStore } from "../runtime/store/run-store.js";
import type { WorkerTask } from "./types.js";

/**
 * T6 — verify contextPrefix wiring.
 *
 * We intercept globalThis.fetch and snapshot the request body the runner
 * sends. We never make real HTTP calls.
 */

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

function makeFetchStub(captured: CapturedRequest[]): typeof fetch {
  return (async (input: unknown, init?: { body?: unknown }) => {
    captured.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" } }],
        usage: { total_tokens: 1, prompt_tokens: 1, completion_tokens: 0 },
      }),
    } as unknown as Response;
  }) as typeof fetch;
}

function makeTask(overrides: Partial<WorkerTask> = {}): WorkerTask {
  return {
    task: "do the thing",
    workdir: "/tmp",
    timeout_ms: 5_000,
    model: "test-model",
    run_id: "run-1",
    provider: "lmstudio",
    ...overrides,
  };
}

describe("GenericHttpRunner — contextPrefix injection (chat-completions)", () => {
  let savedFetch: typeof fetch | undefined;
  let captured: CapturedRequest[];

  beforeEach(() => {
    savedFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    captured = [];
    (globalThis as { fetch?: typeof fetch }).fetch = makeFetchStub(captured);
  });

  afterEach(() => {
    if (savedFetch) (globalThis as { fetch?: typeof fetch }).fetch = savedFetch;
  });

  test("when contextPrefix is unset, sends single user message", async () => {
    const runner = new GenericHttpRunner({
      providerName: "test",
      getUrl: () => "http://localhost:1234/v1/chat/completions",
      getHeaders: () => ({}),
      requiresModel: true,
    });

    const result = await runner.run(makeTask());
    assert.strictEqual(result.status, "success");
    assert.strictEqual(captured.length, 1);

    const messages = captured[0]!.body["messages"] as Array<{
      role: string;
      content: string;
    }>;
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0]!.role, "user");
    assert.strictEqual(messages[0]!.content, "do the thing");
  });

  test("when contextPrefix is empty string, sends single user message", async () => {
    const runner = new GenericHttpRunner({
      providerName: "test",
      getUrl: () => "http://localhost:1234/v1/chat/completions",
      getHeaders: () => ({}),
      requiresModel: true,
    });

    const result = await runner.run(makeTask({ contextPrefix: "" }));
    assert.strictEqual(result.status, "success");

    const messages = captured[0]!.body["messages"] as Array<{
      role: string;
      content: string;
    }>;
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0]!.role, "user");
  });

  test("when contextPrefix is set, prepends a system-role message", async () => {
    const runner = new GenericHttpRunner({
      providerName: "test",
      getUrl: () => "http://localhost:1234/v1/chat/completions",
      getHeaders: () => ({}),
      requiresModel: true,
    });

    const result = await runner.run(
      makeTask({
        task: "bare-task-only",
        contextPrefix: "## Recalled\n- prior lesson",
      })
    );
    assert.strictEqual(result.status, "success");

    const messages = captured[0]!.body["messages"] as Array<{
      role: string;
      content: string;
    }>;
    assert.strictEqual(messages.length, 2);
    assert.strictEqual(messages[0]!.role, "system");
    assert.strictEqual(messages[0]!.content, "## Recalled\n- prior lesson");
    assert.strictEqual(messages[1]!.role, "user");
    assert.strictEqual(messages[1]!.content, "bare-task-only");
  });
});

describe("GenericHttpRunner — contextPrefix injection (responses format)", () => {
  let savedFetch: typeof fetch | undefined;
  let captured: CapturedRequest[];

  beforeEach(() => {
    savedFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    captured = [];
    (globalThis as { fetch?: typeof fetch }).fetch = (async (
      input: unknown,
      init?: { body?: unknown }
    ) => {
      captured.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return {
        ok: true,
        json: async () => ({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "ok" }],
            },
          ],
        }),
      } as unknown as Response;
    }) as typeof fetch;
  });

  afterEach(() => {
    if (savedFetch) (globalThis as { fetch?: typeof fetch }).fetch = savedFetch;
  });

  test("when contextPrefix is unset, omits instructions field", async () => {
    const runner = new GenericHttpRunner({
      providerName: "test",
      getUrl: () => "http://localhost:1234/v1/responses",
      getHeaders: () => ({}),
      requiresModel: true,
      requestFormat: "responses",
    });

    const result = await runner.run(makeTask());
    assert.strictEqual(result.status, "success");
    assert.strictEqual(captured[0]!.body["input"], "do the thing");
    assert.strictEqual(captured[0]!.body["instructions"], undefined);
  });

  test("when contextPrefix is set, sets top-level instructions field", async () => {
    const runner = new GenericHttpRunner({
      providerName: "test",
      getUrl: () => "http://localhost:1234/v1/responses",
      getHeaders: () => ({}),
      requiresModel: true,
      requestFormat: "responses",
    });

    const result = await runner.run(
      makeTask({
        task: "bare-task",
        contextPrefix: "## Recalled\n- prior lesson",
      })
    );
    assert.strictEqual(result.status, "success");
    assert.strictEqual(captured[0]!.body["input"], "bare-task");
    assert.strictEqual(
      captured[0]!.body["instructions"],
      "## Recalled\n- prior lesson"
    );
  });
});

/**
 * Phase 9 / 09-01 Task 2 — parameterized runner from ProviderConfig +
 * uniform usage receipt (DISPATCH-01, DISPATCH-04).
 */

interface FullCapture {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function stubFetchWith(
  captured: FullCapture[],
  response: unknown
): typeof fetch {
  return (async (
    input: unknown,
    init?: { headers?: Record<string, string>; body?: unknown }
  ) => {
    captured.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return { ok: true, json: async () => response } as unknown as Response;
  }) as typeof fetch;
}

function groqConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    name: "groq",
    source: "env",
    type: "openai",
    url: "https://api.groq.com/openai/v1/chat/completions",
    keyEnvVar: "RELAY_PROVIDER_GROQ_KEY",
    headers: { "x-api-version": "2026-01" },
    agentic: false,
    ...overrides,
  };
}

describe("runnerFromProviderConfig — dynamic openai-type", () => {
  let savedFetch: typeof fetch | undefined;
  let captured: FullCapture[];

  beforeEach(() => {
    savedFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    captured = [];
  });

  afterEach(() => {
    if (savedFetch) (globalThis as { fetch?: typeof fetch }).fetch = savedFetch;
  });

  test("Test 1: POSTs to the config URL with key from keyEnvVar + extra headers, parses content", async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = stubFetchWith(captured, {
      choices: [{ message: { content: "groq says hi" } }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    });
    const runner = runnerFromProviderConfig(groqConfig(), {
      RELAY_PROVIDER_GROQ_KEY: "sk-synthetic-groq",
    });
    const result = await runner.run(makeTask({ provider: "groq" }));

    assert.strictEqual(result.status, "success");
    assert.strictEqual(result.output, "groq says hi");
    assert.strictEqual(captured.length, 1);
    assert.strictEqual(
      captured[0]!.url,
      "https://api.groq.com/openai/v1/chat/completions"
    );
    assert.strictEqual(
      captured[0]!.headers["Authorization"],
      "Bearer sk-synthetic-groq"
    );
    assert.strictEqual(captured[0]!.headers["x-api-version"], "2026-01");
  });

  test("Test 2: openai usage block maps to the uniform receipt (total present)", async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = stubFetchWith(captured, {
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    });
    const runner = runnerFromProviderConfig(groqConfig(), {
      RELAY_PROVIDER_GROQ_KEY: "sk-synthetic-groq",
    });
    const result = await runner.run(makeTask({ provider: "groq" }));

    assert.strictEqual(result.prompt_tokens, 7);
    assert.strictEqual(result.completion_tokens, 3);
    assert.strictEqual(result.token_usage, 10);
  });

  test("Test 2b: token_usage falls back to prompt+completion sum when total_tokens absent", async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = stubFetchWith(captured, {
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    });
    const runner = runnerFromProviderConfig(groqConfig(), {
      RELAY_PROVIDER_GROQ_KEY: "sk-synthetic-groq",
    });
    const result = await runner.run(makeTask({ provider: "groq" }));

    assert.strictEqual(result.token_usage, 10);
    assert.strictEqual(result.prompt_tokens, 7);
    assert.strictEqual(result.completion_tokens, 3);
  });

  test("Test 4: response with no usage block yields a null receipt — never invented", async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = stubFetchWith(captured, {
      choices: [{ message: { content: "ok" } }],
    });
    const runner = runnerFromProviderConfig(groqConfig(), {
      RELAY_PROVIDER_GROQ_KEY: "sk-synthetic-groq",
    });
    const result = await runner.run(makeTask({ provider: "groq" }));

    assert.strictEqual(result.status, "success");
    assert.strictEqual(result.token_usage, null);
    assert.strictEqual(result.prompt_tokens, null);
    assert.strictEqual(result.completion_tokens, null);
  });

  test("Test 6: missing key env var for a keyed config is a RelayError before any network call", async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = stubFetchWith(captured, {
      choices: [{ message: { content: "must never be reached" } }],
    });
    const runner = runnerFromProviderConfig(groqConfig(), {});
    const result = await runner.run(makeTask({ provider: "groq" }));

    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.error?.code, "PROVIDER_NOT_CONFIGURED");
    assert.match(result.error!.message, /RELAY_PROVIDER_GROQ_KEY/);
    assert.strictEqual(captured.length, 0, "no network call may happen");
  });

  test("Test 6b: keyless configs (keyEnvVar null) still work without Authorization", async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = stubFetchWith(captured, {
      choices: [{ message: { content: "local ok" } }],
    });
    const runner = runnerFromProviderConfig(
      groqConfig({ name: "local", keyEnvVar: null, headers: {} }),
      {}
    );
    const result = await runner.run(makeTask({ provider: "local" }));

    assert.strictEqual(result.status, "success");
    assert.strictEqual(result.output, "local ok");
    assert.strictEqual(captured[0]!.headers["Authorization"], undefined);
  });
});

describe("runnerFromProviderConfig — dynamic anthropic-type", () => {
  let savedFetch: typeof fetch | undefined;
  let captured: FullCapture[];

  beforeEach(() => {
    savedFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    captured = [];
  });

  afterEach(() => {
    if (savedFetch) (globalThis as { fetch?: typeof fetch }).fetch = savedFetch;
  });

  function claudeConfig(): ProviderConfig {
    return {
      name: "myclaude",
      source: "env",
      type: "anthropic",
      url: "https://claude-proxy.example/v1/messages",
      keyEnvVar: "RELAY_PROVIDER_MYCLAUDE_KEY",
      headers: {},
      agentic: false,
    };
  }

  test("Test 3: routes through the messages wire and maps input/output usage to the uniform receipt", async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = stubFetchWith(captured, {
      content: [{ type: "text", text: "claude says hi" }],
      usage: { input_tokens: 5, output_tokens: 2 },
    });
    const runner = runnerFromProviderConfig(claudeConfig(), {
      RELAY_PROVIDER_MYCLAUDE_KEY: "sk-synthetic-claude",
    });
    const result = await runner.run(
      makeTask({
        task: "bare-task",
        contextPrefix: "system context",
        provider: "myclaude",
      })
    );

    assert.strictEqual(result.status, "success");
    assert.strictEqual(result.output, "claude says hi");
    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0]!.url, "https://claude-proxy.example/v1/messages");
    assert.strictEqual(captured[0]!.headers["x-api-key"], "sk-synthetic-claude");
    // messages wire shape: top-level system field, single user message
    assert.strictEqual(captured[0]!.body["system"], "system context");
    const messages = captured[0]!.body["messages"] as Array<{
      role: string;
      content: string;
    }>;
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0]!.role, "user");
    assert.strictEqual(messages[0]!.content, "bare-task");
    // uniform receipt — same WorkerResult fields as the openai wire
    assert.strictEqual(result.prompt_tokens, 5);
    assert.strictEqual(result.completion_tokens, 2);
    assert.strictEqual(result.token_usage, 7);
  });

  test("Test 4b: anthropic response without usage yields a null receipt", async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = stubFetchWith(captured, {
      content: [{ type: "text", text: "ok" }],
    });
    const runner = runnerFromProviderConfig(claudeConfig(), {
      RELAY_PROVIDER_MYCLAUDE_KEY: "sk-synthetic-claude",
    });
    const result = await runner.run(makeTask({ provider: "myclaude" }));

    assert.strictEqual(result.status, "success");
    assert.strictEqual(result.token_usage, null);
    assert.strictEqual(result.prompt_tokens, null);
    assert.strictEqual(result.completion_tokens, null);
  });
});

describe("GenericHttpRunner — error-path redaction (review fix 2)", () => {
  let savedFetch: typeof fetch | undefined;

  // Runtime-built secret (result.test.ts idiom) — no literal credential in
  // source. Shaped to trip both the bearer and openai_key patterns.
  const leakedToken = (): string => 'sk-' + 'leak0123456789abcdef0123456789';
  const leakedBearer = (): string => ['Bearer', leakedToken()].join(' ');

  beforeEach(() => {
    savedFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  });

  afterEach(() => {
    if (savedFetch) (globalThis as { fetch?: typeof fetch }).fetch = savedFetch;
  });

  function makeRunner(overrides: Partial<ConstructorParameters<typeof GenericHttpRunner>[0]> = {}) {
    return new GenericHttpRunner({
      providerName: "test",
      getUrl: () => "http://localhost:9999/v1/chat/completions",
      getHeaders: () => ({}),
      requiresModel: true,
      ...overrides,
    });
  }

  test("non-OK body echoing an auth header is redacted in output AND error.message", async () => {
    const echoedBody = `{"error":"unauthorized","echo":{"Authorization":"${leakedBearer()}"}}`;
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => ({
      ok: false,
      status: 401,
      text: async () => echoedBody,
    })) as unknown as typeof fetch;

    const result = await makeRunner().run(makeTask());

    assert.strictEqual(result.status, "error");
    assert.ok(!result.output.includes(leakedToken()), "output must not carry the raw token");
    assert.match(result.output, /\[REDACTED/, "output keeps a redaction marker");
    assert.ok(
      !result.error!.message.includes(leakedToken()),
      "error.message must not carry the raw token"
    );
    assert.match(result.error!.message, /returned 401/, "status code stays useful");
  });

  test("fetch-throw message embedding a secret is redacted", async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => {
      throw new Error(`proxy refused request with header ${leakedBearer()}`);
    }) as unknown as typeof fetch;

    const result = await makeRunner().run(makeTask());

    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.error?.code, "PROVIDER_ERROR");
    assert.ok(
      !result.error.message.includes(leakedToken()),
      "fetch-failure message must not carry the raw token"
    );
    assert.match(result.error.message, /\[REDACTED/);
  });

  test("custom fetchFailureMessage output is redacted too", async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await makeRunner({
      fetchFailureMessage: (err, url) => `${url} with ${leakedBearer()} failed: ${String(err)}`,
    }).run(makeTask());

    assert.strictEqual(result.status, "error");
    assert.ok(
      !result.error!.message.includes(leakedToken()),
      "configured failure message must pass through redaction"
    );
    assert.match(result.error!.message, /ECONNREFUSED/, "the useful part survives");
  });

  test("anthropic-messages missing-text-block error path redacts the raw body", async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => ({
      ok: true,
      json: async () => ({ debug_echo: { authorization: leakedBearer() }, content: [] }),
    })) as unknown as typeof fetch;

    const result = await makeRunner({ requestFormat: "anthropic-messages" }).run(makeTask());

    assert.strictEqual(result.status, "error");
    assert.ok(!result.output.includes(leakedToken()), "raw error-path body must be redacted");
  });

  test("success-path model output stays untouched — redaction is the memory/MCP layers' job", async () => {
    const modelText = `here is your token: ${leakedBearer()}`;
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: modelText } }] }),
    })) as unknown as typeof fetch;

    const result = await makeRunner().run(makeTask());

    assert.strictEqual(result.status, "success");
    assert.strictEqual(result.output, modelText, "success output is the product — byte-identical");
  });
});

describe("extractUsageReceipt — uniform across wire shapes", () => {
  test("openai wire: prompt/completion/total", () => {
    assert.deepStrictEqual(
      extractUsageReceipt(
        { usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } },
        "openai"
      ),
      { token_usage: 10, prompt_tokens: 7, completion_tokens: 3 }
    );
  });

  test("anthropic wire: input/output mapped, token_usage = sum", () => {
    assert.deepStrictEqual(
      extractUsageReceipt(
        { usage: { input_tokens: 5, output_tokens: 2 } },
        "anthropic"
      ),
      { token_usage: 7, prompt_tokens: 5, completion_tokens: 2 }
    );
  });

  test("absent usage → all null, never invented", () => {
    assert.deepStrictEqual(extractUsageReceipt({}, "openai"), {
      token_usage: null,
      prompt_tokens: null,
      completion_tokens: null,
    });
    assert.deepStrictEqual(extractUsageReceipt({}, "anthropic"), {
      token_usage: null,
      prompt_tokens: null,
      completion_tokens: null,
    });
  });
});

describe("RunStore — usage receipt persistence (Test 5)", () => {
  test("complete() persists prompt_tokens + completion_tokens alongside token_usage", () => {
    const store = new RunStore();
    const run_id = `receipt-test-${Date.now()}-${Math.random()}`;
    store.create({
      run_id,
      provider: "groq",
      model: "test-model",
      workdir: "/tmp",
      status: "running",
      queued_at: Date.now(),
    });
    store.complete(run_id, {
      status: "success",
      started_at: Date.now(),
      finished_at: Date.now(),
      duration_ms: 5,
      exit_code: 0,
      token_usage: 10,
      prompt_tokens: 7,
      completion_tokens: 3,
    });

    const row = store.getRun(run_id);
    assert.ok(row, "run row must exist after complete()");
    assert.strictEqual(row.token_usage, 10);
    assert.strictEqual(row.prompt_tokens, 7);
    assert.strictEqual(row.completion_tokens, 3);
  });
});
