/**
 * SHIP-53 integration — `corpus_query` MCP tool.
 *
 * Read-only wrapper around `CorpusStore.query`. Failures (corpus not found,
 * empty/invalid query) surface as `isError: true` so workers distinguish
 * "corpus doesn't exist" from "corpus exists but no matches".
 */

import { CorpusStore } from '../memory/corpus-store.js';
import type { CorpusQueryArgs } from '../contracts/corpus.js';

type McpToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export function handleCorpusQuery(args: CorpusQueryArgs): McpToolResult {
  const store = new CorpusStore();
  const meta = store.get(args.name);
  if (!meta) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'corpus_not_found',
          name: args.name,
          hint: `Build it first with \`relay corpus build ${args.name}\``,
        }),
      }],
      isError: true,
    };
  }

  const results = store.query(args.name, args.query_text, args.limit ?? 10);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        corpus: args.name,
        query: args.query_text,
        total_results: results.length,
        results,
      }),
    }],
  };
}
