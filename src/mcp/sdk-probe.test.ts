import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  resolveMcpSdk,
  MCP_SDK_PACKAGE,
  MCP_SERVER_MCP_SUBPATH,
  MCP_SERVER_STDIO_SUBPATH,
} from './sdk-probe.js';

describe('resolveMcpSdk', () => {
  test('resolves McpServer + StdioServerTransport from the installed package (Test 1)', async () => {
    const resolved = await resolveMcpSdk();
    assert.strictEqual(resolved.packageName, MCP_SDK_PACKAGE);
    assert.strictEqual(resolved.packageName, '@modelcontextprotocol/sdk');
    // Exact pin lives in package.json; here we only assert the probe reads a
    // real semver from the package installed on disk.
    assert.match(resolved.version, /^\d+\.\d+\.\d+/);
    assert.strictEqual(typeof resolved.McpServer, 'function');
    assert.strictEqual(typeof resolved.StdioServerTransport, 'function');
  });

  test('a failing import surfaces a coded RelayError naming the expected package (Test 2)', async () => {
    const failingImporter = async (specifier: string): Promise<Record<string, unknown>> => {
      throw new Error(`Cannot find module '${specifier}'`);
    };
    await assert.rejects(resolveMcpSdk(failingImporter), (err: unknown) => {
      const e = err as { code?: unknown; message?: string };
      assert.strictEqual(e.code, 'CONFIG_ERROR');
      assert.ok(
        e.message?.includes(MCP_SDK_PACKAGE),
        `error must name the expected package, got: ${e.message}`
      );
      assert.ok(
        e.message?.includes('MCP_SDK_UNRESOLVED'),
        `error must carry the MCP_SDK_UNRESOLVED discriminator, got: ${e.message}`
      );
      return true;
    });
  });

  test('a module missing the expected constructor is a coded failure, not a crash (Test 2b)', async () => {
    // Simulates SDK layout drift: the package resolves but the entry point no
    // longer exports the constructor we need.
    const emptyImporter = async (): Promise<Record<string, unknown>> => ({});
    await assert.rejects(resolveMcpSdk(emptyImporter), (err: unknown) => {
      const e = err as { code?: unknown; message?: string };
      assert.strictEqual(e.code, 'CONFIG_ERROR');
      assert.ok(
        e.message?.includes('McpServer'),
        `error must name the missing export, got: ${e.message}`
      );
      return true;
    });
  });

  test('the probe never writes to stdout (Test 3)', async () => {
    const writes: unknown[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: unknown): boolean => {
      writes.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await resolveMcpSdk();
      // The failure path must stay stdout-silent too.
      await resolveMcpSdk(async () => {
        throw new Error('simulated resolution failure');
      }).catch(() => undefined);
    } finally {
      process.stdout.write = originalWrite;
    }
    assert.deepStrictEqual(writes, [], 'stdio discipline: resolution must not touch stdout');
  });

  test('subpath constants point at the verified installed layout', () => {
    assert.strictEqual(MCP_SERVER_MCP_SUBPATH, '@modelcontextprotocol/sdk/server/mcp.js');
    assert.strictEqual(MCP_SERVER_STDIO_SUBPATH, '@modelcontextprotocol/sdk/server/stdio.js');
  });
});
