import { afterEach, test } from 'node:test';
import * as assert from 'node:assert/strict';

import { OmlxAgenticRunner } from './omlx-agentic.js';
import { DEFAULT_AGENTIC_TOOLS, type FetchFn } from './lmstudio-agentic.js';

const originalEndpoint = process.env['OMLX_ENDPOINT'];
const originalKey = process.env['OMLX_API_KEY'];

afterEach(() => {
  if (originalEndpoint === undefined) delete process.env['OMLX_ENDPOINT']; else process.env['OMLX_ENDPOINT'] = originalEndpoint;
  if (originalKey === undefined) delete process.env['OMLX_API_KEY']; else process.env['OMLX_API_KEY'] = originalKey;
});

test('uses the oMLX endpoint without LM Studio capability metadata', async () => {
  process.env['OMLX_ENDPOINT'] = 'http://omlx.test:8000';
  process.env['OMLX_API_KEY'] = 'test-key';
  const calls: string[] = [];
  const fetchImpl: FetchFn = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'done' } }] }), { status: 200 });
  };
  const runner = new OmlxAgenticRunner({ fetchImpl });

  const result = await runner.run({
    task: 'say done', workdir: '/tmp', timeout_ms: 1_000, model: 'model-a',
    tools: DEFAULT_AGENTIC_TOOLS, run_id: 'r1', provider: 'omlx-agentic',
  });

  assert.equal(result.status, 'success');
  assert.deepEqual(calls, ['http://omlx.test:8000/v1/chat/completions']);
});
