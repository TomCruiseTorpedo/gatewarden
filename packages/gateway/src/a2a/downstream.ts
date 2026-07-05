/**
 * Governed A2A downstream — score-at-attach + govern-every-send for a remote
 * A2A agent (ADR-H; W4 increment 2).
 *
 * This module (src/a2a/) is the ONLY place @a2a-js/sdk is imported — the SDK
 * is a 1.0.0-beta pin behind this seam; the single re-pin point when it GAs.
 *
 * Governance model (mirrors GatewardenProxy's tools/call gate, task-centric):
 *   - Baseline action: every send is an `http.call` to the agent's interface
 *     URL — leases scope WHICH agents may be delegated to (endpoint
 *     allow-list), reusing the existing capability vocabulary unchanged.
 *   - Optional spend action extracted from DataParts (A2aSendPolicy).
 *   - The lease token rides outbound per the govern a2a lane (W3 profile):
 *     metadata[LEASE_EXT_URI] + Message.extensions + the A2A-Extensions
 *     header via the SDK's withA2AExtensions service parameter.
 *   - Deny → no wire traffic at all; audit `denial`. Allow → send + audit `use`.
 */

import { randomUUID } from 'node:crypto';

import {
  ClientFactory,
  JsonRpcTransportFactory,
  ServiceParameters,
  withA2AExtensions,
} from '@a2a-js/sdk/client';
import type { Client, RequestOptions } from '@a2a-js/sdk/client';
import type { AgentCard, Message, Part, Task } from '@a2a-js/sdk';
import { Role, TaskState } from '@a2a-js/sdk';

import { LEASE_EXT_URI, attachLeaseToken } from '@gatewarden/govern';
import type { Action, AuditEvent, AuditSink, Enforcer } from '@gatewarden/govern';
import type { A2aSendPolicy } from '../contract/index.js';

// ---------------------------------------------------------------------------
// Wire-client seam (injectable for tests; the SDK Client satisfies it)
// ---------------------------------------------------------------------------

/** Per-request options subset the governed downstream uses. */
export interface A2aWireRequestOptions {
  /** Header-borne context, e.g. the A2A-Extensions declaration. */
  serviceParameters?: Record<string, string>;
}

/** The three operations the governed downstream drives. */
export interface A2aWireClient {
  sendMessage(
    params: {
      tenant: string;
      message: Message | undefined;
      configuration: undefined;
      metadata: undefined;
    },
    options?: A2aWireRequestOptions,
  ): Promise<unknown>;
  getTask(params: { tenant: string; id: string }, options?: A2aWireRequestOptions): Promise<Task>;
  cancelTask(params: { tenant: string; id: string }, options?: A2aWireRequestOptions): Promise<Task>;
}

/**
 * The A2A-Extensions declaration every governed request carries
 * (W3 profile §Negotiation) — precomputed once.
 */
export const LEASE_SERVICE_PARAMETERS: Readonly<Record<string, string>> = Object.freeze(
  ServiceParameters.create(withA2AExtensions(LEASE_EXT_URI)),
);

// ---------------------------------------------------------------------------
// Send input/result shapes
// ---------------------------------------------------------------------------

/** One outbound delegation request. */
export interface A2aSendInput {
  /** Plain text prompt, or pre-built Parts for structured content. */
  content: string | Part[];
  /** Context to associate (binds the lease per the W3 profile). */
  contextId: string;
  /** The PASETO lease token authorising this delegation. */
  leaseToken: string;
}

/** The governed verdict + wire result. */
export type A2aSendResult =
  | { sent: false; reason: string; deniedAction: Action }
  | { sent: true; result: unknown };

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface GovernedA2aDownstreamOptions {
  /** The wire client (SDK Client, or a fake in tests). */
  client: A2aWireClient;
  /** The agent's primary interface URL — the baseline http.call endpoint. */
  interfaceUrl: string;
  /** ADR-B enforcement pipeline, unchanged. */
  enforcer: Pick<Enforcer, 'check'>;
  /** Audit sink for use/denial events. */
  audit: AuditSink;
  /** Optional spend extraction (ADR-H). */
  policy?: A2aSendPolicy;
}

// ---------------------------------------------------------------------------
// Action derivation (exported for tests)
// ---------------------------------------------------------------------------

/** Read a key from the first DataPart that carries it. */
function dataPartValue(parts: readonly Part[], key: string): unknown {
  for (const part of parts) {
    const content = part.content;
    if (content?.$case === 'data' && content.value !== null && typeof content.value === 'object') {
      const record = content.value as Record<string, unknown>;
      if (key in record) return record[key];
    }
  }
  return undefined;
}

/**
 * Derive the enforcement actions for one send: the baseline http.call, plus
 * a spend action when policy keys are configured AND present in a DataPart.
 * Present-but-malformed spend values return an error string (deny outright).
 */
