import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveRelayMcpCommand,
  upsertMcpJsonEntry,
  upsertCodexMcpEntry,
} from './mcp-clients.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'relay-mcp-clients-'));
}

describe('resolveRelayMcpCommand', () => {
  test('absolute node binary + absolute cli.js + mcp arg', () => {
    const cmd = resolveRelayMcpCommand();
    assert.ok(cmd.command.startsWith('/'), 'command must be absolute');
    assert.equal(cmd.args.length, 2);
    assert.ok(cmd.args[0]!.endsWith('/cli.js'), 'first arg must be cli.js path');
    assert.equal(cmd.args[1], 'mcp');
  });
});

describe('upsertMcpJsonEntry', () => {
  const cmd = { command: '/usr/bin/node', args: ['/x/cli.js', 'mcp'] } as const;

  test('creates the file with the relay entry when missing', () => {
    const dir = tmp();
    try {
      const p = join(dir, 'claude_desktop_config.json');
      const r = upsertMcpJsonEntry(p, cmd);
      assert.equal(r.status, 'wired');
      const parsed = JSON.parse(readFileSync(p, 'utf8'));
      assert.deepEqual(parsed.mcpServers.relay, { command: '/usr/bin/node', args: ['/x/cli.js', 'mcp'] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('second run is a no-op (already); foreign servers preserved', () => {
    const dir = tmp();
    try {
      const p = join(dir, 'mcp.json');
      writeFileSync(p, JSON.stringify({ mcpServers: { other: { command: 'x' } }, topLevel: 1 }));
      assert.equal(upsertMcpJsonEntry(p, cmd).status, 'wired');
      assert.equal(upsertMcpJsonEntry(p, cmd).status, 'already');
      const parsed = JSON.parse(readFileSync(p, 'utf8'));
      assert.deepEqual(parsed.mcpServers.other, { command: 'x' });
      assert.equal(parsed.topLevel, 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('updates a stale relay entry in place', () => {
    const dir = tmp();
    try {
      const p = join(dir, 'mcp.json');
      writeFileSync(p, JSON.stringify({ mcpServers: { relay: { command: '/old/node', args: [] } } }));
      assert.equal(upsertMcpJsonEntry(p, cmd).status, 'wired');
      const parsed = JSON.parse(readFileSync(p, 'utf8'));
      assert.equal(parsed.mcpServers.relay.command, '/usr/bin/node');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('invalid JSON → failed, file untouched', () => {
    const dir = tmp();
    try {
      const p = join(dir, 'mcp.json');
      writeFileSync(p, '{ not json');
      const r = upsertMcpJsonEntry(p, cmd);
      assert.equal(r.status, 'failed');
      assert.equal(readFileSync(p, 'utf8'), '{ not json');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('upsertCodexMcpEntry', () => {
  const cmd = { command: '/usr/bin/node', args: ['/x/cli.js', 'mcp'] } as const;

  test('appends the block once; second run is already; foreign TOML preserved', () => {
    const dir = tmp();
    try {
      const p = join(dir, 'config.toml');
      writeFileSync(p, '[model]\nname = "gpt"\n');
      assert.equal(upsertCodexMcpEntry(p, cmd).status, 'wired');
      assert.equal(upsertCodexMcpEntry(p, cmd).status, 'already');
      const out = readFileSync(p, 'utf8');
      assert.match(out, /\[model\]\nname = "gpt"/);
      assert.match(out, /\[mcp_servers\.relay\]/);
      assert.match(out, /command = "\/usr\/bin\/node"/);
      assert.match(out, /args = \["\/x\/cli\.js", "mcp"\]/);
      assert.equal(out.match(/\[mcp_servers\.relay\]/g)!.length, 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('creates config.toml when absent', () => {
    const dir = tmp();
    try {
      const p = join(dir, 'config.toml');
      assert.equal(upsertCodexMcpEntry(p, cmd).status, 'wired');
      assert.match(readFileSync(p, 'utf8'), /\[mcp_servers\.relay\]/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
