import { z } from "zod";
import { baseTaskSchemaShape } from "../contracts/delegate.js";

export const ParallelTaskSchema = z.object(baseTaskSchemaShape).extend({
  task_id: z.string().optional().describe(
    "Caller-assigned logical ID for this task. Required when other tasks reference it via depends_on."
  ),
  task_label: z.string().optional(),
  context: z.string().optional().describe("Additional context prepended to the task before delegation"),
  depends_on: z.array(z.string()).optional().describe(
    "List of task_ids that must complete successfully before this task is dispatched. Creates a dependency wave."
  ),
  inject_outputs: z.boolean().optional().describe(
    "If true, prepend each depends_on task's output as context before dispatching this task."
  ),
});

export const DelegateParallelArgsSchema = z.object({
  tasks: z.array(ParallelTaskSchema).min(1),
  continue_on_error: z.boolean().default(true),
  max_failures: z.number().int().min(0).optional(),
  max_concurrency: z.number().int().min(1).default(5),
  isolation: z.enum(["worktree", "none"]).default("worktree").describe(
    "'worktree' (default): tasks sharing a workdir each get an isolated git worktree, enabling true parallel execution without mutex contention. Branches are merged back after all tasks complete. 'none': legacy mutex-serialized mode."
  ),
});

export type ParallelTask = z.infer<typeof ParallelTaskSchema>;
// isolation has a default so callers may omit it. All other top-level fields are kept
// as the z.infer (post-parse) shape so internal consumers get the required types they expect.
export type DelegateParallelArgs =
  Omit<z.infer<typeof DelegateParallelArgsSchema>, 'isolation'> &
  { isolation?: z.infer<typeof DelegateParallelArgsSchema>['isolation'] };
