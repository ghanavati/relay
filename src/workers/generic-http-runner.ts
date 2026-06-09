import { makeError, toRelayException, type RelayError } from "../errors.js";
import type { WorkerRunner } from "./runner.js";
import type { WorkerTask, WorkerResult } from "./types.js";
import type { ProviderConfig } from "./provider-registry.js";
import {
  buildAnthropicBody,
  parseAnthropicResponse,
  type AnthropicResponseData,
} from "./anthropic.js";

/**
 * Slim HTTP runner for solo Relay.
 *
 * Posts a single request and returns the model's text. Wire shapes:
 * chat-completions (default), OpenAI Responses, and — Phase 9 — Anthropic
 * messages (anthropic-type dynamic providers, sharing anthropic.ts wire code).
 * No agentic tool-loop, no MCP attachment fetching.
 *
 * Subclasses (LmStudioRunner, OpenRouterRunner) provide endpoint + headers;
 * env-declared providers construct via runnerFromProviderConfig.
 */

export interface GenericHttpProviderConfig {
  providerName: string;
  getUrl: () => string;
  getHeaders: (model: string) => Record<string, string>;
  requiresModel: boolean;
  requestFormat?: "chat-completions" | "responses" | "anthropic-messages";
  fetchFailureMessage?: (err: unknown, url: string) => string;
  /**
   * Optional gate run before any network call (e.g. required key env var
   * missing). Returning a RelayError short-circuits run()/runMessages().
   */
  preflight?: () => RelayError | null;
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
    const preflightError = this.config.preflight?.();
    if (preflightError) {
      return {
        status: "error",
        output: "",
        duration_ms: 0,
        exit_code: null,
        error: preflightError,
      };
    }
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
    if (this.config.requestFormat === "anthropic-messages") {
      // Dynamic providers are single-shot in v1 (D-03); builtin anthropic
      // transcript continuation lives in AnthropicRunner.runMessages.
      return {
        status: "error",
        output: "",
        duration_ms: 0,
        exit_code: null,
        error: makeError(
          "UNSUPPORTED",
          `${this.config.providerName} uses the anthropic-messages request format, which has no multi-turn transcript body in this runner.`,
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
    const preflightError = this.config.preflight?.();
    if (preflightError) {
      return {
        status: "error",
        output: "",
        duration_ms: 0,
        exit_code: null,
        error: preflightError,
      };
    }
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

    if (this.config.requestFormat === "anthropic-messages") {
      // Messages wire (shared with AnthropicRunner): top-level system field,
      // single user message. contextPrefix rule matches chat-completions.
      const body = buildAnthropicBody({
        model: model ?? "",
        task: task.task,
        contextPrefix: task.contextPrefix,
      });
      return this.dispatch(body, model ?? "", task.timeout_ms);
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

      if (this.config.requestFormat === "anthropic-messages") {
        const parsed = parseAnthropicResponse(json as AnthropicResponseData);
        if (!parsed.ok) {
          return {
            status: "error",
            output: parsed.raw,
            duration_ms,
            exit_code: null,
            error: makeError(
              "PROVIDER_ERROR",
              `${this.config.providerName} response missing text content block`,
              true
            ),
          };
        }
        return {
          status: "success",
          output: parsed.output,
          duration_ms,
          exit_code: 0,
          ...extractUsageReceipt(json, "anthropic"),
        };
      }

      const output = extractOutputText(json, this.config.requestFormat);

      return {
        status: "success",
        output,
        duration_ms,
        exit_code: 0,
        ...extractUsageReceipt(json, "openai"),
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

/** Uniform usage receipt (DISPATCH-04) — raw provider numbers only. */
export interface UsageReceipt {
  token_usage: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
}

export type UsageWire = "openai" | "anthropic";

/**
 * Normalize a provider response's usage block into the uniform receipt.
 *
 * openai wire:    usage.prompt_tokens / completion_tokens / total_tokens
 *                 (token_usage prefers total, falls back to the sum)
 * anthropic wire: usage.input_tokens / output_tokens (token_usage = sum)
 *
 * Absent usage → all null. A receipt is never invented (D-05).
 */
export function extractUsageReceipt(
  json: Record<string, unknown>,
  wire: UsageWire
): UsageReceipt {
  const usage = json["usage"];
  if (typeof usage !== "object" || usage === null) {
    return { token_usage: null, prompt_tokens: null, completion_tokens: null };
  }
  const u = usage as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;

  const prompt_tokens = num(wire === "anthropic" ? u["input_tokens"] : u["prompt_tokens"]);
  const completion_tokens = num(
    wire === "anthropic" ? u["output_tokens"] : u["completion_tokens"]
  );
  const total = wire === "anthropic" ? null : num(u["total_tokens"]);
  const token_usage =
    total ??
    (prompt_tokens !== null || completion_tokens !== null
      ? (prompt_tokens ?? 0) + (completion_tokens ?? 0)
      : null);

  return { token_usage, prompt_tokens, completion_tokens };
}

/**
 * Construct a runner for an env-declared provider (DISPATCH-01).
 *
 * The key VALUE is resolved from config.keyEnvVar at request time (closures
 * over `env`), never stored on the config (T-09-01). A keyed config whose env
 * var is unset fails preflight with PROVIDER_NOT_CONFIGURED before any
 * network call; keyless configs (keyEnvVar null) send no auth header.
 */
export function runnerFromProviderConfig(
  config: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env
): GenericHttpRunner {
  const url = config.url;
  if (!url) {
    throw toRelayException(
      makeError(
        "PROVIDER_NOT_CONFIGURED",
        `provider "${config.name}" has no URL configured`,
        false
      )
    );
  }

  const resolveKey = (): string | null =>
    config.keyEnvVar ? env[config.keyEnvVar]?.trim() || null : null;

  const preflight = (): RelayError | null => {
    if (config.keyEnvVar && !resolveKey()) {
      return makeError(
        "PROVIDER_NOT_CONFIGURED",
        `${config.keyEnvVar} is not set (required for provider "${config.name}")`,
        false
      );
    }
    return null;
  };

  if (config.type === "anthropic") {
    return new GenericHttpRunner({
      providerName: config.name,
      getUrl: () => url,
      getHeaders: (_model) => {
        const key = resolveKey();
        return {
          ...(key ? { "x-api-key": key } : {}),
          "anthropic-version": "2023-06-01",
          ...config.headers,
        };
      },
      requiresModel: true,
      requestFormat: "anthropic-messages",
      preflight,
    });
  }

  return new GenericHttpRunner({
    providerName: config.name,
    getUrl: () => url,
    getHeaders: (_model) => {
      const key = resolveKey();
      return {
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...config.headers,
      };
    },
    requiresModel: true,
    requestFormat: "chat-completions",
    preflight,
  });
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
