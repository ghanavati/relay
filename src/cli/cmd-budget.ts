// TODO: add budget-limit enforcement command (`relay budget set-limit` + check on event insert).

/**
 * `relay budget show` — v0.2 implementation.
 *
 * Sums `cost_events.cost_usd` scoped by optional `--provider`, `--workdir`,
 * and `--period` filters. Two output modes:
 *
 *   default (human)  — single line: `Total: $X.XXXX across N events` with an
 *                      optional header listing applied filters.
 *   --json           — single-line JSON envelope pinned to `schema_version: 1`
 *                      so downstream consumers can rely on a stable shape.
 *
 * Exit codes:
 *   0  success
 *   2  bad/unknown --period value (only validated arg at this layer; provider
 *      and workdir are free-form strings bound as SQL parameters)
 *
 * Replaces the v0.1 deferred stub.
 */

import { resolve as resolvePath, isAbsolute } from 'node:path';
import type { CliIO } from './commands.js';

export interface BudgetShowArgs {
  json: boolean;
  provider?: string;
  workdir?: string;
  period?: string;
}

/** Stable downstream contract version for the `--json` envelope. */
export const BUDGET_SHOW_SCHEMA_VERSION = 1;

const VALID_PERIODS = ['daily', 'monthly', 'alltime'] as const;
type ValidPeriod = typeof VALID_PERIODS[number];

function isValidPeriod(p: string): p is ValidPeriod {
  return (VALID_PERIODS as readonly string[]).includes(p);
}

/**
 * Singularize 'event' so `1 event` reads naturally without an `(s)` patch.
 */
function eventsPhrase(count: number): string {
  return count === 1 ? '1 event' : `${count} events`;
}

export async function executeBudgetShowCommand(
  args: BudgetShowArgs,
  io: CliIO,
): Promise<number> {
  // ── Validate --period (only typed arg at this CLI layer) ──────────────────
  let period: ValidPeriod | undefined;
  if (args.period !== undefined && args.period !== '') {
    if (!isValidPeriod(args.period)) {
      io.stderr(
        `unknown --period value '${args.period}'. Try: ${VALID_PERIODS.join(', ')}\n`,
      );
      return 2;
    }
    period = args.period;
  }

  // ── Resolve relative --workdir against io.cwd (cost_events.workdir stores
  //    absolute paths, so a relative input must be resolved before binding).
  const workdir =
    args.workdir !== undefined && args.workdir !== ''
      ? (isAbsolute(args.workdir) ? args.workdir : resolvePath(io.cwd, args.workdir))
      : undefined;
  const provider = args.provider !== undefined && args.provider !== '' ? args.provider : undefined;

  // ── Dynamic import keeps cold-start fast (matches sibling commands) ──────
  const { BudgetStore } = await import('../runtime/budget/budget-store.js');
  const store = new BudgetStore();
  const usage = store.getUsage({ provider, workdir, sincePeriod: period });

  if (args.json) {
    io.stdout(
      JSON.stringify({
        schema_version: BUDGET_SHOW_SCHEMA_VERSION,
        total_usd: usage.total_usd,
        event_count: usage.event_count,
        scope_filters: usage.scope_filters,
      }) + '\n',
    );
    return 0;
  }

  // Human output — header lists applied filters (if any), body shows totals.
  const filterParts: string[] = [];
  if (provider) filterParts.push(`provider=${provider}`);
  if (workdir) filterParts.push(`workdir=${workdir}`);
  if (period) filterParts.push(`period=${period}`);
  if (filterParts.length > 0) {
    io.stdout(`Filters: ${filterParts.join(', ')}\n`);
  }
  io.stdout(`Total: $${usage.total_usd.toFixed(4)} across ${eventsPhrase(usage.event_count)}\n`);
  return 0;
}
