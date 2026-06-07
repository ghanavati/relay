/**
 * LLM-facing Relay control tools (Phase 8 / Plan 03 / Task 2).
 *
 * RED-stage stub: shapes only, no behavior. Implementation lands in the
 * GREEN commit of this task.
 */

import type { ToolDef } from '../workers/types.js';
import type { NamedToolHandler } from '../workers/lmstudio-agentic.js';
import type { ControlSessionStore } from './session-store.js';
import type { ControlBroker } from './broker.js';
import type { ControlSession } from './types.js';

export interface ControlToolDeps {
  readonly store?: ControlSessionStore;
  readonly broker?: ControlBroker;
}

export interface ControlToolHandler {
  readonly def: ToolDef;
  readonly handle: (args: unknown) => Promise<unknown>;
}

export const CONTROL_TOOL_DEFS: readonly ToolDef[] = [];

export function registerControlTools(
  _callerSessionId: string,
  _deps?: ControlToolDeps,
): ControlToolHandler[] {
  throw new Error('not implemented');
}

export function toNamedToolHandlers(_handlers: readonly ControlToolHandler[]): NamedToolHandler[] {
  throw new Error('not implemented');
}

export function createControlSessionForRun(
  _input: { run_id: string; workdir: string; model?: string | undefined; label?: string | undefined },
  _store?: ControlSessionStore,
  _now?: number,
): ControlSession {
  throw new Error('not implemented');
}

export function endControlSessionForRun(
  _session_id: string,
  _store?: ControlSessionStore,
  _now?: number,
): ControlSession | undefined {
  throw new Error('not implemented');
}
