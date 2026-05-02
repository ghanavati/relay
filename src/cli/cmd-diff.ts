import type { CliIO } from './commands.js';

export interface DiffArgs { runId: string; json: boolean; }

export async function executeDiffCommand(args: DiffArgs, io: CliIO): Promise<number> {
	const { RunStore } = await import('../runtime/store/run-store.js');
	const store = new RunStore();

	const run = store.getRun(args.runId);
	if (!run) {
		io.stderr(`Error: Run '${args.runId}' not found\n`);
		return 1;
	}

	const files = run.files_changed_json ? JSON.parse(run.files_changed_json) as string[] : [];
	const diffs = store.getRunDiffs(args.runId);

	const statusText = run.status === 'success' ? 'success' : run.status;
	const durationText = run.duration_ms ? `${run.duration_ms}ms` : 'N/A';

	if (args.json) {
		const output = {
			run_id: run.run_id,
			status: statusText,
			files_changed: files,
			diffs: diffs.map(d => ({ file_path: d.file_path, diff_text: d.diff_text })),
		};
		io.stdout(JSON.stringify(output, null, 2) + '\n');
		return 0;
	}

	if (files.length === 0 && diffs.length === 0) {
		io.stdout(`No filesystem changes recorded for this run.\n`);
		return 0;
	}

	io.stdout(`run ${run.run_id.slice(0, 7)}... (${statusText}, ${durationText})\n`);

	if (files.length > 0) {
		io.stdout(`  ${files.length} files changed:\n`);
		for (const file of files) {
			io.stdout(`    M  ${file}\n`);
		}
	}

	if (files.length > 0 && diffs.length === 0) {
		io.stdout(`Diffs not stored — only file paths captured.\n`);
	}

	if (diffs.length > 0) {
		for (const diff of diffs) {
			io.stdout(`\n=== ${diff.file_path} ===\n`);
			io.stdout(diff.diff_text);
		}
	}

	return 0;
}