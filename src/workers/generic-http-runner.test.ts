import { describe, test, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { GenericHttpRunner } from "./generic-http-runner.js";
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
