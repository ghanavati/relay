/**
 * Phase 7 / Task 5 — Figma tool registry.
 *
 * Entry point for the agentic worker. Returns `null` when PAT is absent
 * (FIGMA-03 graceful absence — model sees zero Figma tools, no startup
 * error). Returns a 2-element handler array when PAT is loadable.
 *
 * Single source of truth for v0.3 deferral: `DEFERRED_FIGMA_TOOLS` is a
 * readonly tuple. `relay doctor --figma` and any CLI --help generator
 * read this constant — changing it propagates everywhere.
 *
 * Design rule: NO function exports here match the deferred names
 * (declarative absence, NOT a stub). Mid-task, if a model emits
 * `figma_get_selection`, the worker's "unknown tool" path catches it —
 * the model gets a clear ERROR back and can self-correct.
 */

import type { ToolDef } from '../../workers/types.js';
import { loadPat } from './pat-loader.js';
import { LIST_LAYERS_DEF, handleListLayers } from './list-layers.js';
import { UPDATE_TOKEN_DEF, handleUpdateToken } from './update-token.js';
import type { FetchFn, SleepFn } from './rest-client.js';

/** Per-handler context passed at dispatch time. */
export interface FigmaHandlerCtx {
  workdir: string;
  pat: string;
  fetchImpl?: FetchFn;
  sleepImpl?: SleepFn;
}

/**
 * Contract this plan produces. Each handler carries its OpenAI ToolDef +
 * an async dispatch function. The worker spreads `def` into `tools[]` and
 * looks up `handle` by name when a tool_call arrives.
 */
export interface FigmaToolHandler {
  def: ToolDef;
  handle: (args: unknown, ctx: FigmaHandlerCtx) => Promise<unknown>;
}

/**
 * Plugin-bridge tools (figma_get_selection, figma_create_component) require
 * the Figma Plugin API via a WebSocket Desktop Bridge — wholly v0.3 work.
 * Surfaced via `relay doctor --figma` so users know what's coming and don't
 * mistake registry omission for a bug. NO function exports match these names
 * — declarative absence (NOT stubs, NOT "v1 minimal").
 */
export const DEFERRED_FIGMA_TOOLS = ['figma_get_selection', 'figma_create_component'] as const;
export type DeferredFigmaToolName = typeof DEFERRED_FIGMA_TOOLS[number];

/**
 * Resolve PAT and build the active handler list.
 *
 * @param env     process env (passed in for testability — NEVER reads process.env directly)
 * @param homeDir absolute home path (os.homedir() at call sites)
 * @returns 2-elem FigmaToolHandler[] when PAT is loadable, null otherwise
 *
 * Caller (lmstudio-agentic dispatch / cmd-run) uses null as the signal to
 * skip registration entirely — no `tools.push` happens, no startup error.
 */
export function registerFigmaTools(
  env: NodeJS.ProcessEnv,
  homeDir: string,
): FigmaToolHandler[] | null {
  const pat = loadPat(env, homeDir);
  if (!pat) return null;
  return [
    { def: LIST_LAYERS_DEF, handle: handleListLayers as FigmaToolHandler['handle'] },
    { def: UPDATE_TOKEN_DEF, handle: handleUpdateToken as FigmaToolHandler['handle'] },
  ];
}
