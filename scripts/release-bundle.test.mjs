import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { createBundlePlan } from './release-bundle.mjs';

test('creates a self-contained macOS arm64 release plan', () => {
  const plan = createBundlePlan({
    version: '0.4.0-beta.1',
    platform: 'darwin',
    arch: 'arm64',
  });

  assert.equal(plan.archiveName, 'relay-v0.4.0-beta.1-darwin-arm64.tar.gz');
  assert.deepEqual(plan.requiredPaths, [
    'relay',
    'runtime/bin/node',
    'app/dist/cli.js',
    'app/node_modules',
    'RELEASE.json',
  ]);
});

test('rejects unsupported release targets', () => {
  assert.throws(
    () => createBundlePlan({ version: '0.4.0-beta.1', platform: 'win32', arch: 'x64' }),
    /Unsupported release target: win32-x64/,
  );
});

test('release workflow builds the supported archives and publishes a prerelease', async () => {
  const workflow = await readFile(resolve('.github/workflows/release.yml'), 'utf8');

  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /platform: darwin\s+arch: arm64/);
  assert.match(workflow, /platform: darwin\s+arch: x64/);
  assert.match(workflow, /platform: linux\s+arch: x64/);
  assert.match(workflow, /SHA256SUMS\.txt/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /--prerelease/);
});
