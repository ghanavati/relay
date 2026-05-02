import { BudgetStore } from '../runtime/budget/budget-store.js';
import type { ListBudgetLimitsArgs } from '../contracts/budget.js';

type McpToolResult = { content: Array<{ type: 'text'; text: string }> };

export function handleListBudgetLimits(args: ListBudgetLimitsArgs): McpToolResult {
  const store = new BudgetStore();
  const limits = store.listBudgetLimits(args);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ count: limits.length, limits }),
    }],
  };
}
