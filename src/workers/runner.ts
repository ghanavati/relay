import type { WorkerTask, WorkerResult } from "./types.js";

export type IntegrationLevel = "callable" | "status" | "full";
export type AdapterType = "openclaw" | "process" | "http";
export type ExecutionModel = "relay-loop" | "subprocess";

export interface WorkerCapabilities {
  agentic: boolean;
  integrationLevel?: IntegrationLevel; // optional -- undefined = "full" for built-ins
  adapterType?: AdapterType;           // optional -- undefined = native runner
  execution_model?: ExecutionModel;
}

export interface WorkerRunner {
  readonly capabilities?: WorkerCapabilities;
  run(task: WorkerTask): Promise<WorkerResult>;
}

export function getRunnerCapabilities(runner: WorkerRunner): WorkerCapabilities {
  return runner.capabilities ?? { agentic: false };
}
