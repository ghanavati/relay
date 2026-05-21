/**
 * Phase 7 / Task 6 — relay doctor --figma probe tests (RED phase).
 *
 * 6 cases:
 *   1) --figma no PAT → output 'PAT: absent' + deferred list
 *   2) --figma valid PAT + GET /v1/me 200 → 'PAT: present' + 'REST: ok'
 *   3) --figma valid PAT + 403 PLAN_REQUIRED → 'Plan: non-enterprise'
 *      (when /local probe used; or skip if we only do /me)
 *   4) --figma 403 expired (PAT invalid) → 'REST: failed' + 'TOKEN_EXPIRED', NO raw PAT
 *   5) deferred list reads from DEFERRED_FIGMA_TOOLS const (renamed if const changes)
 *   6) all output PAT-scrubbed (defense in depth via scrubPat layer)
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeFigma, formatFigmaProbeOutput } from './cmd-doctor-figma.js';

interface ScriptStep { status: number; body?: unknown; }

function makeScriptedFetch(steps: ScriptStep[]): typeof fetch {
  const queue = [...steps];
  return async () => {
    const step = queue.shift();
    if (!step) throw new Error('scripted fetch exhausted');
    return new Response(JSON.stringify(step.body ?? {}), {
      status: step.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

const PAT = 'figd_testpat_AAAAA';

describe('probeFigma — PAT presence', () => {
  let tempHome: string;
  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'fig-doctor-'));
    mkdirSync(join(tempHome, '.relay', 'secrets'), { recursive: true });
  });
  afterEach(() => rmSync(tempHome, { recursive: true, force: true }));

  test('1) no PAT → patPresent=false, restStatus=skipped', async () => {
    const result = await probeFigma({
      env: {} as NodeJS.ProcessEnv,
      homeDir: tempHome,
      fetchImpl: makeScriptedFetch([]), // never called
    });
    assert.equal(result.patPresent, false);
    assert.equal(result.restStatus, 'skipped');
    assert.equal(result.user, null);
  });

  test('2) valid PAT + GET /v1/me 200 → patPresent=true, restStatus=ok, user populated', async () => {
    const env = { FIGMA_API_TOKEN: PAT } as NodeJS.ProcessEnv;
    const result = await probeFigma({
      env, homeDir: tempHome,
      fetchImpl: makeScriptedFetch([
        { status: 200, body: { id: '123', email: 'designer@example.com', handle: 'designer' } },
      ]),
    });
    assert.equal(result.patPresent, true);
    assert.equal(result.restStatus, 'ok');
    assert.equal(result.user, 'designer (123)');
  });

  test('4) 403 token-expired → restStatus=failed, restDetail includes TOKEN_EXPIRED, NO raw PAT', async () => {
    const env = { FIGMA_API_TOKEN: PAT } as NodeJS.ProcessEnv;
    const result = await probeFigma({
      env, homeDir: tempHome,
      fetchImpl: makeScriptedFetch([
        { status: 403, body: { reason: 'token expired' } },
      ]),
    });
    assert.equal(result.patPresent, true);
    assert.equal(result.restStatus, 'failed');
    assert.match(result.restDetail, /TOKEN_EXPIRED/);
    assert.doesNotMatch(result.restDetail, /figd_testpat_AAAAA/);
  });

  test('PAT-file source — chmod 600 → patPresent=true; chmod 644 → patPresent=false', async () => {
    const filePath = join(tempHome, '.relay', 'secrets', 'figma.json');
    writeFileSync(filePath, JSON.stringify({ token: PAT }), { mode: 0o600 });
    chmodSync(filePath, 0o600);
    let result = await probeFigma({
      env: {} as NodeJS.ProcessEnv, homeDir: tempHome,
      fetchImpl: makeScriptedFetch([{ status: 200, body: { id: '1', email: 'a@b', handle: 'a' } }]),
    });
    assert.equal(result.patPresent, true);

    chmodSync(filePath, 0o644);
    result = await probeFigma({
      env: {} as NodeJS.ProcessEnv, homeDir: tempHome,
      fetchImpl: makeScriptedFetch([]),
    });
    assert.equal(result.patPresent, false, 'chmod 644 must trigger pat-loader refusal');
  });
});

describe('formatFigmaProbeOutput — render contract', () => {
  test('5) deferred list rendered exactly from DEFERRED_FIGMA_TOOLS const', () => {
    const out = formatFigmaProbeOutput({
      patPresent: true,
      restStatus: 'ok',
      restDetail: 'reachable',
      user: 'designer (1)',
    });
    // Both deferred names must appear with deferral context.
    assert.match(out, /figma_get_selection/);
    assert.match(out, /figma_create_component/);
    assert.match(out, /v0\.3|Plugin API|deferred/i);
  });

  test('1b) absent PAT → output contains "PAT: absent" + actionable hint', () => {
    const out = formatFigmaProbeOutput({
      patPresent: false,
      restStatus: 'skipped',
      restDetail: 'no PAT to probe',
      user: null,
    });
    assert.match(out, /PAT:.*absent/);
    assert.match(out, /FIGMA_API_TOKEN|~\/\.relay\/secrets\/figma\.json/);
  });

  test('PAT present + REST ok → "REST: ok" shown', () => {
    const out = formatFigmaProbeOutput({
      patPresent: true,
      restStatus: 'ok',
      restDetail: 'reachable',
      user: 'd (1)',
    });
    assert.match(out, /REST:.*ok/);
    assert.match(out, /PAT:.*present/);
  });

  test('6) PAT in restDetail is scrubbed (defense-in-depth)', () => {
    // Hypothetical: even if a PAT slipped through, the formatter must scrub.
    const out = formatFigmaProbeOutput({
      patPresent: true,
      restStatus: 'failed',
      restDetail: 'Failed with figd_LEAK_should_be_masked_xyz in error',
      user: null,
    });
    assert.doesNotMatch(out, /figd_LEAK_should_be_masked_xyz/);
    assert.match(out, /figd_\*\*\*SCRUBBED\*\*\*/);
  });
});
