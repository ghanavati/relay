# Parallel workers

`relay parallel <spec.json>` dispatches explicitly defined, independent tasks
with bounded concurrency. It is a harness for a lead agent—not a substitute
for planning, review, or integration.

## Use it for bounded work

Good candidates are independent tests, narrow code review, documentation
checks, small migrations, or research whose result can be reviewed separately.
Avoid splitting a change when tasks must edit the same files or depend on each
other's uncommitted output.

## Workdir rule

Each local agentic task must use a distinct `workdir`. Relay rejects agentic
parallel tasks that share one, because shared filesystem state makes their
results non-deterministic. Use Git worktrees when tasks need to modify code.

## Model rule

Use a model only for work it is suited to do. Local models are most reliable
when the task is concise, its inputs are named, its expected output is clear,
and the lead agent checks the result. Use a stronger lead model for architecture,
integration, security decisions, and final review.

oMLX and LM Studio agentic providers receive Relay's bounded tool loop and
control tools. Model-specific sampling and iteration settings belong in an
inference-profile file, not in hardcoded source. See
[FLEET-OPERATIONS.md](FLEET-OPERATIONS.md) for the current operating guidance.

## Completion rule

A changed file is not a successful run. Treat Relay's recorded run status,
test output, and the lead agent's review as the completion signal.
