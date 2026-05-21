/**
 * Phase 7 / Task 4 — figma_update_token tests (RED phase).
 *
 * 9 cases per PLAN §Task 4:
 *   1) color new (no name match) → POST body action:CREATE, tempId, COLOR resolvedType
 *   2) color existing → action:UPDATE + looked-up id
 *   3) spacing → FLOAT
 *   4) typography → STRING
 *   5) invalid value shape (string for color) → zod error
 *   6) 403 PLAN_REQUIRED → returns {status:"plan_required",...} NOT throws (graceful)
 *   7) 403 TOKEN_EXPIRED → throws FigmaForbiddenError
 *   8) 200 success with tempIdToRealId → node_id returned correctly
 *   9) GET local fails 404 → error surfaces, no POST attempted
 */

import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  UPDATE_TOKEN_DEF,
  handleUpdateToken,
} from './update-token.js';
import { FigmaForbiddenError } from './rest-client.js';

const PAT = 'figd_test_AAAAAAAAAA';
const CTX_BASE = { workdir: '/tmp/test', pat: PAT };

interface ScriptStep {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

interface Recorded {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
}

function makeScriptedFetch(steps: ScriptStep[]): {
  fetchImpl: typeof fetch;
  requests: Recorded[];
} {
  const requests: Recorded[] = [];
  const queue = [...steps];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({ url, method, body, headers });
    const step = queue.shift();
    if (!step) throw new Error('scripted fetch exhausted');
    return new Response(JSON.stringify(step.body), {
      status: step.status,
      headers: { 'Content-Type': 'application/json', ...(step.headers ?? {}) },
    });
  };
  return { fetchImpl, requests };
}

/** Build a GET /local response with N variables. */
function localResponseWith(vars: Array<{ id: string; name: string; resolvedType: string }>): unknown {
  return {
    meta: {
      variables: Object.fromEntries(vars.map((v) => [v.id, v])),
      variableCollections: {
        'VariableCollectionId:1:0': {
          id: 'VariableCollectionId:1:0',
          name: 'Default',
          defaultModeId: '1:0',
        },
      },
    },
  };
}

describe('UPDATE_TOKEN_DEF', () => {
  test('has correct ToolDef shape and tool name', () => {
    assert.equal(UPDATE_TOKEN_DEF.type, 'function');
    assert.equal(UPDATE_TOKEN_DEF.function.name, 'figma_update_token');
    const required = (UPDATE_TOKEN_DEF.function.parameters as { required: string[] }).required;
    assert.ok(required.includes('file_key'));
    assert.ok(required.includes('token_name'));
    assert.ok(required.includes('value'));
    assert.ok(required.includes('type'));
    assert.ok(required.includes('collection_id'));
    assert.ok(!required.includes('mode_id'), 'mode_id is optional');
  });
});

