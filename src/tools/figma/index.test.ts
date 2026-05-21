/**
 * Phase 7 / Task 5 — registry tests (RED phase).
 *
 * 6 cases per PLAN §Task 5:
 *   1) env empty + no figma.json → returns null (FIGMA-03 graceful)
 *   2) env with FIGMA_API_TOKEN → returns 2-elem array
 *   3) figma.json at tmp homeDir + chmod 600 → returns 2-elem array
 *   4) figma.json + chmod 644 → returns null + stderr warn
 *   5) DEFERRED_FIGMA_TOOLS contains exactly 2 v0.3 names
 *   6) registered tools' def.function.name are unique
 *
 * Plus: tool name allow-list check (only the 2 REST tools, NEVER deferred names).
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerFigmaTools, DEFERRED_FIGMA_TOOLS } from './index.js';

describe('registerFigmaTools — env-gated registration', () => {
  let tempHome: string;
  let stderrBuf: string[];
  let savedStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'figma-registry-'));
    mkdirSync(join(tempHome, '.relay', 'secrets'), { recursive: true });
    stderrBuf = [];
    savedStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      stderrBuf.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = savedStderrWrite;
    rmSync(tempHome, { recursive: true, force: true });
  });

  test('1) env empty + no figma.json → returns null (FIGMA-03 graceful absence)', () => {
    const result = registerFigmaTools({} as NodeJS.ProcessEnv, tempHome);
    assert.strictEqual(result, null);
  });

  test('2) env.FIGMA_API_TOKEN set → returns 2-element handler array', () => {
    const result = registerFigmaTools(
      { FIGMA_API_TOKEN: 'figd_testpat_xxxxx' } as NodeJS.ProcessEnv,
      tempHome,
    );
    assert.ok(result, 'must not be null');
    assert.equal(result.length, 2);
    const names = result.map((h) => h.def.function.name);
    assert.ok(names.includes('figma_list_layers'));
    assert.ok(names.includes('figma_update_token'));
  });

  test('3) figma.json present at homeDir + chmod 600 → returns 2-elem array', () => {
    const path = join(tempHome, '.relay', 'secrets', 'figma.json');
    writeFileSync(path, JSON.stringify({ token: 'figd_fromfile' }), { mode: 0o600 });
    chmodSync(path, 0o600);
    const result = registerFigmaTools({} as NodeJS.ProcessEnv, tempHome);
    assert.ok(result);
    assert.equal(result.length, 2);
  });

  test('4) figma.json + chmod 644 → returns null + stderr warn (T-07-03)', () => {
    const path = join(tempHome, '.relay', 'secrets', 'figma.json');
    writeFileSync(path, JSON.stringify({ token: 'figd_unsafefile' }), { mode: 0o644 });
    chmodSync(path, 0o644);
    const result = registerFigmaTools({} as NodeJS.ProcessEnv, tempHome);
    assert.strictEqual(result, null);
    const joined = stderrBuf.join('');
    assert.match(joined, /chmod 600/i);
  });

  test('6) registered tool defs have unique names', () => {
    const result = registerFigmaTools(
      { FIGMA_API_TOKEN: 'figd_x' } as NodeJS.ProcessEnv,
      tempHome,
    );
    assert.ok(result);
    const names = result.map((h) => h.def.function.name);
    assert.equal(new Set(names).size, names.length, 'tool names must be unique');
  });

  test('handlers expose .handle function for dispatch', () => {
    const result = registerFigmaTools(
      { FIGMA_API_TOKEN: 'figd_x' } as NodeJS.ProcessEnv,
      tempHome,
    );
    assert.ok(result);
    for (const h of result) {
      assert.equal(typeof h.handle, 'function');
    }
  });
});

describe('DEFERRED_FIGMA_TOOLS — declarative deferral (FIGMA-05)', () => {
  test('5) contains exactly 2 v0.3 tool names', () => {
    assert.equal(DEFERRED_FIGMA_TOOLS.length, 2);
    assert.ok(DEFERRED_FIGMA_TOOLS.includes('figma_get_selection'));
    assert.ok(DEFERRED_FIGMA_TOOLS.includes('figma_create_component'));
  });

  test('NO function exports match deferred names (declarative absence)', async () => {
    const mod = await import('./index.js') as Record<string, unknown>;
    for (const deferred of DEFERRED_FIGMA_TOOLS) {
      assert.strictEqual(mod[deferred], undefined, `${deferred} must NOT be exported as a function`);
    }
  });

  test('registered tool names do NOT include any deferred names', () => {
    const result = registerFigmaTools(
      { FIGMA_API_TOKEN: 'figd_x' } as NodeJS.ProcessEnv,
      '/tmp/anywhere-no-secrets',
    );
    assert.ok(result);
    const names = result.map((h) => h.def.function.name);
    for (const deferred of DEFERRED_FIGMA_TOOLS) {
      assert.ok(!names.includes(deferred), `${deferred} must NEVER appear as registered handler`);
    }
  });
});
