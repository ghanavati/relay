/**
 * `relay session ...` — human control surface over the universal control
 * layer (Phase 8 / Plan 03 / Task 1).
 *
 * RED-stage stub: shapes only, no behavior. Implementation lands in the
 * GREEN commit of this task.
 */

import type { CliIO } from './commands.js';
import type { ControlSessionStore } from '../control/session-store.js';
import type { ControlBroker } from '../control/broker.js';
import type { ControlAdapterRegistry } from '../control/adapter-registry.js';

export interface SessionCommandOptions {
  readonly action: string;
  readonly positionals: readonly string[];
  readonly provider?: string | undefined;
  readonly state?: string | undefined;
  readonly after?: string | undefined;
  readonly limit?: string | undefined;
  readonly from?: string | undefined;
  readonly ttl?: string | undefined;
  readonly maxMessages?: string | undefined;
  readonly expiresIn?: string | undefined;
  readonly noDeliver?: boolean | undefined;
  readonly json: boolean;
}

export interface SessionCommandDeps {
  readonly store?: ControlSessionStore;
  readonly broker?: ControlBroker;
  readonly registry?: ControlAdapterRegistry;
}

export function parseDurationMs(_raw: string): number {
  throw new Error('not implemented');
}

export async function executeSessionCommand(
  _options: SessionCommandOptions,
  _io: CliIO,
  _deps?: SessionCommandDeps,
): Promise<number> {
  throw new Error('not implemented');
}