describe('handleUpdateToken — type-mapping (CREATE path)', () => {
  test('1) color new → POST body action:CREATE, tempId, resolvedType:COLOR', async () => {
    const { fetchImpl, requests } = makeScriptedFetch([
      { status: 200, body: localResponseWith([]) }, // no existing match
      {
        status: 200,
        body: {
          status: 200, error: false,
          meta: { tempIdToRealId: { 'temp:color/primary': 'VariableID:1:42' } },
        },
      },
    ]);
    const out = await handleUpdateToken(
      {
        file_key: 'abc',
        token_name: 'color/primary',
        value: { r: 0.2, g: 0.4, b: 0.9, a: 1 },
        type: 'color',
        collection_id: 'VariableCollectionId:1:0',
      },
      { ...CTX_BASE, fetchImpl },
    ) as { status: string; node_id?: string };
    assert.equal(out.status, 'ok');
    assert.equal(out.node_id, 'VariableID:1:42');
    // GET first, POST second
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.method, 'GET');
    assert.match(requests[0]?.url ?? '', /\/v1\/files\/abc\/variables\/local/);
    assert.equal(requests[1]?.method, 'POST');
    assert.match(requests[1]?.url ?? '', /\/v1\/files\/abc\/variables$/);
    const postBody = JSON.parse(requests[1]?.body ?? '{}');
    const variable = postBody.variables[0];
    assert.equal(variable.action, 'CREATE');
    assert.equal(variable.name, 'color/primary');
    assert.equal(variable.resolvedType, 'COLOR');
    assert.equal(variable.variableCollectionId, 'VariableCollectionId:1:0');
    assert.ok(typeof variable.id === 'string' && variable.id.length > 0, 'CREATE must include tempId');
    const modeVal = postBody.variableModeValues[0];
    assert.equal(modeVal.variableId, variable.id);
    assert.deepEqual(modeVal.value, { r: 0.2, g: 0.4, b: 0.9, a: 1 });
  });

  test('3) spacing → resolvedType:FLOAT, value preserved as number', async () => {
    const { fetchImpl, requests } = makeScriptedFetch([
      { status: 200, body: localResponseWith([]) },
      { status: 200, body: { meta: { tempIdToRealId: { 'temp:gap': 'V:1' } } } },
    ]);
    await handleUpdateToken(
      {
        file_key: 'abc', token_name: 'space/gap', value: 16, type: 'spacing',
        collection_id: 'VariableCollectionId:1:0',
      },
      { ...CTX_BASE, fetchImpl },
    );
    const body = JSON.parse(requests[1]?.body ?? '{}');
    assert.equal(body.variables[0].resolvedType, 'FLOAT');
    assert.strictEqual(body.variableModeValues[0].value, 16);
  });

  test('4) typography → resolvedType:STRING, value preserved as string', async () => {
    const { fetchImpl, requests } = makeScriptedFetch([
      { status: 200, body: localResponseWith([]) },
      { status: 200, body: { meta: { tempIdToRealId: { 'temp:body': 'V:1' } } } },
    ]);
    await handleUpdateToken(
      {
        file_key: 'abc', token_name: 'font/body', value: 'Inter',
        type: 'typography', collection_id: 'VariableCollectionId:1:0',
      },
      { ...CTX_BASE, fetchImpl },
    );
    const body = JSON.parse(requests[1]?.body ?? '{}');
    assert.equal(body.variables[0].resolvedType, 'STRING');
    assert.strictEqual(body.variableModeValues[0].value, 'Inter');
  });
});

describe('handleUpdateToken — UPDATE path (existing variable)', () => {
  test('2) color existing → action:UPDATE with looked-up id', async () => {
    const { fetchImpl, requests } = makeScriptedFetch([
      {
        status: 200,
        body: localResponseWith([
          { id: 'VariableID:1:99', name: 'color/primary', resolvedType: 'COLOR' },
        ]),
      },
      { status: 200, body: { meta: { tempIdToRealId: {} } } },
    ]);
    const out = await handleUpdateToken(
      {
        file_key: 'abc', token_name: 'color/primary',
        value: { r: 1, g: 0, b: 0, a: 1 }, type: 'color',
        collection_id: 'VariableCollectionId:1:0',
      },
      { ...CTX_BASE, fetchImpl },
    ) as { status: string; node_id?: string };
    assert.equal(out.status, 'ok');
    assert.equal(out.node_id, 'VariableID:1:99', 'returns existing id on UPDATE');
    const postBody = JSON.parse(requests[1]?.body ?? '{}');
    const variable = postBody.variables[0];
    assert.equal(variable.action, 'UPDATE');
    assert.equal(variable.id, 'VariableID:1:99');
  });
});

