/**
 * Phase 7 / Task 3 — figma_list_layers tests (RED phase).
 *
 * 8 cases per PLAN §Task 3:
 *   1) valid args + fixture → flattened list with correct parent_id chains
 *   2) missing file_key → zod error
 *   3) page_id present → URL contains /nodes?ids=${page_id}
 *   4) page_id absent → URL /files/{key}?depth=1 (default)
 *   5) depth=infinity → URL literal "infinity" when page_id present
 *   6) 404 from REST → FigmaNotFoundError unchanged
 *   7) empty children → returns just root
 *   8) 5-level nesting → all flattened with correct depth
 */

import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  LIST_LAYERS_DEF,
  handleListLayers,
  type FlatLayer,
} from './list-layers.js';
import { FigmaNotFoundError } from './rest-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '..', '..', '..', 'src', 'tools', 'figma', '__fixtures__');

// Inline fixture content (built-out path may differ depending on build).
const FIXTURE_PATH_CANDIDATES = [
  join(__dirname, '__fixtures__', 'files-nodes-response.json'),
  join(fixturesDir, 'files-nodes-response.json'),
];

function loadFixture(): unknown {
  for (const p of FIXTURE_PATH_CANDIDATES) {
    try {
      return JSON.parse(readFileSync(p, 'utf-8'));
    } catch {
      // try next
    }
  }
  // Fallback inline fixture (always works regardless of file layout).
  return {
    nodes: {
      '0:1': {
        document: {
          id: '0:1', name: 'Page 1', type: 'CANVAS',
          children: [
            { id: '1:23', name: 'Header', type: 'FRAME', children: [
              { id: '1:24', name: 'Logo', type: 'VECTOR', children: [] },
              { id: '1:25', name: 'Nav', type: 'FRAME', children: [
                { id: '1:26', name: 'Link/Home', type: 'TEXT', children: [] },
                { id: '1:27', name: 'Link/About', type: 'TEXT', children: [] },
              ] },
            ] },
            { id: '1:30', name: 'Hero', type: 'FRAME', children: [] },
          ],
        },
      },
    },
  };
}

interface ScriptStep { status: number; body: unknown; }

