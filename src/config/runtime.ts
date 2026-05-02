import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

export type RelayLogLevel = "debug" | "info" | "warn" | "error";
export type RelayCodexNetworkMode = "off" | "search" | "dangerous";

const LOG_LEVELS: RelayLogLevel[] = ["debug", "info", "warn", "error"];
const CODEX_NETWORK_MODES: RelayCodexNetworkMode[] = ["off", "search", "dangerous"];

// Paths containing these fragments are app-bundled wrappers, not the real CLI.
// These binaries exit with code 1 when run outside their host app's environment.
const BLOCKED_PATH_FRAGMENTS = ['/Application Support/', '/Conductor/'];

// NVM installs Node versions into ~/.nvm/versions/node/<version>/. This pattern
// captures the version segment so we can detect when an env-var override points
// at a different Node version than the one running relay (stale override).
const NVM_VERSION_PATTERN = /\/\.nvm\/versions\/node\/(v\d+\.\d+\.\d+)\//;

function isWrappedBinary(p: string): boolean {
  return BLOCKED_PATH_FRAGMENTS.some(fragment => p.includes(fragment));
}

function nvmVersionOf(p: string): string | null {
  const m = p.match(NVM_VERSION_PATTERN);
  return m && m[1] ? m[1] : null;
}

export function resolveCodexBin(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath
): string {
  const sibling = join(dirname(execPath), 'codex');
  const siblingValid = existsSync(sibling) && !isWrappedBinary(sibling);

  const configured = env['RELAY_CODEX_PATH']?.trim();

  if (configured) {
    // Reject overrides that don't exist on disk or point at a wrapped binary.
    if (!existsSync(configured) || isWrappedBinary(configured)) {
      console.warn(
        `[relay-mcp] RELAY_CODEX_PATH=${configured} is missing or wrapped — falling back to auto-resolution`
      );
    } else {
      // Detect a stale NVM override: configured binary lives in a different
      // Node-version directory than the relay-mcp process is running under.
      // This commonly happens when .mcp.json was generated against an older
      // Node install that has since been replaced by `nvm install <newer>`.
      const configuredVersion = nvmVersionOf(configured);
      const runningVersion = nvmVersionOf(execPath);
      const staleNvmOverride =
        configuredVersion !== null &&
        runningVersion !== null &&
        configuredVersion !== runningVersion;

      if (staleNvmOverride && siblingValid) {
        console.warn(
          `[relay-mcp] RELAY_CODEX_PATH=${configured} is from Node ${configuredVersion} ` +
          `but relay-mcp is running under Node ${runningVersion}. ` +
          `Using sibling ${sibling} instead so codex tracks the running Node version. ` +
          `Remove RELAY_CODEX_PATH from your MCP config to silence this and let resolution stay automatic.`
        );
        return sibling;
      }

      return configured;
    }
  }

  // 2. Sibling to the node binary running relay.
  //    Whatever node runs relay, codex installed via `npm install -g @openai/codex`
  //    lands in the same bin/ directory. This is always correct regardless of PATH order.
  if (siblingValid) return sibling;

  // 3. PATH fallback — last resort when running under a wrapper node (e.g. Conductor)
  //    whose bin/ dir no longer contains codex
  return 'codex';
}

// Resolved once at module load — no repeated I/O per dispatch
const _resolvedCodexBin = resolveCodexBin();

export function getCodexBin(): string {
  return _resolvedCodexBin;
}

export function getRelayLogLevel(): RelayLogLevel {
  const rawLevel = (process.env.RELAY_LOG_LEVEL ?? "info").trim().toLowerCase();
  return LOG_LEVELS.includes(rawLevel as RelayLogLevel) ? (rawLevel as RelayLogLevel) : "info";
}

export function getRelayCodexNetworkMode(
  env: NodeJS.ProcessEnv = process.env
): RelayCodexNetworkMode {
  const rawMode = (env["RELAY_CODEX_NETWORK_MODE"] ?? "off").trim().toLowerCase();
  if (CODEX_NETWORK_MODES.includes(rawMode as RelayCodexNetworkMode)) {
    return rawMode as RelayCodexNetworkMode;
  }

  console.warn(
    `[relay-mcp] Invalid RELAY_CODEX_NETWORK_MODE value "${rawMode}" — falling back to "off". Valid values: off, search, dangerous`
  );
  return "off";
}
