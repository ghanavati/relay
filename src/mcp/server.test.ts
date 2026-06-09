/**
 * Phase 9 / Plan 04 — startMcpServer: build, register, connect, shut down.
 *
 * The server is tested with an INJECTED fake SDK + transport so no real stdio
 * is ever opened (the real StdioServerTransport would take ownership of
 * process.stdin/stdout — Plan 05's linked-pair integration test owns the real
 * wire). These tests prove the assembly contract:
 *
 *   1. exactly the two memory tools register — nothing more (D-07: the killed
 *      control/dispatch scope stays structurally absent)
 *   2. truthful identity: name 'relay', version = the CLI's version (asserted
 *      against the live `relay --version` output, not a copied constant)
 *   3. construction goes through the resolved SDK surface (the injected
 *      constructors are used — imports are never hardcoded; MCP-05/T-09-12)
 *   4. clean shutdown: client disconnect resolves the handle's closed promise;
 *      shutdown() is idempotent; no process signal listeners are installed
 */

process.env['RELAY_DB_PATH'] = ':memory:';
delete process.env['RELAY_MEMORY_ALLOWED_WORKDIRS'];
delete process.env['RELAY_EMBEDDING_MODEL'];

import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMcpServer, MCP_SERVER_NAME } from './server.js';
import { MCP_SDK_PACKAGE } from './sdk-probe.js';
import type { McpConstructor, ResolvedMcpSdk } from './sdk-probe.js';
import { RecallArgsSchema, RememberArgsSchema } from '../contracts/memory.js';

// ---------------------------------------------------------------------------
// Fake SDK — mimics the verified 1.29.0 surface (constructor shape, ownership
// chain transport.onclose → underlying server.onclose, close() → transport
// close). Built per-test via a factory so instance records never bleed.
// ---------------------------------------------------------------------------

interface FakeRegistration {
  readonly name: string;
  readonly config: { description?: string; inputSchema?: unknown };
  readonly handler: unknown;
}

interface FakeSdkKit {
  sdk: ResolvedMcpSdk;
  serverInstances: FakeServerShape[];
  transportInstances: FakeTransportShape[];
}

interface FakeTransportShape {
  started: boolean;
  closed: boolean;
  onclose?: () => void;
  start(): Promise<void>;
  close(): Promise<void>;
}

interface FakeServerShape {
  serverInfo: { name?: string; version?: string };
  registered: FakeRegistration[];
  connectedTransport: FakeTransportShape | undefined;
  closeCalls: number;
  server: { onclose?: () => void };
  registerTool(name: string, config: FakeRegistration['config'], handler: unknown): unknown;
  connect(transport: FakeTransportShape): Promise<void>;
  close(): Promise<void>;
}

function makeFakeSdk(): FakeSdkKit {
  const serverInstances: FakeServerShape[] = [];
  const transportInstances: FakeTransportShape[] = [];

  class FakeTransport implements FakeTransportShape {
    started = false;
    closed = false;
    onclose?: () => void;
    constructor() {
      transportInstances.push(this);
    }
    async start(): Promise<void> {
      this.started = true;
    }
    async close(): Promise<void> {
      if (this.closed) return;
      this.closed = true;
      this.onclose?.();
    }
  }

  class FakeMcpServer implements FakeServerShape {
    serverInfo: { name?: string; version?: string };
    registered: FakeRegistration[] = [];
    connectedTransport: FakeTransportShape | undefined;
    closeCalls = 0;
    // The real McpServer exposes the underlying protocol server whose onclose
    // callback fires when the transport closes — same shape here.
    server: { onclose?: () => void } = {};
    constructor(serverInfo: { name?: string; version?: string }) {
      this.serverInfo = serverInfo;
      serverInstances.push(this);
    }
    registerTool(name: string, config: FakeRegistration['config'], handler: unknown): unknown {
      this.registered.push({ name, config, handler });
      return {};
    }
    async connect(transport: FakeTransportShape): Promise<void> {
      this.connectedTransport = transport;
      // Ownership contract from the real SDK: connect() takes over the
      // transport callbacks and chains close through the protocol layer.
      transport.onclose = () => {
        this.server.onclose?.();
      };
      await transport.start();
    }
    async close(): Promise<void> {
      this.closeCalls++;
      await this.connectedTransport?.close();
    }
  }

  const sdk: ResolvedMcpSdk = {
    packageName: MCP_SDK_PACKAGE,
    version: '1.29.0',
    McpServer: FakeMcpServer as unknown as McpConstructor,
    StdioServerTransport: FakeTransport as unknown as McpConstructor,
  };
  return { sdk, serverInstances, transportInstances };
}

function cliVersion(): string {
  const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url));
  const res = spawnSync(process.execPath, [cliPath, '--version'], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, `relay --version must exit 0 (stderr: ${res.stderr})`);
  const match = /^relay v(\S+)/.exec(res.stdout);
  assert.ok(match?.[1], `--version output must look like 'relay vX.Y.Z' (got: ${res.stdout})`);
  return match[1];
}

