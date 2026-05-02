/**
 * SHIP-53 integration — `corpus_query` MCP tool contract.
 *
 * Only the read path is MCP-exposed. `build`, `list`, and `remove` stay CLI-only:
 * they are admin operations that a worker should never need. This keeps the MCP
 * surface area narrow (no corpus enumeration from compromised workers).
 */

import { z } from 'zod';

export const corpusQuerySchema = {
  name: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9_-]+$/, 'Corpus name must be alphanumeric with _ or - only')
    .describe('Name of the corpus to query (built via `relay corpus build`). Alphanumeric + _ / - only.'),
  query_text: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      'Free-text search terms. FTS5 operators (AND/OR/NOT/NEAR/*) are disabled by ' +
      'the built-in sanitizer — each token is wrapped as an FTS5 phrase match and ' +
      'results return only documents containing all tokens.'
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Max results to return (default 10 if omitted).'),
};

export const CorpusQueryArgsSchema = z.object(corpusQuerySchema);
export type CorpusQueryArgs = z.infer<typeof CorpusQueryArgsSchema>;
