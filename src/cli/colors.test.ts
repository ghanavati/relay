import { test, describe, before, after, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { c, colorsEnabled, setColorMode, statusBadge } from './colors.js';

interface SavedEnv {
  NO_COLOR: string | undefined;
  TERM: string | undefined;
  RELAY_COLOR: string | undefined;
}

function snapshotEnv(): SavedEnv {
  return {
    NO_COLOR: process.env['NO_COLOR'],
    TERM: process.env['TERM'],
    RELAY_COLOR: process.env['RELAY_COLOR'],
  };
}

function restoreEnv(saved: SavedEnv): void {
  for (const key of ['NO_COLOR', 'TERM', 'RELAY_COLOR'] as const) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key]!;
  }
}

function clearEnv(): void {
  delete process.env['NO_COLOR'];
  delete process.env['TERM'];
  delete process.env['RELAY_COLOR'];
}

/**
 * The `colors` module caches state via `cachedEnabled`. Tests must reset
 * the cache between cases. `setColorMode('auto')` resets cachedEnabled to
 * null, so subsequent `colorsEnabled()` reads env again.
 */
describe('colors module', () => {
  let savedEnv: SavedEnv;

  before(() => {
    savedEnv = snapshotEnv();
  });

  after(() => {
    restoreEnv(savedEnv);
    setColorMode('auto');
  });

  beforeEach(() => {
    // Reset to a clean baseline before each test
    clearEnv();
    setColorMode('auto');
  });

  describe('colorsEnabled()', () => {
    test('returns false when NO_COLOR is set', () => {
      process.env['NO_COLOR'] = '1';
      setColorMode('auto');
      assert.strictEqual(colorsEnabled(), false);
    });

    test('returns false when TERM=dumb', () => {
      process.env['TERM'] = 'dumb';
      setColorMode('auto');
      assert.strictEqual(colorsEnabled(), false);
    });

    test('returns false when stdout is not a TTY (test env default)', () => {
      // node --test runs without TTY; NO_COLOR/TERM unset
      setColorMode('auto');
      // process.stdout.isTTY is undefined/false in test env → must be false
      if (!process.stdout.isTTY) {
        assert.strictEqual(colorsEnabled(), false);
      } else {
        // Defensive: if running on a real TTY, skip this assertion
        assert.ok(true);
      }
    });

    test("setColorMode('always') overrides — returns true even with NO_COLOR", () => {
      process.env['NO_COLOR'] = '1';
      setColorMode('always');
      assert.strictEqual(colorsEnabled(), true);
    });

    test("setColorMode('never') returns false even when other signals say enabled", () => {
      // No env vars; in a TTY would normally be true. Force never.
      setColorMode('never');
      assert.strictEqual(colorsEnabled(), false);
    });

    test('RELAY_COLOR=always env var override (auto mode)', () => {
      process.env['RELAY_COLOR'] = 'always';
      setColorMode('auto');
      assert.strictEqual(colorsEnabled(), true);
    });

    test('RELAY_COLOR=never env var override (auto mode)', () => {
      process.env['RELAY_COLOR'] = 'never';
      setColorMode('auto');
      assert.strictEqual(colorsEnabled(), false);
    });
  });

  describe('c.<color>(text)', () => {
    test("c.green('hi') returns plain 'hi' when colors disabled", () => {
      setColorMode('never');
      assert.strictEqual(c.green('hi'), 'hi');
    });

    test("c.green('hi') returns wrapped ANSI when colors enabled", () => {
      setColorMode('always');
      // 32 = green
      assert.strictEqual(c.green('hi'), '\x1b[32mhi\x1b[0m');
    });

    test('all color helpers are pass-through when disabled', () => {
      setColorMode('never');
      assert.strictEqual(c.red('x'), 'x');
      assert.strictEqual(c.yellow('x'), 'x');
      assert.strictEqual(c.blue('x'), 'x');
      assert.strictEqual(c.cyan('x'), 'x');
      assert.strictEqual(c.gray('x'), 'x');
      assert.strictEqual(c.bold('x'), 'x');
      assert.strictEqual(c.dim('x'), 'x');
    });

    test('all color helpers wrap correctly when enabled', () => {
      setColorMode('always');
      assert.strictEqual(c.red('x'), '\x1b[31mx\x1b[0m');
      assert.strictEqual(c.yellow('x'), '\x1b[33mx\x1b[0m');
      assert.strictEqual(c.blue('x'), '\x1b[34mx\x1b[0m');
      assert.strictEqual(c.cyan('x'), '\x1b[36mx\x1b[0m');
      assert.strictEqual(c.gray('x'), '\x1b[90mx\x1b[0m');
      assert.strictEqual(c.bold('x'), '\x1b[1mx\x1b[0m');
      assert.strictEqual(c.dim('x'), '\x1b[2mx\x1b[0m');
    });
  });

  describe('statusBadge()', () => {
    test("statusBadge('ok') is green with [OK] when colors on", () => {
      setColorMode('always');
      const badge = statusBadge('ok');
      assert.match(badge, /\x1b\[32m/);
      assert.match(badge, /\[OK\]/);
      assert.match(badge, /\x1b\[0m$/);
    });

    test("statusBadge('ok') is plain '[OK]' when colors off", () => {
      setColorMode('never');
      assert.strictEqual(statusBadge('ok'), '[OK]');
    });

    test("statusBadge('failed') is red [!!]", () => {
      setColorMode('always');
      const badge = statusBadge('failed');
      assert.match(badge, /\x1b\[31m/);
      assert.match(badge, /\[!!\]/);
    });

    test("statusBadge('error') is red [!!] (alias for failed)", () => {
      setColorMode('always');
      const badge = statusBadge('error');
      assert.match(badge, /\x1b\[31m/);
      assert.match(badge, /\[!!\]/);
    });

    test("statusBadge('missing') is gray [--]", () => {
      setColorMode('always');
      const badge = statusBadge('missing');
      assert.match(badge, /\x1b\[90m/);
      assert.match(badge, /\[--\]/);
    });

    test("statusBadge('timeout') is yellow [..]", () => {
      setColorMode('always');
      const badge = statusBadge('timeout');
      assert.match(badge, /\x1b\[33m/);
      assert.match(badge, /\[\.\.\]/);
    });

    test("statusBadge with unknown status falls through to gray [--]", () => {
      setColorMode('always');
      const badge = statusBadge('whatever');
      assert.match(badge, /\x1b\[90m/);
      assert.match(badge, /\[--\]/);
    });

    test("statusBadge('success') matches 'ok' (alias)", () => {
      setColorMode('always');
      const a = statusBadge('success');
      const b = statusBadge('ok');
      assert.strictEqual(a, b);
    });

    test('plain badges when colors off — all variants', () => {
      setColorMode('never');
      assert.strictEqual(statusBadge('ok'), '[OK]');
      assert.strictEqual(statusBadge('success'), '[OK]');
      assert.strictEqual(statusBadge('failed'), '[!!]');
      assert.strictEqual(statusBadge('error'), '[!!]');
      assert.strictEqual(statusBadge('missing'), '[--]');
      assert.strictEqual(statusBadge('timeout'), '[..]');
      assert.strictEqual(statusBadge('whatever'), '[--]');
    });
  });
});
