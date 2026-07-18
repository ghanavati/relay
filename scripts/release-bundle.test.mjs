import assert from 'node:assert/strict';
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
