import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerTask, WorkerResult } from "./types.js";
import type { WorkerRunner } from "./runner.js";
import { getCodexBin, getRelayCodexNetworkMode } from "../config/runtime.js";
import { makeError } from "../errors.js";
import type { ResolvedMcpAttachment } from "../contracts/mcp.js";

// Solo Relay: no PID registry, no command compression, no metrics ingestion.
// These are slim no-op stubs to keep the dispatch path intact.
function registerPid(_pid: number): void {}
function unregisterPid(_pid: number): void {}
interface CompressInjection {
  envAdditions: Record<string, string>;
  wrapperDir: string;
  metricsFile: string;
  cleanup: () => Promise<void>;
}
async function injectCompressWrappers(_workdir: string, _runId: string): Promise<CompressInjection | null> {
  return null;
}
async function ingestWrappedCommandMetrics(_metricsFile: string, _meta: unknown): Promise<void> {}

const execFileAsync = promisify(execFile);

type FlagPosition = "global" | "exec";

interface ApprovalFlag {
  name: "--ask-for-approval" | "--approval-policy";
  position: FlagPosition;
}

interface CodexInvocation {
  args: string[];
  envAdditions: Record<string, string>;
  tempFiles: string[];
}

/** File writer signature for testability — writes content to path synchronously. */
export type TempFileWriter = (path: string, content: string) => void;

/** Path builder signature for testability — produces an absolute tempfile path. */
export type TempPathBuilder = (runId: string) => string;

const defaultTempFileWriter: TempFileWriter = (path, content) => {
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
};

const defaultTempPathBuilder: TempPathBuilder = (runId) => {
  // Unique-per-call: combine run_id + pid + monotonic counter to avoid collisions when
  // the same run dispatches multiple Codex invocations (rare but possible).
  const safe = String(runId || "run").replace(/[^a-zA-Z0-9_-]/g, "_");
  const unique = `${process.pid}-${tempPathCounter++}`;
  return join(tmpdir(), `relay-codex-instructions-${safe}-${unique}.md`);
};

let tempPathCounter = 0;

export interface CodexCliCapabilities {
  approvalFlag: ApprovalFlag | null;
  fullAutoPosition: FlagPosition;
  sandboxFlagSupported: boolean;
  mcpServerPosition: FlagPosition | "unsupported";
  searchPosition: FlagPosition | "unsupported";
  dangerousBypassPosition: FlagPosition | "unsupported";
}

// MCP servers that are disabled for Codex workers (distract from focused coding tasks)
const DISABLED_CODEX_MCP_LABELS = new Set(['figma', 'notion', 'pencil']);

const LEGACY_CODEX_CAPABILITIES: CodexCliCapabilities = {
  approvalFlag: { name: "--approval-policy", position: "exec" },
  fullAutoPosition: "exec",
  sandboxFlagSupported: false,
  mcpServerPosition: "exec",
  searchPosition: "unsupported",
  dangerousBypassPosition: "unsupported",
};

const capabilityCache = new Map<string, Promise<CodexCliCapabilities>>();

async function getCodexBinVersion(codexBin: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(codexBin, ["--version"], { encoding: "utf8" });
    return stdout.trim();
  } catch {
    return 'unknown';
  }
}

function hasExactFlagToken(helpText: string, flag: string): boolean {
  const tokens: string[] = helpText.match(/--[a-z0-9][a-z0-9-]*/gi) ?? [];
  return tokens.includes(flag);
}

function detectFlagPosition(rootHelp: string, execHelp: string, flag: string): FlagPosition | null {
  if (hasExactFlagToken(rootHelp, flag)) return "global";
  if (hasExactFlagToken(execHelp, flag)) return "exec";
  return null;
}

