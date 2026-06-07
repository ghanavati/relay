import type { WorkerTask, WorkerResult } from "./types.js";
import { makeError } from "../errors.js";
import { getOpenRouterApiKey } from "../config/providers.js";
import { GenericHttpRunner } from "./generic-http-runner.js";

function parseOpenRouterMessageContent(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { type: "text"; text?: string } =>
          typeof block === "object" &&
          block !== null &&
          (block as { type?: unknown }).type === "text"
      )
      .map((block) => block.text ?? "")
      .join("");
  }
  return String(content ?? "");
}

export function parseOpenRouterResponse(body: Record<string, unknown>): {
  output: string;
  token_usage: number | null;
} {
  const choices = body["choices"];
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error("OpenRouter response is missing choices.");
  }
  const firstChoice = choices[0] as { message?: { content?: unknown } } | undefined;
  const output = parseOpenRouterMessageContent(firstChoice?.message?.content);
  const usage = body["usage"] as Record<string, number> | undefined;
  return { output, token_usage: usage?.["completion_tokens"] ?? null };
}

export class OpenRouterRunner extends GenericHttpRunner {
  constructor() {
    super({
      providerName: "OpenRouter",
      getUrl: () => "https://openrouter.ai/api/v1/chat/completions",
      getHeaders: (_model) => ({
        Authorization: `Bearer ${getOpenRouterApiKey() ?? ""}`,
        "Content-Type": "application/json",
      }),
      requiresModel: true,
    });
  }

  override async runMessages(
    messages: Parameters<GenericHttpRunner["runMessages"]>[0],
    opts: Parameters<GenericHttpRunner["runMessages"]>[1]
  ): Promise<WorkerResult> {
    void messages;
    void opts;
    throw new Error("not implemented (08-04 RED)");
  }

  async run(task: WorkerTask): Promise<WorkerResult> {
    const apiKey = getOpenRouterApiKey();
    if (!apiKey) {
      return {
        status: "error",
        output: "",
        duration_ms: 0,
        exit_code: null,
        error: makeError(
          "PROVIDER_NOT_CONFIGURED",
          "OPENROUTER_API_KEY is not set. Add it to your MCP config env.",
          false
        ),
      };
    }

    return super.run(task);
  }
}
