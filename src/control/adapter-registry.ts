/**
 * Control adapter registry (Phase 8 / Plan 02 / Task 2).
 *
 * One adapter per provider. Delivery routing is CAPABILITY-BASED (D-01):
 * a target is deliverable only when the session's declared capabilities and
 * the adapter's declared capabilities share at least one delivery
 * capability; the strongest shared one (DELIVERY_CAPABILITY_PREFERENCE
 * order) is the routed mechanism. Unsupported operations are refused with
 * RelayError — never silently degraded.
 *
 * `deliverQueued` drains a target's queued mailbox through the adapter and
 * audits every attempt: a control_delivery_attempts row per try plus the
 * broker's message_delivered / message_failed events (D-05). Adapter
 * exceptions are contained — the message is marked failed, the drain
 * continues. Human- and LLM-originated messages take this exact same path
 * (D-03/D-13); the fake adapter proves it before any real provider lands.
 *
 * Only `ControlAdapter.deliver` is awaited — every store/broker call stays
 * synchronous better-sqlite3.
 */
import { makeError, toRelayException, type RelayException } from '../errors.js';
import { ControlBroker, pickDeliveryCapability } from './broker.js';
import { ControlSessionStore } from './session-store.js';
import type {
  ControlAdapter,
  ControlCapability,
  ControlProvider,
  DeliveryOutcome,
} from './types.js';

/** Per-message outcome of a deliverQueued drain. */
export interface DeliveryReport {
  readonly message_id: string;
  readonly ok: boolean;
  readonly capability: ControlCapability;
  readonly detail?: string;
}

function controlError(code: Parameters<typeof makeError>[0], message: string): RelayException {
  return toRelayException(makeError(code, message, false));
}

export class ControlAdapterRegistry {
  private readonly adapters = new Map<ControlProvider, ControlAdapter>();
  private readonly store: ControlSessionStore;
  private readonly broker: ControlBroker;

  constructor(store: ControlSessionStore = new ControlSessionStore(), broker?: ControlBroker) {
    this.store = store;
    this.broker = broker ?? new ControlBroker(store);
  }

  /** Register the adapter for its provider. One adapter per provider. */
  register(adapter: ControlAdapter): void {
    if (this.adapters.has(adapter.provider)) {
      throw controlError(
        'CONTROL_ADAPTER_DUPLICATE',
        `an adapter for provider "${adapter.provider}" is already registered`,
      );
    }
    this.adapters.set(adapter.provider, adapter);
  }

  get(provider: ControlProvider): ControlAdapter | undefined {
    return this.adapters.get(provider);
  }

  list(): readonly ControlAdapter[] {
    return Object.freeze([...this.adapters.values()]);
  }

  /**
   * Drain the target's queued, unexpired messages through its provider's
   * adapter. Refuses (RelayError) when the session is unknown, its provider
   * has no adapter, or session ∩ adapter share no delivery capability.
   * Returns one report per message, oldest first.
   */
  async deliverQueued(target_session_id: string, now: number = Date.now()): Promise<readonly DeliveryReport[]> {
    const session = this.store.getSession(target_session_id);
    if (!session) {
      throw controlError(
        'CONTROL_SESSION_NOT_FOUND',
        `target session ${target_session_id} is not registered`,
      );
    }

    const adapter = this.adapters.get(session.provider);
    if (!adapter) {
      throw controlError(
        'PROVIDER_NOT_CONFIGURED',
        `no control adapter registered for provider "${session.provider}"`,
      );
    }

    const routedCapability = pickDeliveryCapability(
      session.capabilities,
      adapter.describeCapabilities(),
    );
    if (routedCapability === undefined) {
      throw controlError(
        'CONTROL_DELIVERY_UNSUPPORTED',
        `session ${target_session_id} and the "${session.provider}" adapter share no delivery capability`,
      );
    }

    const reports: DeliveryReport[] = [];
    for (const message of this.store.getQueuedMessages(target_session_id, now)) {
      let outcome: DeliveryOutcome;
      try {
        outcome = await adapter.deliver(message, session);
      } catch (err) {
        // Contain adapter exceptions: audit as a failed attempt on the
        // routed capability and keep draining the rest of the queue.
        outcome = {
          ok: false,
          capability: routedCapability,
          detail: `adapter threw: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      this.store.recordDeliveryAttempt(
        {
          message_id: message.message_id,
          capability: outcome.capability,
          status: outcome.ok ? 'success' : 'failure',
          detail: outcome.detail ?? null,
        },
        now,
      );
      if (outcome.ok) {
        this.broker.markDelivered(message.message_id, { capability: outcome.capability, now });
      } else {
        this.broker.markFailed(message.message_id, outcome.detail ?? 'delivery failed', {
          capability: outcome.capability,
          now,
        });
      }

      reports.push(
        Object.freeze({
          message_id: message.message_id,
          ok: outcome.ok,
          capability: outcome.capability,
          ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
        }),
      );
    }
    return Object.freeze(reports);
  }
}

export function createControlAdapterRegistry(
  store?: ControlSessionStore,
  broker?: ControlBroker,
): ControlAdapterRegistry {
  const sessionStore = store ?? new ControlSessionStore();
  return new ControlAdapterRegistry(sessionStore, broker ?? new ControlBroker(sessionStore));
}
