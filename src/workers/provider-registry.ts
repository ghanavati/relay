/**
 * Provider registry — builtin table + RELAY_PROVIDER_<NAME>_* env discovery.
 *
 * The core of v0.4 agnostic dispatch (DISPATCH-01/02): any OpenAI-compatible
 * or Anthropic-messages endpoint becomes a `relay run` provider through env
 * config alone. Pattern ported from the sunsetted relay-mcp predecessor
 * (config/providers.ts) — lean subset only: URL, KEY, TYPE, HEADER_*.
 *
 * Env vars per dynamic provider <NAME> (uppercase in the var, lowercased name):
 *   RELAY_PROVIDER_<NAME>_URL        required — base or full request URL
 *   RELAY_PROVIDER_<NAME>_KEY        optional — API key (configs store the
 *                                    env-var NAME; value resolved at request
 *                                    time inside the runner)
 *   RELAY_PROVIDER_<NAME>_TYPE       optional — openai (default) | anthropic
 *   RELAY_PROVIDER_<NAME>_HEADER_*   optional — extra headers (segment
 *                                    lowercased, underscores → hyphens)
 *
 * Rules:
 *   - Builtin names win: an env definition colliding with a builtin name is a
 *     RelayError at resolve time (PROVIDER_NAME_CONFLICT), never a silent
 *     override (D-04).
 *   - Dynamic providers are single-shot (agentic: false) in v1 (D-03).
 *   - Config only: no I/O, no fetch, no SDK imports. Pure functions over an
 *     injected env object (default process.env) so tests never mutate
 *     global env.
 */

import { makeError, toRelayException } from "../errors.js";

export type ProviderSource = "builtin" | "env";

/**
 * Wire protocol. `subprocess` is builtin-only (codex); the env _TYPE enum for
 * dynamic providers accepts openai | anthropic (v1 — D-02).
 */
export type ProviderWireType = "openai" | "anthropic" | "subprocess";

export interface ProviderConfig {
  name: string;
  source: ProviderSource;
  type: ProviderWireType;
  /** Fully-derived request URL (suffixed per type). null for subprocess providers. */
  url: string | null;
  /**
   * Env-var NAME holding the API key — never the value. The runner resolves
   * the value at request time, so configs stay printable without leaking
   * secrets (T-09-01).
   */
  keyEnvVar: string | null;
  headers: Record<string, string>;
  agentic: boolean;
  /**
   * Set on env-discovered entries whose name collides with a builtin
   * (review fix 5): the builtin wins, resolveProvider refuses the name with
   * PROVIDER_NAME_CONFLICT, and the listing surfaces the ignored env
   * definition explicitly instead of silently filtering it.
   */
  conflict?: true;
  /**
   * Listing-only (Codex round 2): set when the env definition failed to
   * resolve (e.g. invalid RELAY_PROVIDER_<NAME>_TYPE) so `relay providers`
   * can render the row with a note instead of crashing the whole inventory.
   * resolveProvider still throws for this name exactly as before.
   */
  error?: string;
}

const DYNAMIC_TYPES = ["openai", "anthropic"] as const;
type DynamicProviderType = (typeof DYNAMIC_TYPES)[number];

const DEFAULT_LMSTUDIO_ENDPOINT = "http://localhost:1234";

const ENV_URL_PATTERN = /^RELAY_PROVIDER_([A-Z0-9_]+)_URL$/;

function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * The five builtins, reproducing today's wiring exactly (DISPATCH-02): same
 * runner classes, same env-var names, same endpoints. The URL fields here are
 * informational (for `relay providers`); builtin runners keep deriving their
 * own endpoints internally.
 */
function builtinProviders(env: NodeJS.ProcessEnv): ProviderConfig[] {
  const lmstudioUrl = `${trimTrailingSlashes(
    env["LMSTUDIO_ENDPOINT"]?.trim() || DEFAULT_LMSTUDIO_ENDPOINT
  )}/v1/chat/completions`;
  return [
    {
      name: "codex",
      source: "builtin",
      type: "subprocess",
      url: null,
      keyEnvVar: null,
      headers: {},
      agentic: true,
    },
    {
      name: "openrouter",
      source: "builtin",
      type: "openai",
      url: "https://openrouter.ai/api/v1/chat/completions",
      keyEnvVar: "OPENROUTER_API_KEY",
      headers: {},
      agentic: false,
    },
    {
      name: "lmstudio",
      source: "builtin",
      type: "openai",
      url: lmstudioUrl,
      keyEnvVar: "LMSTUDIO_API_KEY",
      headers: {},
      agentic: false,
    },
    {
      name: "lmstudio-agentic",
      source: "builtin",
      type: "openai",
      url: lmstudioUrl,
      keyEnvVar: "LMSTUDIO_API_KEY",
      headers: {},
      agentic: true,
    },
    {
      name: "anthropic",
      source: "builtin",
      type: "anthropic",
      url: "https://api.anthropic.com/v1/messages",
      keyEnvVar: "ANTHROPIC_API_KEY",
      headers: {},
      agentic: false,
    },
  ];
}

/** Dynamic provider names are seeded by _URL vars only (D-01: URL is required). */
function discoverEnvProviderNames(env: NodeJS.ProcessEnv): string[] {
  const names = new Set<string>();
  for (const key of Object.keys(env)) {
    const match = ENV_URL_PATTERN.exec(key);
    if (match?.[1] && env[key]?.trim()) {
      names.add(match[1].toLowerCase());
    }
  }
  return [...names].sort();
}

