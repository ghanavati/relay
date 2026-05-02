import { BudgetStore } from '../runtime/budget/budget-store.js';
import type { ListBudgetAlertsArgs } from '../contracts/budget.js';

type McpToolResult = { content: Array<{ type: 'text'; text: string }> };

export function handleListBudgetAlerts(args: ListBudgetAlertsArgs): McpToolResult {
  const store = new BudgetStore();
  const alerts = store.listBudgetAlerts(args);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ count: alerts.length, alerts }),
    }],
  };
}
