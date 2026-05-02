import { makeError } from "../errors.js";
import type { WorkerRunner } from "./runner.js";
import type { WorkerTask, WorkerResult } from "./types.js";

/**
 * Slim HTTP runner for solo Relay v0.1.0.
 *
 * Posts a single chat-completions (or OpenAI Responses) request and returns
 * the model's text. No agentic tool-loop, no MCP attachment fetching, no
 * Anthropic-specific path. The relay-mcp parent project keeps the rich version.
 *
 * Subclasses (LmStudioRunner, OpenRouterRunner) provide endpoint + headers.
 */

export interface GenericHttpProviderConfig {
  providerName: string;
  getUrl: () => string;
  getHeaders: (model: string) => Record<string, string>;
  requiresModel: boolean;
  requestFormat?: "chat-completions" | "responses";
  fetchFailureMessage?: (err: unknown, url: string) => string;
}

export class GenericHttpRunner implements WorkerRunner {
  readonly capabilities = { agentic: false } as const;

  constructor(private readonly config: GenericHttpProviderConfig) {}

  async run(task: WorkerTask): Promise<WorkerResult> {
    const startedAt = Date.now();
    const model = task.model?.trim();
    if (this.config.requiresModel && !model) {
      return {
        status: "error",
        output: "",
        duration_ms: 0,
        exit_code: null,
        error: makeError(
          "INVALID_ARGS",
          `model is required when provider is "${task.provider}".`,
          false
        ),
      };
    }

    const url = this.config.getUrl();
    const headers = this.config.getHeaders(model ?? "");

    const body =
      this.config.requestFormat === "responses"
        ? { model: model ?? "", input: task.task }
        : {
            model: model ?? "",
            messages: [{ role: "user", content: task.task }],
            stream: false,
          };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), task.timeout_ms);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const duration_ms = Date.now() - startedAt;

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return {
          status: "error",
          output: text,
          duration_ms,
          exit_code: null,
          error: makeError(
            "PROVIDER_ERROR",
            `${this.config.providerName} returned ${res.status}: ${text.slice(0, 500)}`,
            true
          ),
        };
      }

      const json = (await res.json()) as Record<string, unknown>;
      const output = extractOutputText(json, this.config.requestFormat);
      const usage = json["usage"] as Record<string, number> | undefined;

      return {
        status: "success",
        output,
        duration_ms,
        exit_code: 0,
        token_usage: usage?.["total_tokens"] ?? null,
        prompt_tokens: usage?.["prompt_tokens"] ?? null,
        completion_tokens: usage?.["completion_tokens"] ?? null,
      };
    } catch (err) {
      const duration_ms = Date.now() - startedAt;
      if (controller.signal.aborted) {
        return {
          status: "timeout",
          output: "",
          duration_ms,
          exit_code: null,
          error: makeError("TIMEOUT", `${this.config.providerName} timed out after ${task.timeout_ms}ms`, true),
        };
      }
      const message = this.config.fetchFailureMessage
        ? this.config.fetchFailureMessage(err, url)
        : `${this.config.providerName} fetch failed: ${String(err)}`;
      return {
        status: "error",
        output: "",
        duration_ms,
        exit_code: null,
        error: makeError("PROVIDER_ERROR", message, true),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function extractOutputText(
  json: Record<string, unknown>,
  format: "chat-completions" | "responses" | undefined
): string {
  if (format === "responses") {
    // OpenAI Responses API: { output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }
    const output = json["output"];
    if (Array.isArray(output)) {
      const messages = output.filter(
        (item): item is { content?: unknown } => typeof item === "object" && item !== null
      );
      const texts: string[] = [];
      for (const msg of messages) {
        const content = msg.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (
            typeof block === "object" &&
            block !== null &&
            (block as { type?: unknown }).type === "output_text" &&
            typeof (block as { text?: unknown }).text === "string"
          ) {
            texts.push((block as { text: string }).text);
          }
        }
      }
      return texts.join("");
    }
    return "";
  }

  // chat-completions: { choices: [{ message: { content: string | content[] } }] }
  const choices = json["choices"] as Array<{ message?: { content?: unknown } }> | undefined;
  if (!choices || choices.length === 0) return "";
  const content = choices[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { type: "text"; text: string } =>
          typeof block === "object" &&
          block !== null &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string"
      )
      .map((block) => block.text)
      .join("");
  }
  return "";
}