function envProviderType(name: string, env: NodeJS.ProcessEnv): DynamicProviderType {
  const varName = `RELAY_PROVIDER_${name.toUpperCase()}_TYPE`;
  const raw = env[varName]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return "openai";
  if (raw === "openai" || raw === "anthropic") return raw;
  throw toRelayException(
    makeError(
      "CONFIG_ERROR",
      `${varName} has invalid value "${raw}" — allowed values: ${DYNAMIC_TYPES.join(", ")}`,
      false
    )
  );
}

function envProviderHeaders(
  name: string,
  env: NodeJS.ProcessEnv
): Record<string, string> {
  const prefix = `RELAY_PROVIDER_${name.toUpperCase()}_HEADER_`;
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(prefix)) continue;
    if (typeof value !== "string" || value.trim().length === 0) continue;
    const headerName = key.slice(prefix.length).toLowerCase().replace(/_/g, "-");
    headers[headerName] = value.trim();
  }
  return headers;
}

/**
 * Derive the request URL per protocol type:
 *   openai     → append /chat/completions unless already present
 *   anthropic  → append /v1/messages (or just /messages when the base already
 *                ends in /v1); a URL already ending in /messages is untouched
 */
function deriveRequestUrl(rawUrl: string, type: DynamicProviderType): string {
  const trimmed = trimTrailingSlashes(rawUrl.trim());
  if (type === "anthropic") {
    if (/\/messages$/i.test(trimmed)) return trimmed;
    if (/\/v1$/i.test(trimmed)) return `${trimmed}/messages`;
    return `${trimmed}/v1/messages`;
  }
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

function envProviderConfig(name: string, env: NodeJS.ProcessEnv): ProviderConfig {
  const upper = name.toUpperCase();
  const rawUrl = env[`RELAY_PROVIDER_${upper}_URL`]?.trim();
  const type = envProviderType(name, env);
  const keyEnvName = `RELAY_PROVIDER_${upper}_KEY`;
  const keyValue = env[keyEnvName];
  const hasKey = typeof keyValue === "string" && keyValue.trim().length > 0;
  return {
    name,
    source: "env",
    type,
    url: rawUrl ? deriveRequestUrl(rawUrl, type) : null,
    keyEnvVar: hasKey ? keyEnvName : null,
    headers: envProviderHeaders(name, env),
    // D-03: dynamic providers are single-shot (non-agentic) in v1.
    agentic: false,
  };
}

/**
 * Inventory of all available providers: builtins first, then env-discovered
 * (sorted by name). An env definition colliding with a builtin name is
 * listed as its own row with `conflict: true` (review fix 5) — consistent
 * with resolveProvider, which refuses the name with PROVIDER_NAME_CONFLICT.
 * The builtin still wins; the flagged row exists so `relay providers` shows
 * the user which env definition is being ignored instead of hiding it.
 */
export function listProviders(
  env: NodeJS.ProcessEnv = process.env
): ProviderConfig[] {
  const builtins = builtinProviders(env);
  const builtinNames = new Set(builtins.map((p) => p.name));
  const dynamic = discoverEnvProviderNames(env).map((name) => {
    const conflict = builtinNames.has(name);
    let config: ProviderConfig;
    try {
      config = envProviderConfig(name, env);
    } catch (err) {
      // LISTING-only fallback (Codex round 2): an invalid _TYPE must not
      // crash the inventory — the whole point of `relay providers` is to
      // show the user what is misconfigured. Safe display defaults; the
      // error note carries the real problem. resolveProvider still throws.
      config = {
        name,
        source: "env",
        type: "openai",
        url: null,
        keyEnvVar: null,
        headers: {},
        agentic: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    return conflict ? { ...config, conflict: true as const } : config;
  });
  return [...builtins, ...dynamic];
}

/**
 * Resolve one provider name to its config.
 *
 * Throws RelayException:
 *   PROVIDER_NAME_CONFLICT — env definition collides with a builtin name (D-04)
 *   CONFIG_ERROR           — invalid RELAY_PROVIDER_<NAME>_TYPE value
 *   UNKNOWN_PROVIDER       — name not found; message lists available providers
 */
export function resolveProvider(
  name: string,
  env: NodeJS.ProcessEnv = process.env
): ProviderConfig {
  const builtins = builtinProviders(env);
  const builtin = builtins.find((p) => p.name === name);
  const envNames = discoverEnvProviderNames(env);

  if (builtin) {
    if (envNames.includes(name)) {
      throw toRelayException(
        makeError(
          "PROVIDER_NAME_CONFLICT",
          `RELAY_PROVIDER_${name.toUpperCase()}_URL collides with the builtin provider "${name}" — builtin names cannot be overridden. Rename the env provider or unset the variable.`,
          false
        )
      );
    }
    return builtin;
  }

  if (envNames.includes(name)) {
    return envProviderConfig(name, env);
  }

  const available = [
    ...builtins.map((p) => p.name),
    ...envNames.filter((n) => !builtins.some((b) => b.name === n)),
  ];
  throw toRelayException(
    makeError(
      "UNKNOWN_PROVIDER",
      `unknown provider "${name}". Available providers: ${available.join(", ")}`,
      false
    )
  );
}
