/**
 * LM Studio Agentic Worker — standalone in-process OpenAI-style tool-calling loop.
 *
 * NOT a `GenericHttpRunner` subclass — generic-http-runner.ts:6-13 documents single-shot
 * round-trip contract incompatible with the tool loop. Re-uses `getLmStudioEndpoint()`
 * and `getLmStudioApiKey()` from `../config/providers.js`.
 *
 * Capabilities: `{ agentic: true, execution_model: 'tool_loop' }`.
 *
 * SKELETON — T2 fleshes out pure helpers; T3 adds tool sandbox; T4 adds loop;
 * T5 adds hash-based loop detector; T6 adds LFM2 nudge.
 */

import { makeError } from '../errors.js';
import type { WorkerRunner, WorkerCapabilities } from './runner.js';
import type { WorkerTask, WorkerResult } from './types.js';

export interface LmStudioAgenticRunnerOpts {
  // T2 — fetchImpl / shellExec / maxIterations seams populated in subsequent tasks.
}

export class LmStudioAgenticRunner implements WorkerRunner {
  readonly capabilities: WorkerCapabilities = {
    agentic: true,
    execution_model: 'tool_loop',
  };

  constructor(_opts: LmStudioAgenticRunnerOpts = {}) {
    // intentionally empty — T2 populates
  }

  async run(task: WorkerTask): Promise<WorkerResult> {
    const startedAt = Date.now();
    void task;
    return {
      status: 'error',
      output: '',
      duration_ms: Date.now() - startedAt,
      exit_code: null,
      iterations: 0,
      tool_call_count: 0,
      error: makeError('UNSUPPORTED', 'lmstudio-agentic worker not yet implemented (T2)', false),
    };
  }
}
