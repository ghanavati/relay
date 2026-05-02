import { getLmStudioEndpoint, getLmStudioApiKey } from "../config/providers.js";
import { GenericHttpRunner } from "./generic-http-runner.js";

function parseLmStudioMessageContent(content: unknown): string {
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
  return typeof content === "string" ? content : String(content ?? "");
}

export function parseLmStudioResponse(body: Record<string, unknown>): {
  output: string;
  token_usage: number | null;
} {
  const choices =
    (body["choices"] as Array<{ message?: { content?: unknown } }>) ?? [];
  const output = parseLmStudioMessageContent(choices[0]?.message?.content);
  const usage = body["usage"] as Record<string, number> | undefined;
  return { output, token_usage: usage?.["completion_tokens"] ?? null };
}

export class LmStudioRunner extends GenericHttpRunner {
  constructor() {
    super({
      providerName: "LM Studio",
      getUrl: () => `${getLmStudioEndpoint().replace(/\/+$/, "")}/v1/chat/completions`,
      getHeaders: (_model) => {
        const apiKey = getLmStudioApiKey();
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (apiKey) {
          headers["Authorization"] = `Bearer ${apiKey}`;
        }
        return headers;
      },
      requiresModel: true,
      fetchFailureMessage: (err, url) =>
        `LM Studio fetch failed: ${String(err)}. Is it running at ${url.replace(/\/v1\/chat\/completions$/, "")}?`,
    });
  }
}
