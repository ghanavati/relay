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
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';

import { makeError, toRelayException, type RelayException } from '../../errors.js';
import { pickDeliveryCapability } from '../broker.js';
import { renderMailboxContext } from './claude-code.js';
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

/**
 * Relay MCP server entry in ~/.codex/config.toml. Matches
 * `[mcp_servers.relay]`, `[mcp_servers."relay"]`, and the `relay-mcp`
 * variants — nothing else. A foreign server whose name merely contains
 * "relay" must not count (never overclaim).
 */
export const RELAY_MCP_ENTRY = /^\s*\[mcp_servers\.["']?relay(?:-mcp)?["']?\]/m;

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

/** Read a file; missing or unreadable → undefined (conservative probe). */
async function readProbeFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return undefined;
  }
}

/**
 * Probe ~/.codex for the two integration surfaces. Missing or unreadable
 * files are treated as "not configured" — discovery must never overclaim.
 */
export async function probeCodexControlSetup(paths?: CodexProbePaths): Promise<CodexControlProbe> {
  const agentsPath = paths?.agentsPath ?? join(homedir(), '.codex', 'AGENTS.md');
  const configPath = paths?.configPath ?? join(homedir(), '.codex', 'config.toml');

  const [agents, config] = await Promise.all([readProbeFile(agentsPath), readProbeFile(configPath)]);

  return Object.freeze({
    instructions_present:
      agents !== undefined &&
      agents.includes(RELAY_MANAGED_START) &&
      agents.includes(RELAY_MANAGED_END),
    mcp_configured: config !== undefined && RELAY_MCP_ENTRY.test(config),
  });
}

/**
 * Map probe results to the conservative capability set (see module header).
 * Never returns live_stdin or resume_send.
 */
export function deriveCodexCapabilities(probe: CodexControlProbe): readonly ControlCapability[] {
  const caps: ControlCapability[] = ['register'];
  if (probe.instructions_present) caps.push('context_inject');
  if (probe.instructions_present || probe.mcp_configured) caps.push('mailbox');
  if (probe.mcp_configured) caps.push('tool_call');
  return Object.freeze(caps);
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
  }

  /** Probe the local Codex setup and build an adapter with discovered capabilities. */
  static async discover(
    paths?: CodexProbePaths,
    store?: ControlSessionStore,
  ): Promise<CodexControlAdapter> {
    const probe = await probeCodexControlSetup(paths);
    return new CodexControlAdapter(deriveCodexCapabilities(probe), store);
  }

  describeCapabilities(): readonly ControlCapability[] {
    return this.capabilities;
  }

  supports(capability: ControlCapability): boolean {
    return this.capabilities.includes(capability);
  }

  /** Register/refresh a codex session carrying this adapter's discovered capabilities. */
  registerSession(input: CodexSessionInput = {}, now: number = Date.now()): ControlSession {
    const parsed = CodexSessionInputSchema.safeParse(input);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw invalidArgs(`invalid codex session input: ${detail}`);
    }
    const session_id = parsed.data.session_id ?? randomUUID();
    const existing = this.store.getSession(session_id);

    const session = this.store.upsertSession(
      {
        session_id,
        provider: this.provider,
        capabilities: this.capabilities,
        state: 'active',
        label: parsed.data.label ?? existing?.label ?? null,
        workdir: parsed.data.workdir ?? existing?.workdir ?? null,
        metadata: { capability_source: 'discovered' },
      },
      now,
    );

    this.store.appendEvent(
      {
        session_id,
        event_type: existing ? 'session_updated' : 'session_registered',
        payload: { provider: 'codex' },
      },
      now,
    );
    return session;
  }

  /**
   * Buffer the message for the next instructions-render boundary. Names the
   * strongest delivery capability shared with the session. Defensive: with no
   * shared delivery capability the registry refuses before calling this, but
   * a direct call still gets a truthful refusal instead of a silent drop.
   */
  async deliver(message: ControlMessage, session: ControlSession): Promise<DeliveryOutcome> {
    const capability = pickDeliveryCapability(session.capabilities, this.capabilities);
    if (capability === undefined) {
      return {
        ok: false,
        capability: 'mailbox',
        detail:
          'codex session has no delivery path (requires the Relay instructions block or a Relay MCP entry)',
      };
    }
    const inbox = this.pending.get(session.session_id) ?? [];
    inbox.push(message);
    this.pending.set(session.session_id, inbox);
    return { ok: true, capability };
  }

  /**
   * Take (and clear) the rendered instructions block for messages delivered
   * during the current instructions-render drain. Undefined when empty.
   */
  takePendingInstructions(session_id: string): string | undefined {
    const inbox = this.pending.get(session_id);
    if (!inbox || inbox.length === 0) return undefined;
    this.pending.delete(session_id);
    return renderMailboxContext(inbox);
  }
}
