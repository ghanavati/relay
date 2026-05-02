import { z } from 'zod';

/**
 * Schema for .relay/model-declaration.yaml (or .json).
 *
 * This file describes the permanent properties of a model — what stays true across
 * all runs. Per-run metadata (data source, assumptions for this run) goes in the
 * task prompt via RELAY_* headers. Together they cover the SR 11-7 context layer.
 *
 * Example .relay/model-declaration.yaml:
 *   purpose: Validate momentum strategy against US large-cap universe
 *   methodology: 12-1 momentum, equal-weight monthly rebalancing
 *   risk_tier: high
 *   materiality: high
 *   responsible_individuals:
 *     - alice@firm.com
 *   validity_window: "2024-01-01 to 2026-12-31"
 *   assumptions: Sufficient liquidity; normal market conditions
 *   limitations: Not validated in high-volatility regimes (VIX > 30)
 */
export const ModelDeclarationSchema = z.object({
  purpose: z.string().optional(),
  methodology: z.string().optional(),
  risk_tier: z.enum(['high', 'medium', 'low', 'informational']).optional()
    .describe('SR 11-7 risk tier. Defaults to high (fail-closed) when absent.'),
  materiality: z.enum(['high', 'medium', 'low']).optional(),
  responsible_individuals: z.array(z.string()).optional(),
  validity_window: z.string().optional(),
  assumptions: z.string().optional(),
  limitations: z.string().optional(),
  // R-16 — EU AI Act Articles 28-30: provider/deployer obligation split
  obligation_role: z.enum(['provider', 'deployer', 'both']).optional()
    .describe('Role in the AI value chain per EU AI Act Art. 28-30. "provider" = built/placed on market; "deployer" = uses in a professional context; "both" = internal tool.'),
  provider_documentation_received: z.enum(['true', 'false']).optional()
    .describe('Whether deployer has received required technical documentation from provider (Art. 28(1)(c)).'),
});

export type ModelDeclaration = z.infer<typeof ModelDeclarationSchema>;
