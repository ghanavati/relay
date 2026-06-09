/**
 * Provider registry — builtin table + RELAY_PROVIDER_<NAME>_* env discovery.
 *
 * RED skeleton (09-01 Task 1): exports compile, behaviors not implemented yet.
 */

export type ProviderSource = "builtin" | "env";
export type ProviderWireType = "openai" | "anthropic" | "subprocess";

export interface ProviderConfig {
  name: string;
  source: ProviderSource;
  type: ProviderWireType;
  url: string | null;
  keyEnvVar: string | null;
  headers: Record<string, string>;
  agentic: boolean;
}

export function listProviders(
  _env: NodeJS.ProcessEnv = process.env
): ProviderConfig[] {
  throw new Error("not implemented");
}

export function resolveProvider(
  _name: string,
  _env: NodeJS.ProcessEnv = process.env
): ProviderConfig {
  throw new Error("not implemented");
}
