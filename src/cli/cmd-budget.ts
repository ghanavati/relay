/**
 * `relay budget` — stub command for the deferred v0.2 budget surface.
 *
 * The full BudgetStore needs per-provider scope before it can be exposed via
 * the CLI (see CHANGELOG.md). This stub gives users an explicit, structured
 * forward-pointer instead of an "unknown command" error.
 */

import type { CliIO } from './commands.js';

export interface BudgetShowArgs {
  json: boolean;
  provider?: string;
  workdir?: string;
  period?: string;
}

export const BUDGET_DEFERRED_TARGET = '0.2.0';
export const BUDGET_DEFERRED_REASON = 'BudgetStore needs per-provider scope';
export const BUDGET_DEFERRED_MESSAGE = 'Deferred to v0.2 — see CHANGELOG.md';

export function executeBudgetShowCommand(args: BudgetShowArgs, io: CliIO): number {
  if (args.json) {
    const payload = {
      status: 'deferred',
      target_version: BUDGET_DEFERRED_TARGET,
      reason: BUDGET_DEFERRED_REASON,
    };
    io.stdout(`${JSON.stringify(payload)}\n`);
  } else {
    io.stdout(`${BUDGET_DEFERRED_MESSAGE}\n`);
  }
  return 0;
}
