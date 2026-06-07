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

/**
 * One transcript turn for multi-turn continuation (Phase 8 / CONTROL-09).
 * Matches the OpenAI chat-completions message shape; the Anthropic runner
 * maps system turns to its top-level `system` field.
 */
export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface RunMessagesOptions {
  model: string;
  timeout_ms: number;
}

export class GenericHttpRunner implements WorkerRunner {
  readonly capabilities = { agentic: false } as const;

  constructor(private readonly config: GenericHttpProviderConfig) {}

  /**
   * Post a full message transcript (Relay-stored session continuation,
   * Phase 8 / CONTROL-09). Chat-completions only — the `responses` request
   * format has no multi-turn transcript body in this slim runner and is
   * refused with UNSUPPORTED instead of silently degrading.
   */
  async runMessages(
    messages: readonly ChatTurn[],
    opts: RunMessagesOptions
  ): Promise<WorkerResult> {
    const model = opts.model.trim();
    if (!model) {
      return {
        status: "error",
        output: "",
        duration_ms: 0,
        exit_code: null,
        error: makeError(
          "INVALID_ARGS",
          `model is required for ${this.config.providerName} transcript continuation — no hardcoded fallbacks.`,
          false
        ),
      };
    }
    if (this.config.requestFormat === "responses") {
      return {
        status: "error",
        output: "",
        duration_ms: 0,
        exit_code: null,
        error: makeError(
          "UNSUPPORTED",
          `${this.config.providerName} uses the responses request format, which has no multi-turn transcript body in this runner.`,
          false
        ),
      };
    }

    const body = {
      model,
      messages: messages.map((turn) => ({ role: turn.role, content: turn.content })),
      stream: false,
    };
    return this.dispatch(body, model, opts.timeout_ms);
  }

  async run(task: WorkerTask): Promise<WorkerResult> {
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

    // When contextPrefix is set, callers MUST pass the bare task in `task.task`
    // (NOT the concatenated finalTask) — the prefix is injected here as a
    // system-role message so it stays cache-stable across requests.
    const messages = task.contextPrefix
      ? [
          { role: "system", content: task.contextPrefix },
          { role: "user", content: task.task },
        ]
      : [{ role: "user", content: task.task }];

    const body =
      this.config.requestFormat === "responses"
        ? {
            model: model ?? "",
            input: task.task,
            ...(task.contextPrefix ? { instructions: task.contextPrefix } : {}),
          }
        : {
            model: model ?? "",
            messages,
            stream: false,
          };

    return this.dispatch(body, model ?? "", task.timeout_ms);
  }

  /** Shared POST + parse + timeout handling for run() and runMessages(). */
  private async dispatch(
    body: Record<string, unknown>,
    model: string,
    timeout_ms: number
  ): Promise<WorkerResult> {
    const startedAt = Date.now();
    const url = this.config.getUrl();
    const headers = this.config.getHeaders(model);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout_ms);

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
          error: makeError("TIMEOUT", `${this.config.providerName} timed out after ${timeout_ms}ms`, true),
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
