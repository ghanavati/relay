export interface ProviderDefinition {
  name: string;
  agentic: boolean;
}

export type DynamicProviderType = "openai" | "openai-responses" | "anthropic";

export const BUILTIN_PROVIDERS: readonly ProviderDefinition[] = [
  { name: "codex", agentic: true },
  { name: "openrouter", agentic: true },
  { name: "lmstudio", agentic: true },
  { name: "anthropic", agentic: true },
  // R-22 — Hybrid Model Adapters: process provider for non-LLM execution (Rscript, Python scripts, etc.)
  { name: "process", agentic: false },
];

export const DEFAULT_PROVIDER = "codex";

export function getDynamicProviderNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const names = new Set<string>();
  for (const key of Object.keys(env)) {
    const urlMatch = /^RELAY_PROVIDER_([A-Z0-9_]+)_URL$/.exec(key);
    if (urlMatch) names.add(urlMatch[1].toLowerCase());
    const adapterMatch = /^RELAY_PROVIDER_([A-Z0-9_]+)_ADAPTER_TYPE$/.exec(key);
    if (adapterMatch) names.add(adapterMatch[1].toLowerCase());
  }
  return [...names];
}


export function getAllProviderNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...BUILTIN_PROVIDERS.map((provider) => provider.name), ...getDynamicProviderNames(env)];
}

export function isSupportedProvider(
  provider: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return getAllProviderNames(env).includes(provider);
}

export function isAgenticProvider(provider: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const builtin = BUILTIN_PROVIDERS.find((entry) => entry.name === provider);
  if (builtin) return builtin.agentic;
  // Adapter-type providers are non-agentic -- they call external tools directly.
  if (getDynamicProviderAdapterType(provider, env) !== null) return false;
  // All other dynamic providers run through GenericHttpRunner's agentic tool-calling loop.
  return getDynamicProviderNames(env).includes(provider);
}

export function getOpenRouterApiKey(): string | null {
  return process.env["OPENROUTER_API_KEY"]?.trim() || null;
}

export function getLmStudioEndpoint(): string {
  return process.env["LMSTUDIO_ENDPOINT"]?.trim() || "http://localhost:1234";
}

export function getLmStudioApiKey(): string | null {
  return process.env["LMSTUDIO_API_KEY"]?.trim() || null;
}

export function getOmlxEndpoint(): string | null {
  return process.env['OMLX_ENDPOINT']?.trim() || null;
}

export function getOmlxApiKey(): string | null {
  return process.env['OMLX_API_KEY']?.trim() || null;
}

export function getAnthropicApiKey(): string | null {
  return process.env["ANTHROPIC_API_KEY"]?.trim() || null;
}

export function getDynamicProviderUrl(name: string): string | null {
  return process.env[`RELAY_PROVIDER_${name.toUpperCase()}_URL`]?.trim() || null;
}

export function getDynamicProviderKey(name: string): string | null {
  return process.env[`RELAY_PROVIDER_${name.toUpperCase()}_KEY`]?.trim() || null;
}

export function getDynamicProviderAdapterPath(name: string): string | null {
  return process.env[`RELAY_PROVIDER_${name.toUpperCase()}_ADAPTER`]?.trim() || null;
}

export function getDynamicProviderType(
  name: string,
  env: NodeJS.ProcessEnv = process.env
): DynamicProviderType {
  const raw = env[`RELAY_PROVIDER_${name.toUpperCase()}_TYPE`]?.trim().toLowerCase();
  if (raw === "anthropic") return "anthropic";
  if (raw === "openai-responses" || raw === "responses") return "openai-responses";

  const url = env[`RELAY_PROVIDER_${name.toUpperCase()}_URL`]?.trim().toLowerCase() ?? "";
  if (url.endsWith("/responses")) return "openai-responses";

  return "openai";
}

export function getDynamicProviderHeaders(
  name: string,
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const prefix = `RELAY_PROVIDER_${name.toUpperCase()}_HEADER_`;
  const headers: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(prefix)) continue;
    if (typeof value !== "string" || value.trim().length === 0) continue;
    const headerName = key
      .slice(prefix.length)
      .toLowerCase()
      .replace(/_/g, "-");
    headers[headerName] = value.trim();
  }

  return headers;
}

function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

export function getDynamicProviderRequestUrl(
  name: string,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const raw = env[`RELAY_PROVIDER_${name.toUpperCase()}_URL`]?.trim();
  if (!raw) return null;

  const trimmed = trimTrailingSlashes(raw);
  const type = getDynamicProviderType(name, env);

  if (type === "anthropic") {
    return /\/messages$/i.test(trimmed) ? trimmed : `${trimmed}/messages`;
  }

  if (type === "openai-responses") {
    return /\/responses$/i.test(trimmed) ? trimmed : `${trimmed}/responses`;
  }

  if (/\/(chat\/completions|responses)$/i.test(trimmed)) {
    return trimmed;
  }

  return `${trimmed}/chat/completions`;
}

export function getDynamicProviderProbeUrl(
  name: string,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const requestUrl = getDynamicProviderRequestUrl(name, env);
  if (!requestUrl) return null;

  const type = getDynamicProviderType(name, env);
  if (type === "anthropic") {
    return requestUrl;
  }

  return requestUrl.replace(/\/(chat\/completions|responses)$/i, "/models");
}

// ─── Adapter config helpers ────────────────────────────────────────────────

export type AdapterTypeConfig = "openclaw" | "process" | "http";

export function getDynamicProviderAdapterType(
  name: string,
  env: NodeJS.ProcessEnv = process.env
): AdapterTypeConfig | null {
  const raw = env[`RELAY_PROVIDER_${name.toUpperCase()}_ADAPTER_TYPE`]?.trim().toLowerCase();
  if (raw === "openclaw" || raw === "process" || raw === "http") return raw;
  return null;
}

export function getDynamicProviderIntegrationLevel(
  name: string,
  env: NodeJS.ProcessEnv = process.env
): "callable" | "status" | "full" {
  const raw = env[`RELAY_PROVIDER_${name.toUpperCase()}_INTEGRATION_LEVEL`]?.trim().toLowerCase();
  if (raw === "callable" || raw === "status" || raw === "full") return raw;
  return "full";
}

export function getDynamicProviderOpenClawTool(
  name: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  return env[`RELAY_PROVIDER_${name.toUpperCase()}_OPENCLAW_TOOL`]?.trim() || "delegate";
}

export function getDynamicProviderExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  return env[`RELAY_PROVIDER_${name.toUpperCase()}_EXECUTABLE`]?.trim() || null;
}
