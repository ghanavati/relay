// src/mcp/sdk-probe.ts — build-time verification of the MCP SDK surface (MCP-05).
//
// The official MCP TypeScript SDK has shifted package layouts before; every
// later import of McpServer/StdioServerTransport goes through this probe so a
// missing or renamed package fails loudly at build/test time with a coded
// RelayError instead of crashing at connect time (threat T-09-07).
//
// Verified against the installed package on disk (not docs), 2026-06-09:
//   @modelcontextprotocol/sdk@1.29.0
//   - exports map: named "./server" (low-level Server only) + wildcard "./*"
//   - McpServer lives at        "@modelcontextprotocol/sdk/server/mcp.js"
//   - StdioServerTransport at   "@modelcontextprotocol/sdk/server/stdio.js"
//   (the bare "./server" index does NOT export either — subpaths are required)
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeError, toRelayException } from '../errors.js';

export const MCP_SDK_PACKAGE = '@modelcontextprotocol/sdk';
export const MCP_SERVER_MCP_SUBPATH = `${MCP_SDK_PACKAGE}/server/mcp.js`;
export const MCP_SERVER_STDIO_SUBPATH = `${MCP_SDK_PACKAGE}/server/stdio.js`;

type McpModule = Record<string, unknown>;

/** Injectable import function so tests can simulate a missing/renamed SDK. */
export type McpImporter = (specifier: string) => Promise<McpModule>;

// Loose constructor type on purpose: the probe is dependency-light so the rest
// of src/mcp can stay SDK-free; Plan 04 instantiates these with SDK-shaped args.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type McpConstructor = new (...args: any[]) => any;

export interface ResolvedMcpSdk {
  readonly packageName: string;
  readonly version: string;
  readonly McpServer: McpConstructor;
  readonly StdioServerTransport: McpConstructor;
}

const defaultImporter: McpImporter = (specifier) => import(specifier) as Promise<McpModule>;

/**
 * Coded resolution failure (CONFIG_ERROR from the existing ErrorCode union;
 * the MCP_SDK_UNRESOLVED prefix is the greppable discriminator). Never an
 * unhandled rejection — callers get a RelayException naming the package.
 */
function sdkUnresolved(detail: string): Error {
  return toRelayException(
    makeError(
      'CONFIG_ERROR',
      `MCP_SDK_UNRESOLVED: ${detail} — expected the official MCP SDK package ` +
        `"${MCP_SDK_PACKAGE}" (exact-pinned in package.json). Run \`npm install\` and rebuild; ` +
        `if the SDK changed its package layout, update src/mcp/sdk-probe.ts to match the ` +
        `installed exports map.`,
      false,
      'mcp'
    )
  );
}

async function importModule(importer: McpImporter, specifier: string): Promise<McpModule> {
  try {
    return await importer(specifier);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw sdkUnresolved(`cannot import "${specifier}" (${message})`);
  }
}

function pickConstructor(mod: McpModule, exportName: string, specifier: string): McpConstructor {
  const candidate = mod[exportName];
  if (typeof candidate !== 'function') {
    throw sdkUnresolved(
      `"${specifier}" resolved but does not export a ${exportName} constructor (SDK layout drift?)`
    );
  }
  return candidate as McpConstructor;
}

/**
 * Read the version of the SDK actually installed on disk. Walks up from the
 * resolved entry file to the package root: the SDK ships stub package.json
 * files inside dist/ ({"type":"commonjs"} / {"type":"module"}) that carry no
 * name, so the walk skips them and lands on the real manifest.
 */
function readInstalledVersion(): string {
  let entryPath: string;
  try {
    const requireFromHere = createRequire(import.meta.url);
    entryPath = requireFromHere.resolve(MCP_SERVER_MCP_SUBPATH);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw sdkUnresolved(`cannot resolve "${MCP_SERVER_MCP_SUBPATH}" on disk (${message})`);
  }
  let dir = dirname(entryPath);
  for (;;) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (parsed.name === MCP_SDK_PACKAGE && typeof parsed.version === 'string') {
        return parsed.version;
      }
    } catch {
      // No package.json at this level (or an unreadable/stub one) — keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw sdkUnresolved(`could not locate the installed package.json for "${MCP_SDK_PACKAGE}"`);
}

/**
 * Verify and return the installed MCP SDK surface. Imports the exact subpaths
 * the installed package exports (never copied from docs), confirms both
 * constructors exist, and reads the on-disk version. Writes nothing to stdout:
 * stdio discipline starts here (stdout is the MCP wire in Plan 04).
 *
 * @param importer injectable for tests simulating a missing/renamed package.
 */
export async function resolveMcpSdk(importer: McpImporter = defaultImporter): Promise<ResolvedMcpSdk> {
  const mcpModule = await importModule(importer, MCP_SERVER_MCP_SUBPATH);
  const mcpServer = pickConstructor(mcpModule, 'McpServer', MCP_SERVER_MCP_SUBPATH);
  const stdioModule = await importModule(importer, MCP_SERVER_STDIO_SUBPATH);
  const stdioTransport = pickConstructor(
    stdioModule,
    'StdioServerTransport',
    MCP_SERVER_STDIO_SUBPATH
  );
  const version = readInstalledVersion();
  return {
    packageName: MCP_SDK_PACKAGE,
    version,
    McpServer: mcpServer,
    StdioServerTransport: stdioTransport,
  };
}
