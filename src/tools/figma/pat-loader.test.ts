/**
 * Phase 7 / Task 1 — PAT loader tests (RED phase).
 *
 * loadPat reads in priority order:
 *   1. env.FIGMA_API_TOKEN
 *   2. ${homeDir}/.relay/secrets/figma.json — { "token": "figd_..." }
 *
 * Returns null (NEVER throws) when neither source has token — FIGMA-03 graceful absence.
 * Refuses to read figma.json when stat.mode permits group/other read; stderr warns.
 *
 * loadWorkdirFileKey reads `${workdir}/.relay/figma.json` → { file_key } | null.
 *
 * Eight pat-loader cases per PLAN §Task 1.
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPat, loadWorkdirFileKey } from './pat-loader.js';

describe('loadPat', () => {
  let tempHome: string;
  let stderrBuf: string[];
  let savedStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'figma-pat-'));
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

  test('1) env.FIGMA_API_TOKEN present → returned directly (highest priority)', () => {
    const env = { FIGMA_API_TOKEN: 'figd_fromenv_abc' } as NodeJS.ProcessEnv;
    const out = loadPat(env, tempHome);
    assert.strictEqual(out, 'figd_fromenv_abc');
  });

  test('2) env absent, figma.json present (chmod 600) → token returned', () => {
    const path = join(tempHome, '.relay', 'secrets', 'figma.json');
    writeFileSync(path, JSON.stringify({ token: 'figd_fromfile_xyz' }), { mode: 0o600 });
    chmodSync(path, 0o600);
    const env = {} as NodeJS.ProcessEnv;
    const out = loadPat(env, tempHome);
    assert.strictEqual(out, 'figd_fromfile_xyz');
  });

  test('3) both env and file absent → returns null (graceful, NO throw)', () => {
    const env = {} as NodeJS.ProcessEnv;
    const out = loadPat(env, tempHome);
    assert.strictEqual(out, null);
    assert.equal(stderrBuf.length, 0, 'no warnings should be emitted when file simply absent');
  });

  test('4) figma.json present but chmod 644 → REFUSED + stderr warns + null', () => {
    const path = join(tempHome, '.relay', 'secrets', 'figma.json');
    writeFileSync(path, JSON.stringify({ token: 'figd_unsafefile' }), { mode: 0o644 });
    chmodSync(path, 0o644);
    const env = {} as NodeJS.ProcessEnv;
    const out = loadPat(env, tempHome);
    assert.strictEqual(out, null, 'must refuse to load when mode permits group/other read');
    const stderrJoined = stderrBuf.join('');
    assert.match(stderrJoined, /figma\.json.*chmod 600/i, 'must warn about chmod');
  });

  test('5) env priority — env wins even when file present', () => {
    const path = join(tempHome, '.relay', 'secrets', 'figma.json');
    writeFileSync(path, JSON.stringify({ token: 'figd_fromfile' }), { mode: 0o600 });
    chmodSync(path, 0o600);
    const env = { FIGMA_API_TOKEN: 'figd_fromenv_wins' } as NodeJS.ProcessEnv;
    const out = loadPat(env, tempHome);
    assert.strictEqual(out, 'figd_fromenv_wins');
  });

  test('6) malformed JSON in figma.json → returns null (graceful)', () => {
    const path = join(tempHome, '.relay', 'secrets', 'figma.json');
    writeFileSync(path, '{ not valid json', { mode: 0o600 });
    chmodSync(path, 0o600);
    const env = {} as NodeJS.ProcessEnv;
    const out = loadPat(env, tempHome);
    assert.strictEqual(out, null);
  });

  test('7) figma.json with empty token field → returns null', () => {
    const path = join(tempHome, '.relay', 'secrets', 'figma.json');
    writeFileSync(path, JSON.stringify({ token: '' }), { mode: 0o600 });
    chmodSync(path, 0o600);
    const env = {} as NodeJS.ProcessEnv;
    const out = loadPat(env, tempHome);
    assert.strictEqual(out, null);
  });

  test('8) env FIGMA_API_TOKEN = whitespace only → returns null (trim semantics)', () => {
    const env = { FIGMA_API_TOKEN: '   ' } as NodeJS.ProcessEnv;
    const out = loadPat(env, tempHome);
    assert.strictEqual(out, null);
  });
});

describe('loadWorkdirFileKey', () => {
  let tempWorkdir: string;

  beforeEach(() => {
    tempWorkdir = mkdtempSync(join(tmpdir(), 'figma-workdir-'));
  });

  afterEach(() => {
    rmSync(tempWorkdir, { recursive: true, force: true });
  });

  test('workdir/.relay/figma.json present → returns file_key', () => {
    mkdirSync(join(tempWorkdir, '.relay'), { recursive: true });
    writeFileSync(
      join(tempWorkdir, '.relay', 'figma.json'),
      JSON.stringify({ file_key: 'abc123' }),
      'utf-8',
    );
    assert.strictEqual(loadWorkdirFileKey(tempWorkdir), 'abc123');
  });

  test('workdir without .relay/figma.json → returns null', () => {
    assert.strictEqual(loadWorkdirFileKey(tempWorkdir), null);
  });

  test('workdir/.relay/figma.json malformed → returns null (no throw)', () => {
    mkdirSync(join(tempWorkdir, '.relay'), { recursive: true });
    writeFileSync(join(tempWorkdir, '.relay', 'figma.json'), 'NOT JSON', 'utf-8');
    assert.strictEqual(loadWorkdirFileKey(tempWorkdir), null);
  });
});
