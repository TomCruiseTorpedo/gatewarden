/**
 * A2A upstream server face — gatewarden serves its governed MCP surface as an
 * A2A agent (ADR-I).
 *
 * The @a2a-js/sdk server module supplies the ingress subsystem the C7 verdict
 * flagged as expensive: `DefaultRequestHandler` gives task store, `ListTasks`
 * (cursor pagination + authz scoping), `A2A-Version` negotiation, and the
 * §5.4 error mapping for free; `JsonRpcTransportHandler` frames JSON-RPC. What
 * remains — and all this module implements — is the ONE `AgentExecutor` that
 * turns a governed A2A request into a governed downstream MCP tools/call.
 *
 * Ingress gate (W3 profile, reused verbatim):
 *   1. requestedExtensions must declare the lease URI → else protocol reject
 *   2. lease token from message metadata → enforcer.check on the resolved
 *      Action → else task `rejected`
 *   3. veto pending → task `auth-required`
 *   4. allow → forward to the downstream, publish the result task
 *
 * v1 invocation convention: the incoming Message carries a single DataPart
 * `{ tool: string, arguments: object }` naming the downstream tool to call.
 * (A2A skills carry no parameter schema — C5 — so the call shape travels as
 * structured data, documented on the generated card's skill descriptions.)
 *
 * JSON-RPC binding only; streaming / push / extended-card declined (the
 * generated card advertises none). This module is the only server-side
 * @a2a-js/sdk consumer.
 */

import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server';
import type { AgentCard, Part, Task } from '@a2a-js/sdk';
import { Role, TaskState } from '@a2a-js/sdk';

import {
  A2aLeaseBinding,
  declaresLeaseExtension,
  evaluateA2aLeaseGate,
  extractLeaseToken,
  LEASE_EXT_URI,
} from '@gatewarden/govern';
import type { Action, AuditEvent } from '@gatewarden/govern';
import type { GovernBundle } from '../config/index.js';

// ---------------------------------------------------------------------------
// Downstream tool caller (injected — the proxy's shared MCP client in prod,
// a fake in tests; keeps this module off the MCP SDK too)
// ---------------------------------------------------------------------------

export interface DownstreamToolCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Invocation parsing (the v1 DataPart convention)
// ---------------------------------------------------------------------------

interface ToolInvocation {
  tool: string;
  arguments: Record<string, unknown>;
}