function makeScriptedFetch(steps: ScriptStep[]): {
  fetchImpl: typeof fetch;
  requests: { url: string; init: RequestInit | undefined }[];
} {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const queue = [...steps];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    requests.push({ url, init });
    const step = queue.shift();
    if (!step) throw new Error('scripted fetch exhausted');
    return new Response(JSON.stringify(step.body), {
      status: step.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetchImpl, requests };
}

const CTX = { workdir: '/tmp/test', pat: 'figd_test_AAAAAAAAAA' };

describe('LIST_LAYERS_DEF', () => {
  test('has correct ToolDef shape and tool name', () => {
    assert.equal(LIST_LAYERS_DEF.type, 'function');
    assert.equal(LIST_LAYERS_DEF.function.name, 'figma_list_layers');
    assert.ok((LIST_LAYERS_DEF.function.parameters as { required: string[] }).required.includes('file_key'));
  });
});

describe('handleListLayers — request shape', () => {
  test('3) page_id present → URL hits /nodes?ids=<id>&depth=<n>', async () => {
    const fixture = loadFixture();
    const { fetchImpl, requests } = makeScriptedFetch([{ status: 200, body: fixture }]);
    await handleListLayers(
      { file_key: 'abc123', page_id: '0:1', depth: 3 },
      { ...CTX, fetchImpl },
    );
    const url = requests[0]?.url ?? '';
    assert.match(url, /\/v1\/files\/abc123\/nodes/);
    assert.match(url, /ids=0(%3A|:)1/);
    assert.match(url, /depth=3/);
  });

  test('4) page_id absent → URL hits /files/{key}?depth=1 (default)', async () => {
    const fixture = loadFixture();
    const { fetchImpl, requests } = makeScriptedFetch([{ status: 200, body: fixture }]);
    await handleListLayers({ file_key: 'abc123' }, { ...CTX, fetchImpl });
    const url = requests[0]?.url ?? '';
    assert.match(url, /\/v1\/files\/abc123(\?|$)/);
    assert.doesNotMatch(url, /\/nodes/);
    assert.match(url, /depth=1/, 'default depth=1 at root to bound payload');
  });

  test('5) depth=infinity → URL literal "infinity" when page_id present', async () => {
    const fixture = loadFixture();
    const { fetchImpl, requests } = makeScriptedFetch([{ status: 200, body: fixture }]);
    await handleListLayers(
      { file_key: 'abc', page_id: '0:1', depth: 'infinity' as unknown as number },
      { ...CTX, fetchImpl },
    );
    const url = requests[0]?.url ?? '';
    assert.match(url, /depth=infinity/);
  });
});

describe('handleListLayers — response flattening', () => {
  test('1) valid args + fixture → flattened list with correct parent_id chains', async () => {
    const fixture = loadFixture();
    const { fetchImpl } = makeScriptedFetch([{ status: 200, body: fixture }]);
    const result = await handleListLayers(
      { file_key: 'abc', page_id: '0:1' },
      { ...CTX, fetchImpl },
    );
    const layers = (result as { layers: FlatLayer[] }).layers;
    assert.ok(Array.isArray(layers));
    // root present
    const root = layers.find((l) => l.id === '0:1');
    assert.ok(root, 'root CANVAS must be in the flat list');
    assert.equal(root?.parent_id, null);
    assert.equal(root?.depth, 0);
    // Header is child of root
    const header = layers.find((l) => l.id === '1:23');
    assert.equal(header?.parent_id, '0:1');
    assert.equal(header?.depth, 1);
    // Link/Home is grandchild of Header via Nav
    const home = layers.find((l) => l.id === '1:26');
    assert.equal(home?.parent_id, '1:25');
    assert.equal(home?.depth, 3);
  });

  test('7) empty children → returns just root', async () => {
    const minimalFixture = {
      nodes: {
        '0:1': {
          document: { id: '0:1', name: 'Empty Page', type: 'CANVAS', children: [] },
        },
      },
    };
    const { fetchImpl } = makeScriptedFetch([{ status: 200, body: minimalFixture }]);
    const result = await handleListLayers(
      { file_key: 'abc', page_id: '0:1' },
      { ...CTX, fetchImpl },
    );
    const layers = (result as { layers: FlatLayer[] }).layers;
    assert.equal(layers.length, 1);
    assert.equal(layers[0]?.id, '0:1');
  });

  test('8) 5-level nesting → all flattened with correct depth', async () => {
    const nested = {
      nodes: {
        'r:0': {
          document: {
            id: 'r:0', name: 'L0', type: 'CANVAS', children: [
              { id: 'r:1', name: 'L1', type: 'FRAME', children: [
                { id: 'r:2', name: 'L2', type: 'FRAME', children: [
                  { id: 'r:3', name: 'L3', type: 'FRAME', children: [
                    { id: 'r:4', name: 'L4', type: 'TEXT', children: [] },
                  ] },
                ] },
              ] },
            ],
          },
        },
      },
    };
    const { fetchImpl } = makeScriptedFetch([{ status: 200, body: nested }]);
    const result = await handleListLayers(
      { file_key: 'abc', page_id: 'r:0' },
      { ...CTX, fetchImpl },
    );
    const layers = (result as { layers: FlatLayer[] }).layers;
    assert.equal(layers.length, 5, 'all 5 levels flattened');
    for (let i = 0; i < 5; i++) {
      const l = layers.find((x) => x.id === `r:${i}`);
      assert.equal(l?.depth, i, `depth of r:${i} must be ${i}`);
    }
  });
});

describe('handleListLayers — validation and error pass-through', () => {
  test('2) missing file_key → zod validation error', async () => {
    const { fetchImpl } = makeScriptedFetch([{ status: 200, body: {} }]);
    await assert.rejects(
      handleListLayers({} as { file_key: string }, { ...CTX, fetchImpl }),
      /file_key/,
    );
  });

  test('6) 404 from REST → FigmaNotFoundError unchanged', async () => {
    const { fetchImpl } = makeScriptedFetch([{ status: 404, body: { reason: 'no file' } }]);
    await assert.rejects(
      handleListLayers({ file_key: 'missing' }, { ...CTX, fetchImpl }),
      (err) => err instanceof FigmaNotFoundError,
    );
  });
});