export function deriveCodexCliCapabilities(
  rootHelp: string,
  execHelp: string
): CodexCliCapabilities {
  const askForApprovalPos = detectFlagPosition(rootHelp, execHelp, "--ask-for-approval");
  const approvalPolicyPos = detectFlagPosition(rootHelp, execHelp, "--approval-policy");
  const fullAutoPos = detectFlagPosition(rootHelp, execHelp, "--full-auto");
  const mcpServerPos = detectFlagPosition(rootHelp, execHelp, "--mcp-server");
  const searchPos = detectFlagPosition(rootHelp, execHelp, "--search");
  const dangerousBypassPos = detectFlagPosition(
    rootHelp,
    execHelp,
    "--dangerously-bypass-approvals-and-sandbox"
  );

  const approvalFlag: ApprovalFlag | null = askForApprovalPos
    ? { name: "--ask-for-approval", position: askForApprovalPos }
    : approvalPolicyPos
      ? { name: "--approval-policy", position: approvalPolicyPos }
      : null;

  return {
    approvalFlag,
    fullAutoPosition: fullAutoPos ?? "exec",
    sandboxFlagSupported: hasExactFlagToken(execHelp, "--sandbox"),
    mcpServerPosition: mcpServerPos ?? "unsupported",
    searchPosition: searchPos ?? "unsupported",
    dangerousBypassPosition: dangerousBypassPos ?? "unsupported",
  };
}

async function probeCodexCliCapabilities(codexBin: string): Promise<CodexCliCapabilities> {
  try {
    const [rootHelp, execHelp] = await Promise.all([
      execFileAsync(codexBin, ["--help"], { encoding: "utf8" }),
      execFileAsync(codexBin, ["exec", "--help"], { encoding: "utf8" }),
    ]);
    return deriveCodexCliCapabilities(rootHelp.stdout, execHelp.stdout);
  } catch {
    // Fall back to legacy assumptions if probing fails.
    return LEGACY_CODEX_CAPABILITIES;
  }
}

async function getCodexCliCapabilities(codexBin: string): Promise<CodexCliCapabilities> {
  const version = await getCodexBinVersion(codexBin);
  const cacheKey = `${codexBin}@${version}`;
  const cached = capabilityCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const probePromise = probeCodexCliCapabilities(codexBin);
  capabilityCache.set(cacheKey, probePromise);
  return probePromise;
}

/** Pure function for JSONL parsing - exported for testing */
export function parseCodexLine(line: string): string | null {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (
      event["type"] === "item.completed" &&
      typeof event["item"] === "object" &&
      event["item"] !== null
    ) {
      const item = event["item"] as Record<string, unknown>;
      if (item["type"] === "agent_message" && typeof item["text"] === "string") {
        return item["text"];
      }
    }
  } catch {
    // Ignore malformed JSON lines.
  }

  return null;
}

