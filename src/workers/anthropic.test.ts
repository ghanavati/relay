import { describe, test, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { AnthropicRunner } from "./anthropic.js";
import type { WorkerTask } from "./types.js";

/**
 * T6 — verify contextPrefix is injected as Anthropic's top-level `system`
 * field (NOT as a system-role message inside `messages`).
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
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    } as unknown as Response;
  }) as typeof fetch;
}

function makeTask(overrides: Partial<WorkerTask> = {}): WorkerTask {
  return {
    task: "do the thing",
    workdir: "/tmp",
    timeout_ms: 5_000,
    model: "claude-sonnet-test",
    run_id: "run-1",
    provider: "anthropic",
    ...overrides,
  };
}

describe("AnthropicRunner — contextPrefix injection", () => {
  let savedFetch: typeof fetch | undefined;
  let savedKey: string | undefined;
  let captured: CapturedRequest[];

  beforeEach(() => {
    savedFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    savedKey = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    captured = [];
    (globalThis as { fetch?: typeof fetch }).fetch = makeFetchStub(captured);
  });

  afterEach(() => {
    if (savedFetch) (globalThis as { fetch?: typeof fetch }).fetch = savedFetch;
    if (savedKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
    else process.env["ANTHROPIC_API_KEY"] = savedKey;
  });

  test("when contextPrefix is unset, omits top-level system field", async () => {
    const runner = new AnthropicRunner();
    const result = await runner.run(makeTask());

    assert.strictEqual(result.status, "success");
    assert.strictEqual(captured.length, 1);

    const body = captured[0]!.body;
    assert.strictEqual(body["system"], undefined);

    const messages = body["messages"] as Array<{ role: string; content: string }>;
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0]!.role, "user");
    assert.strictEqual(messages[0]!.content, "do the thing");
  });

  test("when contextPrefix is empty, omits top-level system field", async () => {
    const runner = new AnthropicRunner();
    const result = await runner.run(makeTask({ contextPrefix: "" }));

    assert.strictEqual(result.status, "success");
    const body = captured[0]!.body;
    assert.strictEqual(body["system"], undefined);
  });

  test("when contextPrefix is set, sends as top-level system field (not as message role)", async () => {
    const runner = new AnthropicRunner();
    const result = await runner.run(
      makeTask({
        task: "bare-task",
        contextPrefix: "## Recalled\n- prior lesson",
      })
    );

    assert.strictEqual(result.status, "success");

    const body = captured[0]!.body;
    assert.strictEqual(body["system"], "## Recalled\n- prior lesson");

    // Verify messages array is unchanged (single user message only).
    const messages = body["messages"] as Array<{ role: string; content: string }>;
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0]!.role, "user");
    assert.strictEqual(messages[0]!.content, "bare-task");

    // Defensive: no `system` role inside messages array.
    assert.ok(
      messages.every((m) => m.role !== "system"),
      "Anthropic must NOT use system role inside messages array"
    );
  });
});

describe("AnthropicRunner — error-path redaction (review fix 2)", () => {
  let savedFetch: typeof fetch | undefined;
  let savedKey: string | undefined;

  // Runtime-built secret — no literal credential in source.
  const leakedKey = (): string => 'sk-' + 'ant-leak0123456789abcdef012345';

  beforeEach(() => {
    savedFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    savedKey = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "test-key";
  });

  afterEach(() => {
    if (savedFetch) (globalThis as { fetch?: typeof fetch }).fetch = savedFetch;
    if (savedKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
    else process.env["ANTHROPIC_API_KEY"] = savedKey;
  });

  test("non-OK body echoing the api key is redacted in output AND error.message", async () => {
    const echoedBody = `{"error":"invalid_request","echo":{"x-api-key":"${leakedKey()}"}}`;
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => ({
      ok: false,
      status: 400,
      text: async () => echoedBody,
    })) as unknown as typeof fetch;

    const result = await new AnthropicRunner().run(makeTask());

    assert.strictEqual(result.status, "error");
    assert.ok(!result.output.includes(leakedKey()), "output must not carry the raw key");
    assert.ok(
      !result.error!.message.includes(leakedKey()),
      "error.message must not carry the raw key"
    );
    assert.match(result.error!.message, /returned 400/, "status code stays useful");
  });

  test("missing-text-block error path redacts the raw body", async () => {
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => ({
      ok: true,
      json: async () => ({ debug_echo: { "x-api-key": leakedKey() }, content: [] }),
    })) as unknown as typeof fetch;

    const result = await new AnthropicRunner().run(makeTask());

    assert.strictEqual(result.status, "error");
    assert.ok(!result.output.includes(leakedKey()), "raw error-path body must be redacted");
  });
});
