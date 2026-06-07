/**
 * Deterministic fake control adapter (Phase 8 / Plan 02 / Task 2).
 *
 * Proves the universal control surface — broker policy, registry routing,
 * delivery audit — WITHOUT provider dependencies: pure in-memory, no
 * filesystem, no network, no randomness (D-01, CONTROL-01/03).
 *
 * Capabilities are declared per instance (D-01): two fakes may report
 * different sets, exactly like an ambient vs Relay-owned real session.
 * Delivered messages land in a per-session in-memory inbox readable via
 * `getInbox`. Failure injection (`failNext` / `throwNext`) is one-shot and
 * deterministic so tests can exercise the registry's failure handling.
 */
import { pickDeliveryCapability } from '../broker.js';
import type {
  ControlAdapter,
  ControlCapability,
  ControlMessage,
  ControlProvider,
  ControlSession,
  DeliveryOutcome,
} from '../types.js';

const DEFAULT_FAKE_CAPABILITIES = [
  'register',
  'observe',
  'tail',
  'mailbox',
  'tool_call',
] as const satisfies readonly ControlCapability[];

type InjectedOutcome =
  | { readonly kind: 'fail'; readonly detail: string }
  | { readonly kind: 'throw'; readonly detail: string };

export class FakeControlAdapter implements ControlAdapter {
  readonly provider: ControlProvider = 'fake';

  private readonly capabilities: readonly ControlCapability[];
  private readonly inboxes = new Map<string, ControlMessage[]>();
  private injected: InjectedOutcome | undefined;

  constructor(capabilities: readonly ControlCapability[] = DEFAULT_FAKE_CAPABILITIES) {
    this.capabilities = Object.freeze([...capabilities]);
  }

  describeCapabilities(): readonly ControlCapability[] {
    return this.capabilities;
  }

  supports(capability: ControlCapability): boolean {
    return this.capabilities.includes(capability);
  }

  /**
   * Deliver into the per-session in-memory inbox. Reports the strongest
   * delivery capability shared with the session, mirroring how real
   * adapters name the mechanism they actually used.
   */
  async deliver(message: ControlMessage, session: ControlSession): Promise<DeliveryOutcome> {
    const capability =
      pickDeliveryCapability(session.capabilities, this.capabilities) ?? 'mailbox';

    const injected = this.injected;
    if (injected !== undefined) {
      this.injected = undefined; // one-shot
      if (injected.kind === 'throw') {
        throw new Error(injected.detail);
      }
      return { ok: false, capability, detail: injected.detail };
    }

    const inbox = this.inboxes.get(session.session_id) ?? [];
    inbox.push(message);
    this.inboxes.set(session.session_id, inbox);
    return { ok: true, capability };
  }

  /** Messages delivered to a session, oldest first. */
  getInbox(session_id: string): readonly ControlMessage[] {
    return Object.freeze([...(this.inboxes.get(session_id) ?? [])]);
  }

  /** Make the NEXT deliver return ok:false with this detail (one-shot). */
  failNext(detail: string): void {
    this.injected = { kind: 'fail', detail };
  }

  /** Make the NEXT deliver throw with this detail (one-shot). */
  throwNext(detail: string): void {
    this.injected = { kind: 'throw', detail };
  }
}