describe('handleUpdateToken — zod validation', () => {
  test('5) string value for type=color → zod error', async () => {
    // No fetch will be made; pass an empty script.
    const { fetchImpl } = makeScriptedFetch([]);
    await assert.rejects(
      handleUpdateToken(
        {
          file_key: 'abc', token_name: 'color/primary',
          value: 'not a color', type: 'color',
          collection_id: 'VariableCollectionId:1:0',
        },
        { ...CTX_BASE, fetchImpl },
      ),
      /value|color/i,
    );
  });

  test('5b) number value for type=typography → zod error', async () => {
    const { fetchImpl } = makeScriptedFetch([]);
    await assert.rejects(
      handleUpdateToken(
        {
          file_key: 'abc', token_name: 'font/h1', value: 42, type: 'typography',
          collection_id: 'VariableCollectionId:1:0',
        },
        { ...CTX_BASE, fetchImpl },
      ),
      /value|typography|string/i,
    );
  });
});

describe('handleUpdateToken — 403 disambiguation (graceful vs throw)', () => {
  test('6) 403 PLAN_REQUIRED → returns {status:"plan_required"}, NOT throws', async () => {
    const { fetchImpl } = makeScriptedFetch([
      { status: 200, body: localResponseWith([]) },
      { status: 403, body: { reason: 'Variable writes require the Enterprise plan' } },
    ]);
    const out = await handleUpdateToken(
      {
        file_key: 'abc', token_name: 'color/primary',
        value: { r: 0, g: 0, b: 0, a: 1 }, type: 'color',
        collection_id: 'VariableCollectionId:1:0',
      },
      { ...CTX_BASE, fetchImpl },
    ) as { status: string; message?: string };
    assert.equal(out.status, 'plan_required');
    assert.ok(out.message && out.message.length > 0, 'must have a user-facing message');
    assert.match(out.message ?? '', /Enterprise|plan/i);
  });

  test('7) 403 TOKEN_EXPIRED → throws FigmaForbiddenError (NOT silently swallowed)', async () => {
    const { fetchImpl } = makeScriptedFetch([
      { status: 200, body: localResponseWith([]) },
      { status: 403, body: { reason: 'token expired' } },
    ]);
    await assert.rejects(
      handleUpdateToken(
        {
          file_key: 'abc', token_name: 'color/primary',
          value: { r: 0, g: 0, b: 0, a: 1 }, type: 'color',
          collection_id: 'VariableCollectionId:1:0',
        },
        { ...CTX_BASE, fetchImpl },
      ),
      (err) => {
        assert.ok(err instanceof FigmaForbiddenError);
        assert.equal((err as FigmaForbiddenError).kind, 'TOKEN_EXPIRED');
        return true;
      },
    );
  });
});

describe('handleUpdateToken — success path + GET local failure', () => {
  test('8) 200 success with tempIdToRealId → node_id returned correctly', async () => {
    const { fetchImpl } = makeScriptedFetch([
      { status: 200, body: localResponseWith([]) },
      { status: 200, body: { meta: { tempIdToRealId: { 'temp:radius/sm': 'VariableID:9:9' } } } },
    ]);
    const out = await handleUpdateToken(
      {
        file_key: 'abc', token_name: 'radius/sm', value: 4, type: 'spacing',
        collection_id: 'VariableCollectionId:1:0',
      },
      { ...CTX_BASE, fetchImpl },
    ) as { status: string; node_id?: string };
    assert.equal(out.status, 'ok');
    assert.equal(out.node_id, 'VariableID:9:9');
  });

  test('9) GET /local fails 404 → error surfaces, no POST attempted', async () => {
    const { fetchImpl, requests } = makeScriptedFetch([
      { status: 404, body: { reason: 'file not found' } },
    ]);
    await assert.rejects(
      handleUpdateToken(
        {
          file_key: 'missing', token_name: 'x', value: 1, type: 'spacing',
          collection_id: 'VariableCollectionId:1:0',
        },
        { ...CTX_BASE, fetchImpl },
      ),
    );
    assert.equal(requests.length, 1, 'must NOT attempt POST after GET local fails');
  });
});
