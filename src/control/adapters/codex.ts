/**
 * Conservative Codex control adapter (Phase 8 / Plan 04 / Task 2).
 *
 * D-09 / CONTROL-08 — Codex integration is MCP/instructions first. Capability
 * reporting is DISCOVERED, never assumed:
 *
 *   - `register`        always (Relay can record the session).
 *   - `context_inject`  only when the Relay-managed instructions block exists
 *                       in ~/.codex/AGENTS.md (Relay context can ride along
 *                       with Codex instructions).
 *   - `mailbox`         only when at least one delivery surface exists
 *                       (instructions render OR MCP tool pull).
 *   - `tool_call`       only when a Relay MCP server entry exists in
 *                       ~/.codex/config.toml.
 *   - `live_stdin` / `resume_send` are NEVER reported. Full-TTY CLI control of
 *     sessions Relay does not own is out of v1 scope — Relay reports the
 *     capability as truthfully absent instead of pretending (D-01/D-02).
 *
 * Delivery contract mirrors the claude-code adapter: `deliver` buffers for an
 * instructions-render boundary (e.g. `relay context emit --target codex`
 * feeding `-c model_instructions_file=`). MCP tool pull reads QUEUED messages
 * from the store directly — do not push-drain mcp-only sessions.
 */
import { z } from 'zod';

import { makeError, toRelayException, type RelayException } from '../../errors.js';
import type {
  ControlAdapter,
  ControlCapability,
  ControlMessage,
  ControlProvider,
  ControlSession,
  DeliveryOutcome,
} from '../types.js';
import { ControlSessionStore } from '../session-store.js';

/**
 * Relay-managed block delimiters shared with `relay setup-llm codex`
 * (cmd-setup-llm.ts imports these — single source of truth for what the
 * capability probe looks for).
 */
export const RELAY_MANAGED_START = '<!-- relay-managed-start -->';
export const RELAY_MANAGED_END = '<!-- relay-managed-end -->';

/** Result of probing the local Codex integration surfaces. */
export interface CodexControlProbe {
  /** Relay-managed instructions block present in ~/.codex/AGENTS.md. */
  readonly instructions_present: boolean;
  /** Relay MCP server entry present in ~/.codex/config.toml. */
  readonly mcp_configured: boolean;
}

/** Override the probed file locations (tests use temp dirs). */
export interface CodexProbePaths {
  agentsPath?: string;
  configPath?: string;
}

function invalidArgs(message: string): RelayException {
  return toRelayException(makeError('INVALID_ARGS', message, false));
}

function notImplemented(): never {
  throw new Error('not implemented (08-04 RED)');
}

/**
 * Probe ~/.codex for the two integration surfaces. Missing or unreadable
 * files are treated as "not configured" — discovery must never overclaim.
 */
export async function probeCodexControlSetup(paths?: CodexProbePaths): Promise<CodexControlProbe> {
  void paths;
  notImplemented();
}

/**
 * Map probe results to the conservative capability set (see module header).
 * Never returns live_stdin or resume_send.
 */
export function deriveCodexCapabilities(probe: CodexControlProbe): readonly ControlCapability[] {
  void probe;
  notImplemented();
}

const CodexSessionInputSchema = z
  .object({
    session_id: z.string().min(1).max(200).optional(),
    label: z.string().min(1).max(200).optional(),
    workdir: z.string().min(1).max(1000).optional(),
  })
  .strict()
  .readonly();
export type CodexSessionInput = z.infer<typeof CodexSessionInputSchema>;

export class CodexControlAdapter implements ControlAdapter {
  readonly provider: ControlProvider = 'codex';

  private readonly capabilities: readonly ControlCapability[];
  private readonly store: ControlSessionStore;
  private readonly pending = new Map<string, ControlMessage[]>();

  constructor(
    capabilities: readonly ControlCapability[] = ['register'],
    store: ControlSessionStore = new ControlSessionStore(),
  ) {
    this.capabilities = Object.freeze([...capabilities]);
    this.store = store;
    void this.pending;
    void CodexSessionInputSchema;
    void invalidArgs;
  }

  /** Probe the local Codex setup and build an adapter with discovered capabilities. */
  static async discover(
    paths?: CodexProbePaths,
    store?: ControlSessionStore,
  ): Promise<CodexControlAdapter> {
    void paths;
    void store;
    notImplemented();
  }

  describeCapabilities(): readonly ControlCapability[] {
    notImplemented();
  }

  supports(capability: ControlCapability): boolean {
    void capability;
    notImplemented();
  }

  /** Register/refresh a codex session carrying this adapter's discovered capabilities. */
  registerSession(input: CodexSessionInput = {}, now: number = Date.now()): ControlSession {
    void input;
    void now;
    void this.store;
    notImplemented();
  }

  async deliver(message: ControlMessage, session: ControlSession): Promise<DeliveryOutcome> {
    void message;
    void session;
    notImplemented();
  }

  /**
   * Take (and clear) the rendered instructions block for messages delivered
   * during the current instructions-render drain. Undefined when empty.
   */
  takePendingInstructions(session_id: string): string | undefined {
    void session_id;
    notImplemented();
  }
}
