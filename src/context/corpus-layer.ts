/**
 * Corpus RAG context layer — SHIP-77.
 *
 * Auto-injects top-5 BM25 hits from a named corpus into worker context.
 * Enabled by setting RELAY_CORPUS_LAYER=<corpus-name>.
 * Skipped automatically in minimal mode (loadContextLayers filters by id).
 */

import type { ContextLayer, ContextLayerProvider } from './layers.js';

export function createCorpusLayerProvider(corpusName: string): ContextLayerProvider {
  return {
    id: 'corpus_rag',
    async load(args: { workdir: string; task?: string }): Promise<ContextLayer | null> {
      const queryText = args.task?.trim();
      if (!queryText) return null;

      try {
        const { CorpusStore } = await import('../memory/corpus-store.js');
        const results = new CorpusStore().query(corpusName, queryText, 5);
        if (results.length === 0) return null;

        const lines = results.map((r, i) => `${i + 1}. ${r.snippet}`);
        const content = `## Relevant knowledge from corpus "${corpusName}" (auto-retrieved)\n\n${lines.join('\n')}`;
        return { id: 'corpus_rag', content };
      } catch {
        return null;
      }
    },
  };
}