/** Pure function for argument construction - exported for testing */
export function buildCodexInvocation(
  task: Pick<
    WorkerTask,
    "workdir" | "model" | "reasoning_effort" | "task" | "mcps" | "codex_approval_policy" | "run_id" | "contextPrefix"
  >,
  env: NodeJS.ProcessEnv = process.env,
  capabilities: CodexCliCapabilities = LEGACY_CODEX_CAPABILITIES,
  writer: TempFileWriter = defaultTempFileWriter,
  pathBuilder: TempPathBuilder = defaultTempPathBuilder
): CodexInvocation {
  const globalArgs: string[] = [];
  const execArgs = ["exec", "--cd", task.workdir, "--json"];
  const envAdditions: Record<string, string> = {};
  const tempFiles: string[] = [];

  // Forward CC orchestration env vars so Codex workers receive the same thinking/effort settings
  // as the orchestrating CC session — works even when relay runs as a daemon with a clean env.
  for (const key of ['CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING', 'CLAUDE_CODE_EFFORT_LEVEL'] as const) {
    const val = env[key];
    if (val !== undefined) {
      envAdditions[key] = val;
    }
  }

  const networkMode = getRelayCodexNetworkMode(env);

  if (networkMode === "dangerous") {
    if (task.codex_approval_policy) {
      throw new Error(
        "codex_approval_policy cannot be combined with RELAY_CODEX_NETWORK_MODE=dangerous."
      );
    }

    const target =
      capabilities.dangerousBypassPosition === "global" ? globalArgs : execArgs;

    if (capabilities.dangerousBypassPosition === "unsupported") {
      throw new Error(
        "RELAY_CODEX_NETWORK_MODE=dangerous requires Codex CLI support for --dangerously-bypass-approvals-and-sandbox."
      );
    }

    target.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    if (task.codex_approval_policy && networkMode !== "search") {
      if (!capabilities.approvalFlag) {
        throw new Error(
          "codex_approval_policy is not supported by this Codex CLI version."
        );
      }

      const target =
        capabilities.approvalFlag.position === "global" ? globalArgs : execArgs;
      target.push(capabilities.approvalFlag.name, task.codex_approval_policy);
    } else {
      if (capabilities.sandboxFlagSupported) {
        execArgs.push("--sandbox", "workspace-write");
      } else {
        const target =
          capabilities.fullAutoPosition === "global" ? globalArgs : execArgs;
        target.push("--full-auto");
      }
    }
  }

  if (networkMode === "search") {
    if (capabilities.searchPosition === "unsupported") {
      throw new Error(
        "RELAY_CODEX_NETWORK_MODE=search requires Codex CLI support for --search."
      );
    }

    const target = capabilities.searchPosition === "global" ? globalArgs : execArgs;
    target.push("--search");
  }

  if (env["RELAY_SKIP_GIT_CHECK"] === "1") {
    execArgs.push("--skip-git-repo-check");
  }
  if (task.model) {
    execArgs.push("--model", task.model);
  }
  if (task.reasoning_effort) {
    execArgs.push("-c", `model_reasoning_effort=${task.reasoning_effort}`);
  }

  // Disable distraction MCP servers unconditionally for Codex coding workers
  for (const label of DISABLED_CODEX_MCP_LABELS) {
    globalArgs.push("-c", `mcp_servers.${label}.enabled=false`);
  }

  const allowedMcps = (task.mcps ?? []).filter(
    (a) => !DISABLED_CODEX_MCP_LABELS.has(a.label ?? '')
  );

  if (allowedMcps.length) {
    const shouldUseConfigFallback =
      capabilities.mcpServerPosition === "unsupported" ||
      allowedMcps.some((attachment) => Object.keys(attachment.headers ?? {}).length > 0);

    if (shouldUseConfigFallback) {
      globalArgs.push(...buildCodexMcpConfigOverrides(allowedMcps, envAdditions, task.run_id));
    } else {
      const target =
        capabilities.mcpServerPosition === "global" ? globalArgs : execArgs;
      for (const attachment of allowedMcps) {
        target.push("--mcp-server", attachment.url);
      }
    }
  }

  // Inject Relay context layers via Codex `model_instructions_file` config.
  // Codex docs (https://developers.openai.com/codex/config-reference) state
  // `instructions` is reserved; `model_instructions_file` is the supported path.
  // The bare task is passed as the prompt; stable context lives in the file so it
  // can be cached/reused without polluting the prompt argument.
  if (task.contextPrefix && task.contextPrefix.length > 0) {
    const tempPath = pathBuilder(task.run_id);
    writer(tempPath, task.contextPrefix);
    tempFiles.push(tempPath);
    // `-c` values are parsed as TOML — quote the path with toTomlString (JSON.stringify)
    // to handle spaces, backslashes, and other special characters safely.
    globalArgs.push("-c", `model_instructions_file=${toTomlString(tempPath)}`);
  }

  execArgs.push("--", task.task);

  // Ensure CC thinking flags reach Codex workers — default to optimal settings
  // when not already configured in the orchestrator environment. envAdditions wins
  // over process.env in the spawn spread, so only inject when absent.
  if (!env["CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING"]) {
    envAdditions["CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING"] = "1";
  }
  if (!env["CLAUDE_CODE_EFFORT_LEVEL"]) {
    envAdditions["CLAUDE_CODE_EFFORT_LEVEL"] = "max";
  }

  return {
    args: [...globalArgs, ...execArgs],
    envAdditions,
    tempFiles,
  };
}

/** Pure function for argument construction - exported for testing */
export function buildCodexArgs(
  task: Pick<
    WorkerTask,
    "workdir" | "model" | "reasoning_effort" | "task" | "mcps" | "codex_approval_policy" | "contextPrefix"
  >,
  env: NodeJS.ProcessEnv = process.env,
  capabilities: CodexCliCapabilities = LEGACY_CODEX_CAPABILITIES,
  writer: TempFileWriter = defaultTempFileWriter,
  pathBuilder: TempPathBuilder = defaultTempPathBuilder
): string[] {
  return buildCodexInvocation(
    {
      ...task,
      run_id: "run",
    },
    env,
    capabilities,
    writer,
    pathBuilder
  ).args;
}

function sanitizeMcpServerName(seed: string): string {
  return seed.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "relay_mcp";
}

function toTomlString(value: string): string {
  return JSON.stringify(value);
}

function toTomlInlineTable(record: Record<string, string>): string {
  return `{${Object.entries(record)
    .map(([key, value]) => `${JSON.stringify(key)}=${toTomlString(value)}`)
    .join(",")}}`;
}

