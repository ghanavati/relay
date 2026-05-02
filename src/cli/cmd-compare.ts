import type { CliIO } from './commands.js';
import { RunStore } from '../runtime/store/run-store.js';

type RunRow = {
  run_id: string;
  provider: string;
  model: string | null;
  status: string;
  duration_ms: number | null;
  token_usage: number | null;
  files_changed_json: string | null;
  task_excerpt: string | null;
  exit_code: number | null;
};

export interface CompareArgs {
  runA: string;
  runB: string;
  json: boolean;
}

function parseFilesChangedJson(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatRunId(runId: string): string {
  return runId.slice(0, 8) + '...';
}

function formatDuration(ms: number | null): string {
  if (ms === null) return 'N/A';
  if (ms >= 60_000) {
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1000);
    return `${minutes}m ${seconds}s`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatExitCode(code: number | null): string {
  if (code === null) return 'N/A';
  return code.toString();
}

function printTextOutput(a: RunRow, b: RunRow, filesOnlyInA: string[], filesOnlyInB: string[], sharedFiles: string[]): void {
  const pad = '  ';
  const header = `run ${formatRunId(a.run_id)} vs ${formatRunId(b.run_id)}...`;

  console.log(header);
  console.log(); // blank line

  console.log(`${pad}A${pad.padEnd(14)}B`);
  console.log(`${pad}provider${pad.padEnd(14)}${a.provider.padEnd(14)}${b.provider}`);
  console.log(`${pad}model${padEnd(a.model ?? 'N/A'.padEnd(14))}${b.model ?? 'N/A'}`);
  console.log(`${pad}status${padEnd(a.status.padEnd(14))}${b.status}`);
  console.log(`${pad}duration${padEnd(formatDuration(a.duration_ms).padEnd(14))}${formatDuration(b.duration_ms)}`);
  console.log(`${pad}tokens${padEnd((a.token_usage ?? 'N/A').toString().padEnd(14))}${b.token_usage ?? 'N/A'}`);
  console.log(`${pad}files${padEnd(`${a.files.length} changed`.padEnd(14))}${b.files.length} changed`);
  console.log(`${pad}exit_code${padEnd(formatExitCode(a.exit_code).padEnd(14))}${formatExitCode(b.exit_code)}`);
  console.log();

  if (filesOnlyInA.length > 0) {
    console.log('Files only in A:');
    for (const file of filesOnlyInA) {
      console.log(`  ${file}`);
    }
    console.log();
  }

  if (filesOnlyInB.length > 0) {
    console.log('Files only in B:');
    for (const file of filesOnlyInB) {
      console.log(`  ${file}`);
    }
    console.log();
  }

  if (sharedFiles.length > 0) {
    console.log('Files changed in both:');
    for (const file of sharedFiles) {
      console.log(`  ${file}`);
    }
  }
}

function printJsonOutput(a: RunRow, b: RunRow, filesOnlyInA: string[], filesOnlyInB: string[], sharedFiles: string[]): void {
  const result = {
    a: {
      run_id: a.run_id,
      provider: a.provider,
      model: a.model ?? null,
      status: a.status,
      duration_ms: a.duration_ms ?? null,
      token_usage: a.token_usage ?? null,
      files: parseFilesChangedJson(a.files_changed_json),
      exit_code: a.exit_code ?? null,
    },
    b: {
      run_id: b.run_id,
      provider: b.provider,
      model: b.model ?? null,
      status: b.status,
      duration_ms: b.duration_ms ?? null,
      token_usage: b.token_usage ?? null,
      files: parseFilesChangedJson(b.files_changed_json),
      exit_code: b.exit_code ?? null,
    },
    files_only_in_a: filesOnlyInA,
    files_only_in_b: filesOnlyInB,
    files_changed_in_both: sharedFiles,
  };

  console.log(JSON.stringify(result, null, 2));
}

export async function executeCompareCommand(args: CompareArgs, io: CliIO): Promise<number> {
  const store = new RunStore();
  const a = store.getRun(args.runA);
  const b = store.getRun(args.runB);

  if (a === undefined || b === undefined) {
    io.stderr.write('run not found\n');
    return 1;
  }

  const aFiles = parseFilesChangedJson(a.files_changed_json);
  const bFiles = parseFilesChangedJson(b.files_changed_json);

  const aSet = new Set(aFiles);
  const bSet = new Set(bFiles);

  const filesOnlyInA = aFiles.filter((f) => !bSet.has(f));
  const filesOnlyInB = bFiles.filter((f) => !aSet.has(f));
  const sharedFiles = aFiles.filter((f) => bSet.has(f));

  if (args.json) {
    printJsonOutput(a, b, filesOnlyInA, filesOnlyInB, sharedFiles);
  } else {
    printTextOutput(a, b, filesOnlyInA, filesOnlyInB, sharedFiles);
  }

  return 0;
}