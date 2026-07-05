/**
 * A2A upstream server-face tests (ADR-I).
 *
 * Drives GatewardenAgentExecutor through a captured event bus + a fake
 * RequestContext, asserting the W3 ingress ladder end-to-end: protocol
 * rejection when the extension is undeclared, task `rejected` on a failed
 * lease, `auth-required` on a pending veto, and a governed downstream call
 * on allow (deny paths never touch the downstream).
 */

import { describe, expect, it } from 'vitest';
import { TaskState } from '@a2a-js/sdk';
import type { Message, Part, Task } from '@a2a-js/sdk';
import { A2aLeaseBinding, LEASE_EXT_URI } from '@gatewarden/govern';
import type { Action, AuditEvent, VerifyResult } from '@gatewarden/govern';

import {
  GatewardenAgentExecutor,
  parseToolInvocation,
  type DownstreamToolCaller,
} from './server-face.js';
import type { GovernBundle } from '../config/index.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Capture what the executor publishes. */
class CapturingBus {
  events: Array<{ kind: string; data: unknown }> = [];
  finishedCalled = false;
  publish(event: { kind: string; data: unknown }): void {
    this.events.push(event);
  }
  finished(): void {
    this.finishedCalled = true;
  }
  // unused EventEmitter surface
  on() { return this; }
  off() { return this; }
  once() { return this; }
  removeAllListeners() { return this; }
}

/** Fake downstream: records calls, returns a canned result. */
function fakeDownstream(): { caller: DownstreamToolCaller; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    caller: {
      async callTool(name) {
        calls.push(name);
        return { ok: true, tool: name };
      },
    },
  };
}

function bundle(
  check: (token: string, action: Action) => VerifyResult,
  resolver: GovernBundle['resolver'] = () => ({ kind: 'fs.read', path: './data/x' }),
): { bundle: GovernBundle; audit: AuditEvent[] } {
  const audit: AuditEvent[] = [];
  return {
    audit,
    bundle: {
      resolver,
      enforcer: { check },
      audit: { append: (e: AuditEvent) => void audit.push(e) },
    } as unknown as GovernBundle,
  };
}

function dataPart(value: unknown): Part {
  return { content: { $case: 'data', value }, metadata: undefined, filename: '', mediaType: '' };
}

function requestContext(over: {
  declaredExtensions?: string[];
  metadata?: Record<string, unknown>;
  parts?: Part[];
  contextId?: string;
}) {
  const activated: string[] = [];
  const message: Message = {
    messageId: 'm1',
    contextId: over.contextId ?? 'ctx-1',
    taskId: '',
    role: 1,
    parts: over.parts ?? [dataPart({ tool: 'read_report', arguments: { path: './data/x' } })],
    metadata: over.metadata ?? { [LEASE_EXT_URI]: { token: 'good-token' } },
    extensions: [],
    referenceTaskIds: [],
  };
  return {
    ctx: {
      userMessage: message,
      taskId: 'task-1',
      contextId: over.contextId ?? 'ctx-1',
      context: {
        requestedExtensions: over.declaredExtensions ?? [LEASE_EXT_URI],
        addActivatedExtension: (uri: string) => void activated.push(uri),
      },
    },
    activated,
  };
}

const allow = (): VerifyResult => ({ ok: true });

function taskEvents(bus: CapturingBus): Task[] {
  return bus.events.filter((e) => e.kind === 'task').map((e) => e.data as Task);
}

// ---------------------------------------------------------------------------
// parseToolInvocation
// ---------------------------------------------------------------------------

