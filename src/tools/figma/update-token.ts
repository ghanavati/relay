/**
 * Phase 7 / Task 4 — figma_update_token tool.
 *
 * CREATE or UPDATE a Figma variable (design token). REST only. Two-call sequence:
 *   1. GET /v1/files/{key}/variables/local — lookup by token_name
 *   2. POST /v1/files/{key}/variables — action:CREATE (with tempId) or UPDATE (existing id)
 *
 * Enterprise plan gate (T-07-06, PITFALLS 5.2):
 *   - 403 with kind=PLAN_REQUIRED → return {status:"plan_required", message: ...}
 *     (graceful surface for the model — NOT a throw)
 *   - Other 403 kinds → throw FigmaForbiddenError (TOKEN_EXPIRED etc are real errors)
 *
 * Type mapping per FIGMA-API-TOOLS.md:156-162:
 *   color → COLOR (value: {r, g, b, a} floats 0-1)
 *   spacing → FLOAT (value: number, e.g. px)
 *   typography → STRING (value: font family name)
 */

import { z } from 'zod';
import type { ToolDef } from '../../workers/types.js';
import { figmaGet, figmaPost, FigmaForbiddenError, type FetchFn, type SleepFn } from './rest-client.js';

// ─── Args schema ────────────────────────────────────────────────────────

const COLOR_VALUE = z.object({
  r: z.number(),
  g: z.number(),
  b: z.number(),
  a: z.number(),
});

const TOKEN_TYPE = z.enum(['color', 'spacing', 'typography']);

// Union with per-type value shape — zod parses the type discriminator first
// then enforces the value shape. Cleaner error messages than oneOf.
const UPDATE_TOKEN_ARGS = z.union([
  z.object({
    file_key: z.string().min(1),
    token_name: z.string().min(1),
    type: z.literal('color'),
    value: COLOR_VALUE,
    collection_id: z.string().min(1),
    mode_id: z.string().min(1).optional(),
  }),
  z.object({
    file_key: z.string().min(1),
    token_name: z.string().min(1),
    type: z.literal('spacing'),
    value: z.number(),
    collection_id: z.string().min(1),
    mode_id: z.string().min(1).optional(),
  }),
  z.object({
    file_key: z.string().min(1),
    token_name: z.string().min(1),
    type: z.literal('typography'),
    value: z.string(),
    collection_id: z.string().min(1),
    mode_id: z.string().min(1).optional(),
  }),
]);

// ─── ToolDef ────────────────────────────────────────────────────────────

export const UPDATE_TOKEN_DEF: ToolDef = {
  type: 'function',
  function: {
    name: 'figma_update_token',
    description:
      'Create or update a design token (Figma variable). Requires Enterprise plan and ' +
      'file_variables:write scope. Supports color {r,g,b,a 0-1}, spacing (number px), and ' +
      'typography (font-family string) types. Returns {status:"ok", node_id} on success, ' +
      '{status:"plan_required", message} when caller is on a non-Enterprise plan.',
    parameters: {
      type: 'object',
      properties: {
        file_key: { type: 'string' },
        token_name: { type: 'string', description: 'Variable name, unique within collection' },
        value: { description: 'Color {r,g,b,a} floats 0-1 OR number (spacing) OR string (font family)' },
        type: { type: 'string', enum: ['color', 'spacing', 'typography'] },
        collection_id: { type: 'string', description: 'variableCollectionId from GET local variables' },
        mode_id: { type: 'string', description: 'modeId (default: collection.defaultModeId)' },
      },
      required: ['file_key', 'token_name', 'value', 'type', 'collection_id'],
    },
  },
};

// ─── Helpers ────────────────────────────────────────────────────────────

const RESOLVED_TYPE_MAP = {
  color: 'COLOR',
  spacing: 'FLOAT',
  typography: 'STRING',
} as const;

interface LocalVariable {
  id: string;
  name: string;
  resolvedType: string;
}

interface LocalCollection {
  id: string;
  name: string;
  defaultModeId: string;
}

interface LocalResponse {
  meta?: {
    variables?: Record<string, LocalVariable>;
    variableCollections?: Record<string, LocalCollection>;
  };
}

/**
 * Look up an existing variable by name. Returns null when not present.
 * Pure: no IO.
 */
function findExistingByName(local: LocalResponse, name: string): LocalVariable | null {
  const vars = local.meta?.variables ?? {};
  for (const v of Object.values(vars)) {
    if (v.name === name) return v;
  }
  return null;
}

/** Look up a collection's defaultModeId. Returns null when unknown. */
function findCollectionDefaultMode(local: LocalResponse, collectionId: string): string | null {
  const col = local.meta?.variableCollections?.[collectionId];
  return col?.defaultModeId ?? null;
}

// ─── Public handler ────────────────────────────────────────────────────

interface HandlerCtx {
  workdir: string;
  pat: string;
  fetchImpl?: FetchFn;
  sleepImpl?: SleepFn;
}

export interface UpdateTokenResult {
  status: 'ok' | 'plan_required';
  node_id?: string;
  message?: string;
}

export async function handleUpdateToken(
  args: unknown,
  ctx: HandlerCtx,
): Promise<UpdateTokenResult> {
  const parsed = UPDATE_TOKEN_ARGS.parse(args);
  const fetchImpl = ctx.fetchImpl;
  const sleepImpl = ctx.sleepImpl;

  // Call 1: GET local — lookup by name AND find default modeId when caller didn't provide one.
  // Errors (404/403/etc) propagate unchanged — atomicity: no POST attempted on lookup failure.
  const local = (await figmaGet(
    `/v1/files/${encodeURIComponent(parsed.file_key)}/variables/local`,
    { pat: ctx.pat, fetchImpl, sleepImpl },
  )) as LocalResponse;

  const existing = findExistingByName(local, parsed.token_name);
  const modeId = parsed.mode_id ?? findCollectionDefaultMode(local, parsed.collection_id) ?? '1:0';
  const resolvedType = RESOLVED_TYPE_MAP[parsed.type];

  // Build POST body — CREATE (with tempId) vs UPDATE (with existing id).
  const variableId = existing ? existing.id : `temp:${parsed.token_name}`;
  const variables = [
    existing
      ? {
          action: 'UPDATE' as const,
          id: existing.id,
          name: parsed.token_name,
          variableCollectionId: parsed.collection_id,
          resolvedType,
        }
      : {
          action: 'CREATE' as const,
          id: variableId,
          name: parsed.token_name,
          variableCollectionId: parsed.collection_id,
          resolvedType,
        },
  ];
  const variableModeValues = [
    { variableId, modeId, value: parsed.value },
  ];

  // Call 2: POST update. 403 PLAN_REQUIRED is the only graceful-return case.
  try {
    const response = (await figmaPost(
      `/v1/files/${encodeURIComponent(parsed.file_key)}/variables`,
      { variables, variableModeValues },
      { pat: ctx.pat, fetchImpl, sleepImpl },
    )) as { meta?: { tempIdToRealId?: Record<string, string> } };
    const realId = response.meta?.tempIdToRealId?.[variableId];
    return {
      status: 'ok',
      node_id: realId ?? existing?.id ?? variableId,
    };
  } catch (err) {
    if (err instanceof FigmaForbiddenError && err.kind === 'PLAN_REQUIRED') {
      return {
        status: 'plan_required',
        message:
          'Variable writes require the Figma Enterprise plan with file_variables:write scope. ' +
          'See: relay doctor --figma',
      };
    }
    throw err;
  }
}
