import { BudgetStore } from '../runtime/budget/budget-store.js';
import type { SetBudgetLimitArgs } from '../contracts/budget.js';

type McpToolResult = { content: Array<{ type: 'text'; text: string }> };

export function handleSetBudgetLimit(args: SetBudgetLimitArgs): McpToolResult {
  const store = new BudgetStore();
  const limit_id = store.setBudgetLimit(args);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ limit_id, scope: args.scope, scope_value: args.scope_value, limit_usd: args.limit_usd, period: args.period }),
    }],
  };
}