describe('parseToolInvocation', () => {
  it('reads { tool, arguments } from the first data part', () => {
    expect(parseToolInvocation([dataPart({ tool: 'x', arguments: { a: 1 } })])).toEqual({
      tool: 'x',
      arguments: { a: 1 },
    });
  });

  it('defaults arguments to {} and ignores non-data / malformed parts', () => {
    expect(parseToolInvocation([dataPart({ tool: 'x' })])).toEqual({ tool: 'x', arguments: {} });
    expect(
      parseToolInvocation([
        { content: { $case: 'text', value: 'hi' }, metadata: undefined, filename: '', mediaType: '' },
      ]),
    ).toBeNull();
    expect(parseToolInvocation([dataPart({ noTool: true })])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The ingress ladder
// ---------------------------------------------------------------------------

describe('GatewardenAgentExecutor ingress', () => {
  it('rejects at the protocol level when the extension is not declared', async () => {
    const { bundle: b, audit } = bundle(allow);
    const down = fakeDownstream();
    const exec = new GatewardenAgentExecutor({ bundle: b, downstream: down.caller });
    const bus = new CapturingBus();
    const { ctx } = requestContext({ declaredExtensions: ['https://other/ext'] });

    await exec.execute(ctx as never, bus as never);

    const tasks = taskEvents(bus);
    expect(tasks[0]?.status?.state).toBe(TaskState.TASK_STATE_REJECTED);
    expect(down.calls).toEqual([]); // deny = no downstream traffic
    expect(audit.map((e) => e.type)).toContain('denial');
    expect(bus.finishedCalled).toBe(true);
  });

  it('activates the extension and forwards on a permitted call', async () => {
    const { bundle: b, audit } = bundle(allow);
    const down = fakeDownstream();
    const exec = new GatewardenAgentExecutor({ bundle: b, downstream: down.caller });
    const bus = new CapturingBus();
    const { ctx, activated } = requestContext({});

    await exec.execute(ctx as never, bus as never);

    expect(activated).toContain(LEASE_EXT_URI); // echoed the activation
    expect(down.calls).toEqual(['read_report']); // forwarded
    const tasks = taskEvents(bus);
    expect(tasks[0]?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(audit.map((e) => e.type)).toContain('use');
  });

  it('rejects the task (not the protocol) when the lease fails enforcement', async () => {
    const { bundle: b } = bundle(() => ({ ok: false, reason: 'path not in lease scope' }));
    const down = fakeDownstream();
    const exec = new GatewardenAgentExecutor({ bundle: b, downstream: down.caller });
    const bus = new CapturingBus();
    const { ctx } = requestContext({});

    await exec.execute(ctx as never, bus as never);

    const tasks = taskEvents(bus);
    expect(tasks[0]?.status?.state).toBe(TaskState.TASK_STATE_REJECTED);
    expect(down.calls).toEqual([]);
  });

  it('rejects when no tool invocation is present', async () => {
    const { bundle: b } = bundle(allow);
    const down = fakeDownstream();
    const exec = new GatewardenAgentExecutor({ bundle: b, downstream: down.caller });
    const bus = new CapturingBus();
    const { ctx } = requestContext({
      parts: [{ content: { $case: 'text', value: 'hello' }, metadata: undefined, filename: '', mediaType: '' }],
    });

    await exec.execute(ctx as never, bus as never);

    expect(taskEvents(bus)[0]?.status?.state).toBe(TaskState.TASK_STATE_REJECTED);
    expect(down.calls).toEqual([]);
  });

  it('pauses to auth-required when a veto is pending and no token is presented', async () => {
    const { bundle: b } = bundle(allow);
    const down = fakeDownstream();
    const exec = new GatewardenAgentExecutor({
      bundle: b,
      downstream: down.caller,
      binding: new A2aLeaseBinding(),
      hasPendingApproval: () => true,
    });
    const bus = new CapturingBus();
    const { ctx } = requestContext({ metadata: {} }); // no token

    await exec.execute(ctx as never, bus as never);

    expect(taskEvents(bus)[0]?.status?.state).toBe(TaskState.TASK_STATE_AUTH_REQUIRED);
    expect(down.calls).toEqual([]);
  });

  it('surfaces a downstream error as a FAILED task', async () => {
    const { bundle: b } = bundle(allow);
    const exec = new GatewardenAgentExecutor({
      bundle: b,
      downstream: {
        async callTool() {
          throw new Error('downstream exploded');
        },
      },
    });
    const bus = new CapturingBus();
    const { ctx } = requestContext({});

    await exec.execute(ctx as never, bus as never);

    const task = taskEvents(bus)[0];
    expect(task?.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(task?.status?.message?.parts?.[0]).toMatchObject({
      content: { $case: 'text', value: expect.stringContaining('downstream exploded') },
    });
  });

  it('binds the context so a later tokenless message in the same context still enforces', async () => {
    const { bundle: b } = bundle(allow);
    const down = fakeDownstream();
    const binding = new A2aLeaseBinding();
    const exec = new GatewardenAgentExecutor({ bundle: b, downstream: down.caller, binding });

    await exec.execute(requestContext({}).ctx as never, new CapturingBus() as never);
    expect(binding.tokenFor('ctx-1')).toBe('good-token');

    const bus2 = new CapturingBus();
    await exec.execute(requestContext({ metadata: {} }).ctx as never, bus2 as never);
    expect(down.calls).toEqual(['read_report', 'read_report']); // second forwarded via bound token
    expect(taskEvents(bus2)[0]?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });
});