function buildCodexMcpConfigOverrides(
  attachments: ResolvedMcpAttachment[],
  envAdditions: Record<string, string>,
  runId: string
): string[] {
  const args: string[] = [];

  attachments.forEach((attachment, index) => {
    const serverName = sanitizeMcpServerName(
      `relay_${runId}_${index + 1}_${attachment.label ?? "mcp"}`
    );
    args.push("-c", `mcp_servers.${serverName}.url=${toTomlString(attachment.url)}`);

    if (attachment.headers && Object.keys(attachment.headers).length > 0) {
      const envHeaderMap: Record<string, string> = {};
      for (const [headerName, headerValue] of Object.entries(attachment.headers)) {
        const envVarName = sanitizeMcpServerName(
          `RELAY_CODEX_MCP_${runId}_${index + 1}_${headerName}`
        ).toUpperCase();
        envAdditions[envVarName] = headerValue;
        envHeaderMap[headerName] = envVarName;
      }
      args.push(
        "-c",
        `mcp_servers.${serverName}.env_http_headers=${toTomlInlineTable(envHeaderMap)}`
      );
    }
  });

  return args;
}

export async function runCodexWorker(task: WorkerTask): Promise<WorkerResult> {
  const startTime = Date.now();
  const codexBin = getCodexBin();
  const capabilities = await getCodexCliCapabilities(codexBin);

  let invocation: CodexInvocation;
  try {
    invocation = buildCodexInvocation(task, process.env, capabilities);
  } catch (err) {
    return {
      status: "error",
      output: "",
      duration_ms: Date.now() - startTime,
      exit_code: null,
      error: makeError(
        "INVALID_ARGS",
        err instanceof Error ? err.message : String(err),
        false
      ),
    };
  }

  // Codex executes its own shell loop. Measure wrapped command output and compress it when available.
  // Set RELAY_DISABLE_COMPRESS_WRAPPERS=1 to skip wrapper PATH injection — needed when wrappers cause
  // codex to hang (e.g., when wrapped node interacts badly with codex's command-substitution pipes).
  const wrappersDisabled = process.env["RELAY_DISABLE_COMPRESS_WRAPPERS"] === "1";
  const injection: CompressInjection | null = wrappersDisabled
    ? null
    : await injectCompressWrappers(task.workdir, task.run_id);
  if (injection) {
    const base = invocation.envAdditions["PATH"] ?? process.env["PATH"] ?? "";
    invocation.envAdditions = {
      ...invocation.envAdditions,
      ...injection.envAdditions,
      PATH: `${injection.wrapperDir}:${base}`,
    };
  }

  const child = spawn(codexBin, invocation.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...invocation.envAdditions },
    detached: true,
  });

  if (child.pid !== undefined) {
    registerPid(child.pid);
    child.unref();
  }

  child.stdin?.end();

  const agentMessages: string[] = [];
  let stdoutBuf = "";
  let thinkingBlocks = 0;
  let toolUseBlocks = 0;
  const toolCallNames: string[] = [];
  let fileReadsBeforeFirstWrite = 0;
  let firstWriteSeen = false;
  let toolRetryCount = 0;
  let lastToolName = "";

  const READ_TOOLS = new Set(["Read", "read_file", "View", "view_file", "Glob", "Grep", "grep", "LS", "list_directory", "search_files"]);
  const WRITE_TOOLS = new Set(["Write", "write_file", "Edit", "edit_file", "str_replace", "str_replace_based_edit_tool", "Bash", "run_bash", "NotebookEdit"]);

  function countBlockType(line: string): void {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event["type"] === "content_block_start") {
        const block = event["content_block"] as Record<string, unknown> | undefined;
        if (block?.["type"] === "thinking") {
          thinkingBlocks++;
        } else if (block?.["type"] === "tool_use") {
          toolUseBlocks++;
          const name = typeof block["name"] === "string" ? block["name"] : "";
          toolCallNames.push(name);
          if (name && name === lastToolName) toolRetryCount++;
          lastToolName = name;
          if (!firstWriteSeen) {
            if (WRITE_TOOLS.has(name)) {
              firstWriteSeen = true;
            } else if (READ_TOOLS.has(name)) {
              fileReadsBeforeFirstWrite++;
            }
          }
        }
      }
    } catch { /* ignore malformed lines */ }
  }

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString("utf8");
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      const message = parseCodexLine(line);
      if (message) {
        agentMessages.push(message);
        task.logStream?.write(message + "\n");
      }
      countBlockType(line);
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    if (task.onStderr) {
      task.onStderr(text);
      return;
    }

    process.stderr.write(text);
  });

  let timedOut = false;
  let processExited = false;
  let sigkillHandle: NodeJS.Timeout | null = null;
  const killGroup = (signal: 'SIGTERM' | 'SIGKILL'): void => {
    if (child.pid !== undefined) {
      try { process.kill(-child.pid, signal); } catch { /* already gone */ }
    }
  };
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    killGroup('SIGTERM');
    sigkillHandle = setTimeout(() => {
      if (!processExited) {
        killGroup('SIGKILL');
      }
      sigkillHandle = null;
    }, 5_000);
  }, task.timeout_ms);

  return new Promise<WorkerResult>((resolve) => {
    child.on("close", (code) => {
      void (async () => {
        processExited = true;
        clearTimeout(timeoutHandle);
        if (sigkillHandle) {
          clearTimeout(sigkillHandle);
          sigkillHandle = null;
        }

        if (child.pid !== undefined) {
          unregisterPid(child.pid);
        }

        if (stdoutBuf.trim()) {
          const message = parseCodexLine(stdoutBuf);
          if (message) {
            agentMessages.push(message);
            task.logStream?.write(message + "\n");
          }
          countBlockType(stdoutBuf);
        }

        if (injection) {
          await ingestWrappedCommandMetrics(injection.metricsFile, {
            run_id: task.run_id,
            provider: task.provider,
            mode: "codex_wrapper",
            workdir: task.workdir,
          });
        }

        const duration_ms = Date.now() - startTime;
        const output = agentMessages.join("\n");

        const behavioralSignals = {
          thinking_blocks: thinkingBlocks,
          tool_use_blocks: toolUseBlocks,
          file_reads_before_first_write: firstWriteSeen || toolCallNames.length > 0 ? fileReadsBeforeFirstWrite : undefined,
          tool_retry_count: toolRetryCount > 0 ? toolRetryCount : undefined,
        };

        if (timedOut) {
          resolve({
            status: "timeout",
            output,
            duration_ms,
            exit_code: null,
            ...behavioralSignals,
            error: makeError("TIMEOUT", `Codex timed out after ${task.timeout_ms}ms`, true),
          });
          return;
        }

        if (code !== 0) {
          resolve({
            status: "error",
            output,
            duration_ms,
            exit_code: code,
            ...behavioralSignals,
            error: makeError("CODEX_ERROR", `Codex exited with code ${code}`, false),
          });
          return;
        }

        resolve({
          status: "success",
          output,
          duration_ms,
          exit_code: code,
          ...behavioralSignals,
        });
      })();
    });

    child.on("error", (err) => {
      processExited = true;
      clearTimeout(timeoutHandle);
      if (sigkillHandle) {
        clearTimeout(sigkillHandle);
        sigkillHandle = null;
      }

      if (child.pid !== undefined) {
        unregisterPid(child.pid);
      }

      const duration_ms = Date.now() - startTime;
      resolve({
        status: "error",
        output: "",
        duration_ms,
        exit_code: null,
        error: makeError(
          "BINARY_NOT_FOUND",
          `Failed to spawn codex binary (${codexBin}): ${err.message}. Set RELAY_CODEX_PATH=/full/path/to/codex if needed.`,
          false
        ),
      });
    });
  }).finally(() => {
    // Remove temp wrapper scripts regardless of how the worker exits.
    void injection?.cleanup();
    // Remove temp model_instructions_file(s) created for Codex context injection.
    for (const tempPath of invocation.tempFiles) {
      try {
        unlinkSync(tempPath);
      } catch (err) {
        // File may already be gone (process crash, manual cleanup, etc.). Log to stderr
        // so the failure is visible without aborting the run.
        process.stderr.write(
          `relay: failed to remove codex tempfile ${tempPath}: ${(err as Error).message}\n`
        );
      }
    }
  });
}

export class CodexRunner implements WorkerRunner {
  readonly capabilities = { agentic: true, execution_model: "subprocess" } as const;

  run(task: WorkerTask): Promise<WorkerResult> {
    return runCodexWorker(task);
  }
}