export function deriveSendActions(
  parts: readonly Part[],
  interfaceUrl: string,
  policy?: A2aSendPolicy,
): { actions: Action[] } | { malformed: string } {
  const actions: Action[] = [{ kind: 'http.call', endpoint: interfaceUrl }];

  const spend = policy?.spendExtraction;
  if (spend !== undefined) {
    const currency = dataPartValue(parts, spend.currencyKey);
    const amount = dataPartValue(parts, spend.amountKey);
    const anyPresent = currency !== undefined || amount !== undefined;

    if (anyPresent) {
      if (typeof currency !== 'string' || currency.length === 0) {
        return { malformed: `spend field '${spend.currencyKey}' is missing or not a string` };
      }
      if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0) {
        return {
          malformed: `spend field '${spend.amountKey}' must be a non-negative integer (minor units)`,
        };
      }
      actions.push({ kind: 'spend', currency, amountMinor: amount });
    }
  }

  return { actions };
}

// ---------------------------------------------------------------------------
// GovernedA2aDownstream
// ---------------------------------------------------------------------------

export class GovernedA2aDownstream {
  constructor(private readonly opts: GovernedA2aDownstreamOptions) {}

  /**
   * Govern and (if permitted) send one message to the remote agent.
   *
   * Deny paths produce NO wire traffic — the denial happens before the SDK
   * is touched, exactly like the MCP proxy's tools/call gate.
   */
  async send(input: A2aSendInput): Promise<A2aSendResult> {
    const parts: Part[] =
      typeof input.content === 'string'
        ? [
            {
              content: { $case: 'text', value: input.content },
              metadata: undefined,
              filename: '',
              mediaType: '',
            },
          ]
        : input.content;

    // ── 1. Derive actions (baseline http.call + optional spend) ────────────
    const derived = deriveSendActions(parts, this.opts.interfaceUrl, this.opts.policy);
    if ('malformed' in derived) {
      const denied: Action = { kind: 'http.call', endpoint: this.opts.interfaceUrl };
      this.appendEvent('denial', { reason: derived.malformed, contextId: input.contextId });
      return { sent: false, reason: derived.malformed, deniedAction: denied };
    }

    // ── 2. Enforce every derived action (deny on first failure) ────────────
    for (const action of derived.actions) {
      const verdict = this.opts.enforcer.check(input.leaseToken, action);
      if (!verdict.ok) {
        const reason = verdict.reason ?? 'enforcement denied';
        this.appendEvent('denial', { reason, action, contextId: input.contextId });
        return { sent: false, reason, deniedAction: action };
      }
    }

    // ── 3. Permitted: carry the lease per the W3 profile and send ──────────
    const bare: Message = {
      messageId: randomUUID(),
      contextId: input.contextId,
      taskId: '',
      role: Role.ROLE_USER,
      parts,
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    };
    const message = attachLeaseToken(
      { ...bare, metadata: bare.metadata ?? {}, extensions: bare.extensions },
      input.leaseToken,
    ) as Message;

    this.appendEvent('use', {
      contextId: input.contextId,
      actions: derived.actions,
      endpoint: this.opts.interfaceUrl,
    });

    const result = await this.opts.client.sendMessage(
      { tenant: '', message, configuration: undefined, metadata: undefined },
      { serviceParameters: { ...LEASE_SERVICE_PARAMETERS } },
    );
    return { sent: true, result };
  }

  /** Fetch a task by id (passthrough — reads are not lease-gated in v1). */
  async getTask(id: string): Promise<Task> {
    return this.opts.client.getTask(
      { tenant: '', id },
      { serviceParameters: { ...LEASE_SERVICE_PARAMETERS } },
    );
  }

  /** Cancel a task (the forced fallback while a veto is pending — W3 pins). */
  async cancelTask(id: string): Promise<Task> {
    return this.opts.client.cancelTask(
      { tenant: '', id },
      { serviceParameters: { ...LEASE_SERVICE_PARAMETERS } },
    );
  }

  // -------------------------------------------------------------------------

  private appendEvent(type: AuditEvent['type'], detail: Record<string, unknown>): void {
    const event: AuditEvent = {
      type,
      at: new Date().toISOString(),
      detail,
      prevHash: '',
      hash: '',
    };
    this.opts.audit.append(event);
  }
}

// ---------------------------------------------------------------------------
// Terminal-state helper (ADR-H non-terminal policy)
// ---------------------------------------------------------------------------

/** Terminal task states per A2A §3.1.2. */
const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);

export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

// ---------------------------------------------------------------------------
// SDK factory (the real wire)
// ---------------------------------------------------------------------------

/**
 * Build a real SDK client from a (typed) Agent Card over the JSON-RPC
 * binding. The lease extension is declared per request via
 * LEASE_SERVICE_PARAMETERS (W3 profile §Negotiation) — see send()/getTask().
 *
 * The RAW card from attach is what scoring saw (attach.ts); the SDK's typed
 * AgentCard is only used here to pick the transport.
 */
export async function createA2aWireClient(card: AgentCard): Promise<A2aWireClient> {
  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory()],
  });
  const client: Client = await factory.createFromAgentCard(card);
  // The SDK Client's methods accept RequestOptions ⊇ A2aWireRequestOptions.
  return client as unknown as A2aWireClient;
}

// Keep the RequestOptions import earning its place: assert compatibility.
type _AssertOptionsSubset = A2aWireRequestOptions extends Pick<RequestOptions, 'serviceParameters'>
  ? true
  : never;
const _optionsSubsetOk: _AssertOptionsSubset = true;
void _optionsSubsetOk;
