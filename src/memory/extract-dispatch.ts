import { randomUUID } from 'node:crypto';
import { resolveProvider, type ProviderConfig } from '../workers/provider-registry.js';
import type { WorkerRunner } from '../workers/runner.js';
import { runnerForProvider } from '../cli/runner-factory.js';
import { makeError, toRelayException } from '../errors.js';

export type ExtractionRunnerFactory = (config: ProviderConfig) => Promise<WorkerRunner>;

export interface DispatchExtractionOptions {
  readonly timeoutMs: number;
  readonly model?: string;
  readonly workdir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly runnerFactory?: ExtractionRunnerFactory;
}

export async function dispatchExtraction(
  providerName: string,
  prompt: string,
  opts: DispatchExtractionOptions,
): Promise<string> {
  const env = opts.env ?? process.env;
  const config = resolveProvider(providerName, env);
  if (config.name === 'lmstudio-agentic') {
    // Agentic tool-loop runners require a non-empty tools[]; extraction is a single-shot
    // text transform that passes none, so reject it up front with a clear message instead
    // of failing deep inside the runner.
    throw toRelayException(
      makeError(
        'INVALID_ARGS',
        `extractor '${providerName}' is an agentic tool-loop runner and cannot be used for ` +
          `extraction (a single-shot text transform). Use codex, claude, lmstudio, or an HTTP provider.`,
        false,
      ),
    );
  }
  const runner =
    opts.runnerFactory !== undefined
      ? await opts.runnerFactory(config)
      : await runnerForProvider(config, { env });

  const result = await runner.run({
    task: prompt,
    workdir: opts.workdir ?? process.cwd(),
    timeout_ms: opts.timeoutMs,
    model: opts.model,
    // Extraction is a single-shot text transform — run the worker tool-free so it can't
    // read files / hit MCP. Subprocess runners (claude) honor this; HTTP runners ignore it.
    disableTools: true,
    run_id: `auto-extract:${randomUUID()}`,
    provider: providerName,
  });

  if (result.status === 'success') {
    return result.output;
  }

  throw toRelayException(
    result.error ??
      makeError(
        result.status === 'timeout' ? 'TIMEOUT' : 'PROVIDER_ERROR',
        `${providerName} extraction ${result.status}`,
        result.status === 'timeout',
      ),
  );
}
