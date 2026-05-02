import type { WorkerTask, WorkerResult } from "./types.js";
import { makeError } from "../errors.js";
import type { WorkerRunner } from "./runner.js";

export class AnthropicRunner implements WorkerRunner {
  readonly capabilities = { agentic: false } as const;

  async run(task: WorkerTask): Promise<WorkerResult> {
    const apiKey = process.env["ANTHROPIC_API_KEY"] ?? "";
    const error = makeError("ANTHROPIC_API_KEY");

    if (!apiKey) {
      return {
        status: "error",
        output: "",
        duration_ms: 0,
        exit_code: 1,
        error: { code: "PROVIDER_NOT_CONFIGURED", message: error.message },
      };
    }

    if (!task.model) {
      return {
        status: "error",
        output: "",
        duration_ms: 0,
        exit_code: 1,
        error: { code: "INVALID_ARGS", message: "model is required" },
      };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), task.timeout_ms);

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: task.model,
          max_tokens: 4096,
          messages: [{ role: "user", content: task.task }],
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return {
          status: "error",
          output: "",
          duration_ms: 0,
          exit_code: 1,
          error: { code: "PROVIDER_ERROR", message: "Anthropic API request failed" },
        };
      }

      const data = await response.json();

      if (!data.content || data.content.length === 0) {
        return {
          status: "error",
          output: "",
          duration_ms: 0,
          exit_code: 1,
          error: { code: "PROVIDER_ERROR", message: "Invalid response from Anthropic API" },
        };
      }

      const content = data.content[0];

      if (content.type !== "text") {
        return {
          status: "error",
          output: "",
          duration_ms: 0,
          exit_code: 1,
          error: { code: "PROVIDER_ERROR", message: "Expected text content from Anthropic API" },
        };
      }

      const usage = data.usage;
      const startTime = Date.now();

      return {
        status: "success",
        output: content.text,
        duration_ms: Date.now() - startTime,
        exit_code: 0,
        token_usage: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
        prompt_tokens: usage?.input_tokens ?? 0,
        completion_tokens: usage?.output_tokens ?? 0,
      };
    } catch (err) {
      clearTimeout(timeoutId);

      if (err instanceof Error && err.name === "AbortError") {
        return {
          status: "timeout",
          output: "",
          duration_ms: task.timeout_ms,
          exit_code: 1,
          error: { code: "TIMEOUT", message: "Request timeout" },
        };
      }

      return {
        status: "error",
        output: "",
        duration_ms: 0,
        exit_code: 1,
        error: { code: "PROVIDER_ERROR", message: err instanceof Error ? err.message : "Unknown error" },
      };
    }
  }
}