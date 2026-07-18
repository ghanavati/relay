/**
 * Phase 9 (REQ-MCP-04) — MCP workdir resolution.
 *
 * MCP clients (Claude Desktop, Cursor) have no meaningful cwd. Resolution
 * order: explicit arg > RELAY_MCP_DEFAULT_WORKDIR > refuse with instruction.
 * Never a silent global fallback — cross-project leakage is the failure mode
 * this guards against.
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { resolveMcpWorkdir } from './workdir.js';

describe('resolveMcpWorkdir', () => {
  const emptyEnv = {} as NodeJS.ProcessEnv;

  test('explicit workdir always wins', () => {
    const env = { RELAY_MCP_DEFAULT_WORKDIR: '/env/proj' } as NodeJS.ProcessEnv;
    assert.equal(resolveMcpWorkdir('/explicit/proj', 'read', env), '/explicit/proj');
    assert.equal(resolveMcpWorkdir('/explicit/proj', 'write', env), '/explicit/proj');
  });

  test("read scope accepts '*' (all projects)", () => {
    assert.equal(resolveMcpWorkdir('*', 'read', emptyEnv), '*');
  });

  test("write scope rejects '*'", () => {
    assert.throws(
      () => resolveMcpWorkdir('*', 'write', emptyEnv),
      (err: Error & { code?: string }) => err.code === 'INVALID_ARGS'
    );
  });

  test('falls back to RELAY_MCP_DEFAULT_WORKDIR when no explicit arg', () => {
    const env = { RELAY_MCP_DEFAULT_WORKDIR: '/env/proj' } as NodeJS.ProcessEnv;
    assert.equal(resolveMcpWorkdir(undefined, 'read', env), '/env/proj');
    assert.equal(resolveMcpWorkdir('', 'read', env), '/env/proj');
  });

  test('refuses with INVALID_ARGS when neither arg nor env present', () => {
    assert.throws(
      () => resolveMcpWorkdir(undefined, 'read', emptyEnv),
      (err: Error & { code?: string }) =>
        err.code === 'INVALID_ARGS' && /workdir required/i.test(err.message)
    );
  });

  test('empty-string env var does not count as configured', () => {
    const env = { RELAY_MCP_DEFAULT_WORKDIR: '' } as NodeJS.ProcessEnv;
    assert.throws(() => resolveMcpWorkdir(undefined, 'read', env));
  });
});
