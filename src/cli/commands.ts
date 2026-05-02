/**
 * Shared CLI types.
 *
 * Slim version for Relay solo CLI — only exports the `CliIO` interface used by
 * cmd-*.ts files. The full dispatcher and parser live in cli.ts (entry point).
 */

export interface CliIO {
  cwd: string;
  stdout: (msg: string) => void;
  stderr: (msg: string) => void;
}
