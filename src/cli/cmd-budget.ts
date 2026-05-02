import type { CliIO } from './commands.js';
import { handleSetBudgetLimit } from '../tools/set-budget-limit.js';
import { handleListBudgetLimits } from '../tools/list-budget-limits.js';
import type { SetBudgetLimitArgs, ListBudgetLimitsArgs } from '../contracts/budget.js';

export interface BudgetSetArgs {
  provider: string;
  usd: number;
  json: boolean;
}

export interface BudgetShowArgs {
  provider?: string;
  json: boolean;
}

function getSetBudgetLimitArgs(args: { provider: string; usd: number }): SetBudgetLimitArgs {
  return {
    scope: 'owner',
    scope_value: args.provider,
    limit_usd: args.usd,
    period: 'monthly',
  };
}

function getShowBudgetLimitsArgs(args: { provider?: string }): ListBudgetLimitsArgs {
  const { provider } = args;
  const result: ListBudgetLimitsArgs = {};
  if (provider) {
    result.scope = 'owner';
    result.scope_value = provider;
  }
  return result;
}

function formatBudgetRow(limit: {
  limit_id: string;
  scope: BudgetScope;
  scope_value: string;
  limit_usd: number;
  period: BudgetPeriod;
  created_at: number;
  updated_at: number;
}): string {
  return `${limit.scope_value.padEnd(12)}${limit.limit_usd.toFixed(2).padEnd(12)}${'N/A'.padEnd(8)}${(limit.limit_usd - 0).toFixed(2).padEnd(8)}`;
}

async function executeBudgetSetCommand(args: BudgetSetArgs, io: CliIO): Promise<number> {
  const setArgs = getSetBudgetLimitArgs(args);
  const response = handleSetBudgetLimit(setArgs);

  if (args.json && response.content.length > 0) {
    io.stdout(response.content[0].text);
  } else {
    io.stdout(`Budget set: ${args.provider} $${args.usd.toFixed(2)}/month`);
  }

  return response.isError ? 1 : 0;
}

async function executeBudgetShowCommand(args: BudgetShowArgs, io: CliIO): Promise<number> {
  const showArgs = getShowBudgetLimitsArgs(args);
  const response = handleListBudgetLimits(showArgs);

  if (response.isError) {
    return 1;
  }

  if (args.json && response.content.length > 0) {
    io.stdout(response.content[0].text);
    return 0;
  }

  // Text mode table
  const limits: any[] = JSON.parse(response.content[0].text);
  const rows = limits.limits || [];

  io.stdout(
    `Provider     Monthly Cap   Spent   Remaining${'\n'}${'---'.repeat(30)}`,
  );

  for (const limit of rows) {
    io.stdout(formatBudgetRow(limit));
  }

  return 0;
}

export { executeBudgetSetCommand, executeBudgetShowCommand };