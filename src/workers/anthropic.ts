import type { WorkerTask, WorkerResult } from "./types.js";
import { makeError } from "../errors.js";
import type { WorkerRunner } from "./runner.js";
import type { ChatTurn, RunMessagesOptions } from "./generic-http-runner.js";

/**
 * Slim Anthropic Messages API runner. Text-only (no agentic tool-loop in v0.2).
 * For Claude with tool-use, route via OpenRouter using --model anthropic/claude-...
 */
export class AnthropicRunner implements WorkerRunner {
  readonly capabilities = { agentic: false } as const;

  /**
   * Post a full message transcript (Phase 8 / CONTROL-09). System turns map
   * to Anthropic's top-level `system` field; user/assistant turns keep their
   * order in `messages`.
   */
  async runMessages(
    messages: readonly ChatTurn[],
    opts: RunMessagesOptions
  ): Promise<WorkerResult> {
    void messages;
    void opts;
    throw new Error("not implemented (08-04 RED)");
  }

  async run(task: WorkerTask): Promise<WorkerResult> {
    const startedAt = Date.now();
    const apiKey = process.env["ANTHROPIC_API_KEY"];

    if (!apiKey) {
      return {
        status: "error",
        output: "",
        duration_ms: 0,
        exit_code: null,
        error: makeError("PROVIDER_NOT_CONFIGURED", "ANTHROPIC_API_KEY is not set", false),
      };
    }
    if (!task.model) {
      return {
        status: "error",
        output: "",
        duration_ms: 0,
        exit_code: null,
        error: makeError("INVALID_ARGS", "model is required when provider is anthropic", false),
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), task.timeout_ms);

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: task.model,
          max_tokens: 4096,
          // Anthropic Messages API uses a top-level `system` field, not a system
          // role inside `messages`. When contextPrefix is set, callers MUST pass
          // the bare task in `task.task` (NOT the concatenated finalTask).
          ...(task.contextPrefix ? { system: task.contextPrefix } : {}),
          messages: [{ role: "user", content: task.task }],
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      const duration_ms = Date.now() - startedAt;

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return {
          status: "error",
          output: text,
          duration_ms,
          exit_code: null,
          error: makeError("PROVIDER_ERROR", `Anthropic returned ${res.status}: ${text.slice(0, 500)}`, true),
        };
      }

      const data = (await res.json()) as {
        content?: Array<{ type: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };

      const block = data.content?.[0];
      if (!block || block.type !== "text" || typeof block.text !== "string") {
        return {
          status: "error",
          output: JSON.stringify(data),
          duration_ms,
          exit_code: null,
          error: makeError("PROVIDER_ERROR", "Anthropic response missing text content block", true),
        };
      }

      const inputTokens = data.usage?.input_tokens ?? 0;
      const outputTokens = data.usage?.output_tokens ?? 0;
      return {
        status: "success",
        output: block.text,
        duration_ms,
        exit_code: 0,
        token_usage: inputTokens + outputTokens,
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
      };
    } catch (err) {
      clearTimeout(timer);
      const duration_ms = Date.now() - startedAt;
      if (controller.signal.aborted) {
        return {
          status: "timeout",
          output: "",
          duration_ms,
          exit_code: null,
          error: makeError("TIMEOUT", `Anthropic request timed out after ${task.timeout_ms}ms`, true),
        };
      }
      return {
        status: "error",
        output: "",
        duration_ms,
        exit_code: null,
        error: makeError("PROVIDER_ERROR", err instanceof Error ? err.message : String(err), true),
      };
    }
  }
}