describe('startMcpServer — tool surface (Test 1)', () => {
  test('registers exactly relay_memory_recall + relay_memory_save — nothing more', async () => {
    const { sdk, serverInstances, transportInstances } = makeFakeSdk();
    const handle = await startMcpServer({ sdk, transport: new (sdk.StdioServerTransport)() });

    assert.strictEqual(serverInstances.length, 1);
    const srv = serverInstances[0]!;
    assert.deepStrictEqual(
      srv.registered.map((r) => r.name).sort(),
      ['relay_memory_recall', 'relay_memory_save']
    );
    assert.strictEqual(srv.registered.length, 2, 'no third tool may register');
    assert.deepStrictEqual(
      [...handle.toolNames].sort(),
      ['relay_memory_recall', 'relay_memory_save']
    );

    // The registration carries Plan 03's contract: contracts Zod schema by
    // identity, a client-facing description, and a live handler function.
    const recall = srv.registered.find((r) => r.name === 'relay_memory_recall')!;
    const save = srv.registered.find((r) => r.name === 'relay_memory_save')!;
    assert.strictEqual(recall.config.inputSchema, RecallArgsSchema);
    assert.strictEqual(save.config.inputSchema, RememberArgsSchema);
    for (const reg of [recall, save]) {
      assert.strictEqual(typeof reg.config.description, 'string');
      assert.ok((reg.config.description ?? '').length > 0);
      assert.strictEqual(typeof reg.handler, 'function');
    }

    // The injected transport was connected and started.
    assert.strictEqual(transportInstances.length, 1);
    assert.strictEqual(srv.connectedTransport, transportInstances[0]);
    assert.strictEqual(transportInstances[0]!.started, true);

    await handle.shutdown();
  });
});

describe('startMcpServer — truthful identity (Test 2)', () => {
  test('server name is relay and an injected version flows to the constructor', async () => {
    const { sdk, serverInstances } = makeFakeSdk();
    const handle = await startMcpServer({
      sdk,
      transport: new (sdk.StdioServerTransport)(),
      version: '9.9.9-test',
    });
    const srv = serverInstances[0]!;
    assert.strictEqual(srv.serverInfo.name, 'relay');
    assert.strictEqual(srv.serverInfo.name, MCP_SERVER_NAME);
    assert.strictEqual(srv.serverInfo.version, '9.9.9-test');
    await handle.shutdown();
  });

  test('default version matches the CLI version (relay --version)', async () => {
    const expected = cliVersion();
    const { sdk, serverInstances } = makeFakeSdk();
    const handle = await startMcpServer({ sdk, transport: new (sdk.StdioServerTransport)() });
    const srv = serverInstances[0]!;
    assert.strictEqual(srv.serverInfo.name, 'relay');
    assert.strictEqual(
      srv.serverInfo.version,
      expected,
      'an MCP client must see the same version the CLI reports'
    );
    await handle.shutdown();
  });
});

describe('startMcpServer — resolved SDK surface (Test 3)', () => {
  test('constructs via the injected SDK constructors — imports are not hardcoded', async () => {
    const { sdk, serverInstances, transportInstances } = makeFakeSdk();
    // No transport injected: the server must build one from the RESOLVED
    // StdioServerTransport constructor (here the fake — proving the ctor in
    // use is the one resolveMcpSdk returned, not a direct SDK import).
    const handle = await startMcpServer({ sdk });

    assert.strictEqual(serverInstances.length, 1, 'McpServer built from the injected SDK');
    assert.strictEqual(handle.server, serverInstances[0]);
    assert.strictEqual(transportInstances.length, 1, 'transport built from the injected SDK');
    assert.strictEqual(serverInstances[0]!.connectedTransport, transportInstances[0]);

    await handle.shutdown();
  });
});

describe('startMcpServer — clean shutdown (Test 4)', () => {
  test('client disconnect (transport close) resolves the closed promise', async () => {
    const { sdk, transportInstances } = makeFakeSdk();
    const transport = new (sdk.StdioServerTransport)() as FakeTransportShape;
    const handle = await startMcpServer({ sdk, transport });

    await transport.close(); // the client went away
    await handle.closed; // must resolve — a hang here fails the test by timeout
    assert.strictEqual(transportInstances[0]!.closed, true);

    // shutdown after the connection already closed stays clean + idempotent.
    await handle.shutdown();
    await handle.shutdown();
  });

  test('proactive shutdown() closes the transport and resolves closed', async () => {
    const { sdk, serverInstances } = makeFakeSdk();
    const transport = new (sdk.StdioServerTransport)() as FakeTransportShape;
    const handle = await startMcpServer({ sdk, transport });

    await handle.shutdown();
    await handle.closed;
    assert.strictEqual(transport.closed, true);
    assert.ok(serverInstances[0]!.closeCalls >= 1, 'server.close() drives the shutdown');
  });

  test('installs no process signal listeners (signal handling is the CLI command layer)', async () => {
    const sigintBefore = process.listenerCount('SIGINT');
    const sigtermBefore = process.listenerCount('SIGTERM');
    const { sdk } = makeFakeSdk();
    const handle = await startMcpServer({ sdk });
    assert.strictEqual(process.listenerCount('SIGINT'), sigintBefore);
    assert.strictEqual(process.listenerCount('SIGTERM'), sigtermBefore);
    await handle.shutdown();
    assert.strictEqual(process.listenerCount('SIGINT'), sigintBefore);
    assert.strictEqual(process.listenerCount('SIGTERM'), sigtermBefore);
  });
});
