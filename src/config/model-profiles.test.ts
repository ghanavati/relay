import { afterEach, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveModelInferenceProfile } from './model-profiles.js';

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function profilePath(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'relay-profile-test.'));
  tempPaths.push(dir);
  const path = join(dir, 'profiles.json');
  await writeFile(path, content);
  return path;
}

test('returns an empty profile when no profile path is configured', async () => {
  assert.deepEqual(await resolveModelInferenceProfile('model-a', {}), {});
});

test('resolves an exact model profile including template kwargs', async () => {
  const path = await profilePath(JSON.stringify({ models: {
    'gemma-test': {
      temperature: 0.2,
      max_tokens: 4096,
      max_iterations: 8,
      chat_template_kwargs: { enable_thinking: false, nested: { mode: 'safe' } },
    },
  } }));

  const actual = await resolveModelInferenceProfile('gemma-test', { RELAY_INFERENCE_PROFILES_PATH: path });

  assert.deepEqual(actual, {
    temperature: 0.2,
    max_tokens: 4096,
    max_iterations: 8,
    chat_template_kwargs: { enable_thinking: false, nested: { mode: 'safe' } },
  });
  assert.deepEqual(await resolveModelInferenceProfile('other', { RELAY_INFERENCE_PROFILES_PATH: path }), {});
});

test('rejects malformed or unknown profile configuration', async () => {
  const malformed = await profilePath('{');
  await assert.rejects(
    resolveModelInferenceProfile('model-a', { RELAY_INFERENCE_PROFILES_PATH: malformed }),
    { code: 'CONFIG_ERROR' },
  );
  const unknown = await profilePath(JSON.stringify({ models: { 'model-a': { temperature: 0.2, extra: true } } }));
  await assert.rejects(
    resolveModelInferenceProfile('model-a', { RELAY_INFERENCE_PROFILES_PATH: unknown }),
    { code: 'CONFIG_ERROR' },
  );
});
