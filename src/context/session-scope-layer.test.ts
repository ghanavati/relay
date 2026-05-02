import { describe, test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSessionScopeLayerProvider } from './session-scope-layer.js';

describe('session-scope-layer', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'relay-sscope-'));
    mkdirSync(join(tmpDir, 'docs', 'sessions'), { recursive: true });
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env['RELAY_SESSION_SCOPE_LAYERS'];
  });

  test('env var not set => load() returns null', async () => {
    delete process.env['RELAY_SESSION_SCOPE_LAYERS'];
    const provider = createSessionScopeLayerProvider();
    const result = await provider.load({ workdir: tmpDir });
    assert.strictEqual(result, null);
  });

  test('env set, index.json missing => null', async () => {
    process.env['RELAY_SESSION_SCOPE_LAYERS'] = '1';
    const provider = createSessionScopeLayerProvider();
    // docs/sessions/index.json intentionally not written
    const result = await provider.load({ workdir: tmpDir });
    assert.strictEqual(result, null);
    delete process.env['RELAY_SESSION_SCOPE_LAYERS'];
  });

  test('env set, active entry with owns_files => content includes file path', async () => {
    process.env['RELAY_SESSION_SCOPE_LAYERS'] = '1';
    const indexPath = join(tmpDir, 'docs', 'sessions', 'index.json');
    writeFileSync(indexPath, JSON.stringify([
      { session_id: 'sess-1', status: 'active', owns_files: ['src/foo.ts'] },
    ]));
    const provider = createSessionScopeLayerProvider();
    const result = await provider.load({ workdir: tmpDir });
    assert.ok(result !== null, 'should return a layer');
    assert.ok(result.content.includes('src/foo.ts'));
    delete process.env['RELAY_SESSION_SCOPE_LAYERS'];
  });

  test('env set, no active entries => null', async () => {
    process.env['RELAY_SESSION_SCOPE_LAYERS'] = '1';
    const indexPath = join(tmpDir, 'docs', 'sessions', 'index.json');
    writeFileSync(indexPath, JSON.stringify([
      { session_id: 'sess-2', status: 'closed', owns_files: ['src/bar.ts'] },
    ]));
    const provider = createSessionScopeLayerProvider();
    const result = await provider.load({ workdir: tmpDir });
    assert.strictEqual(result, null);
    delete process.env['RELAY_SESSION_SCOPE_LAYERS'];
  });
});