/** Extract `{ tool, arguments }` from the first well-formed DataPart, or null. */
export function parseToolInvocation(parts: readonly Part[]): ToolInvocation | null {
  for (const part of parts) {
    const content = part.content;
    if (content?.$case === 'data' && content.value !== null && typeof content.value === 'object') {
      const record = content.value as Record<string, unknown>;
      if (typeof record['tool'] === 'string') {
        const args = record['arguments'];
        return {
          tool: record['tool'],
          arguments: typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {},
        };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface GatewardenAgentExecutorOptions {
  bundle: GovernBundle;
  downstream: DownstreamToolCaller;
  /** Shared context→token binding (profile §Context binding). */
  binding?: A2aLeaseBinding;
  /** Veto-pending predicate (ADR-D PendingStore), keyed by contextId. */
  hasPendingApproval?: (contextId: string) => boolean;
}

// ---------------------------------------------------------------------------
// Terminal-task helpers
// ---------------------------------------------------------------------------

const nowIso = (): string => new Date().toISOString();

function statusMessage(taskId: string, contextId: string, text: string): NonNullable<Task['status']>['message'] {
  return {
    messageId: `${taskId}-status`,
    contextId,
    taskId,
    role: Role.ROLE_AGENT,
    parts: [{ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: '' }],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

function terminalTask(
  taskId: string,
  contextId: string,
  state: TaskState,
  text: string,
): Task {
  const message = statusMessage(taskId, contextId, text);
  return {
    id: taskId,
    contextId,
    status: { state, message, timestamp: nowIso() },
    artifacts: [],
    history: message !== undefined ? [message] : [],
    metadata: undefined,
  } as unknown as Task;
}

// ---------------------------------------------------------------------------
// GatewardenAgentExecutor
// ---------------------------------------------------------------------------

export class GatewardenAgentExecutor implements AgentExecutor {
  private readonly binding: A2aLeaseBinding;

  constructor(private readonly opts: GatewardenAgentExecutorOptions) {
    this.binding = opts.binding ?? new A2aLeaseBinding();
  }

  execute = async (requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> => {
    const { userMessage, taskId, contextId, context } = requestContext;

    const declared = context.requestedExtensions ?? [];
    const parts = Array.isArray(userMessage.parts) ? userMessage.parts : [];

    // ── Ingress stage 1: extension support (protocol-level) ────────────────
    if (!declaresLeaseExtension(declared)) {
      this.audit('denial', { contextId, reason: 'lease extension not declared' });
      eventBus.publish(
        AgentEvent.task(
          terminalTask(
            taskId,
            contextId,
            TaskState.TASK_STATE_REJECTED,
            'Rejected: this agent requires the lease extension ' +
              `(${LEASE_EXT_URI}) to be declared in A2A-Extensions.`,
          ),
        ),
      );
      eventBus.finished();
      return;
    }
    context.addActivatedExtension(LEASE_EXT_URI); // echo the activation (SHOULD)

    // ── Resolve the invocation → Action ────────────────────────────────────
    const invocation = parseToolInvocation(parts);
    if (invocation === null) {
      eventBus.publish(
        AgentEvent.task(
          terminalTask(
            taskId,
            contextId,
            TaskState.TASK_STATE_REJECTED,
            'Rejected: no tool invocation found. Send a DataPart { tool, arguments }.',
          ),
        ),
      );
      eventBus.finished();
      return;
    }

    const action: Action | undefined = this.opts.bundle.resolver(
      invocation.tool,
      invocation.arguments,
    );

    // Unmapped tool → passthrough is still lease-gated at the extension level
    // but has no Action to enforce; use a benign non-matching action so the
    // gate's enforcer sees "in scope only if the lease grants it". For an
    // unmapped tool we forward after the token check (mirrors the MCP proxy's
    // R5 passthrough, but only once the client is lease-aware).
    const gateAction: Action = action ?? { kind: 'http.call', endpoint: `mcp://tool/${invocation.tool}` };

    // ── Ingress stages 2-4: lease / veto / allow (W3 gate, verbatim) ───────
    const decision = evaluateA2aLeaseGate(
      {
        declaredExtensions: declared,
        metadata: userMessage.metadata ?? undefined,
        contextId,
        action: gateAction,
      },
      {
        binding: this.binding,
        enforcer: this.opts.bundle.enforcer,
        ...(this.opts.hasPendingApproval !== undefined
          ? { hasPendingApproval: this.opts.hasPendingApproval }
          : {}),
      },
    );

    if (decision.outcome === 'reject-protocol') {
      // declaresLeaseExtension already passed above, so this branch is
      // unreachable in practice — handle defensively.
      this.audit('denial', { contextId, reason: decision.reason });
      eventBus.publish(
        AgentEvent.task(terminalTask(taskId, contextId, TaskState.TASK_STATE_REJECTED, decision.reason)),
      );
      eventBus.finished();
      return;
    }
    if (decision.outcome === 'reject-task') {
      this.audit('denial', { contextId, tool: invocation.tool, reason: decision.reason });
      eventBus.publish(
        AgentEvent.task(terminalTask(taskId, contextId, TaskState.TASK_STATE_REJECTED, decision.reason)),
      );
      eventBus.finished();
      return;
    }
    if (decision.outcome === 'pause-task') {
      eventBus.publish(
        AgentEvent.task(
          terminalTask(taskId, contextId, TaskState.TASK_STATE_AUTH_REQUIRED, decision.reason),
        ),
      );
      eventBus.finished();
      return;
    }

    // ── Allow: forward to the downstream, publish the result ───────────────
    this.audit('use', { contextId, tool: invocation.tool, ...(action !== undefined ? { action } : {}) });
    try {
      const result = await this.opts.downstream.callTool(invocation.tool, invocation.arguments);
      eventBus.publish(AgentEvent.task(this.completedTask(taskId, contextId, result)));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      eventBus.publish(
        AgentEvent.task(
          terminalTask(taskId, contextId, TaskState.TASK_STATE_FAILED, `downstream error: ${reason}`),
        ),
      );
    }
    eventBus.finished();
  };

  cancelTask = async (taskId: string, eventBus: ExecutionEventBus): Promise<void> => {
    eventBus.publish(
      AgentEvent.task(terminalTask(taskId, '', TaskState.TASK_STATE_CANCELED, 'canceled by client')),
    );
    eventBus.finished();
  };

  private completedTask(taskId: string, contextId: string, result: unknown): Task {
    return {
      id: taskId,
      contextId,
      status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: nowIso() },
      artifacts: [
        {
          artifactId: `${taskId}-result`,
          name: 'tool-result',
          parts: [
            {
              content: { $case: 'data', value: result as Record<string, unknown> },
              metadata: undefined,
              filename: '',
              mediaType: '',
            },
          ],
          metadata: undefined,
        },
      ],
      history: [],
      metadata: undefined,
    } as unknown as Task;
  }

  private audit(type: AuditEvent['type'], detail: Record<string, unknown>): void {
    this.opts.bundle.audit.append({
      type,
      at: nowIso(),
      detail,
      prevHash: '',
      hash: '',
    } as AuditEvent);
  }
}

// ---------------------------------------------------------------------------
// Server face assembly
// ---------------------------------------------------------------------------

/**
 * Build the JSON-RPC transport handler for the gateway's A2A face. The
 * DefaultRequestHandler supplies task store + ListTasks + version negotiation
 * + §5.4 error mapping; a caller wires `handle()` to an HTTP endpoint.
 */
export function buildA2aServerFace(options: {
  card: AgentCard;
  bundle: GovernBundle;
  downstream: DownstreamToolCaller;
  binding?: A2aLeaseBinding;
  hasPendingApproval?: (contextId: string) => boolean;
}): { transport: JsonRpcTransportHandler; requestHandler: DefaultRequestHandler } {
  const executor = new GatewardenAgentExecutor({
    bundle: options.bundle,
    downstream: options.downstream,
    ...(options.binding !== undefined ? { binding: options.binding } : {}),
    ...(options.hasPendingApproval !== undefined
      ? { hasPendingApproval: options.hasPendingApproval }
      : {}),
  });
  const requestHandler = new DefaultRequestHandler(options.card, new InMemoryTaskStore(), executor);
  const transport = new JsonRpcTransportHandler(requestHandler);
  return { transport, requestHandler };
}

/** Re-export for callers assembling a ServerCallContext with requested extensions. */
export { ServerCallContext };
