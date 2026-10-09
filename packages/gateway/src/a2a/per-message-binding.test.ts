/**
 * Token-on-every-message mode for the A2A face (`a2a-serve --require-token-per-message`).
 *
 * The profile's context binding (ADR-F) lets a client present its lease once and
 * omit it afterwards: the first message of a `contextId` that presents a token
 * binds the context. The face has no caller authentication, so a bound
 * `contextId` then acts as a bearer: anyone who sends it, tokenless, gets the
 * lease's authority. `PerMessageBinding` never remembers a token, so the gate
 * has nothing to fall back on and every message must carry its own.
 *
 * Both faces below share one govern bundle and one lease; the ONLY difference is
 * the binding. The default face is the control: the same sequence completes there.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentCard } from '@a2a-js/sdk';
import { A2aLeaseBinding, attachLeaseToken, LEASE_EXT_URI } from '@gatewarden/govern';

import { wireGovern } from '../config/index.js';
import type { GatewayConfig } from '../contract/index.js';
import { generateAgentCard } from './card-generator.js';
import { serveA2aFace, type RunningA2aFace } from './http.js';
import type { DownstreamToolCaller } from './server-face.js';
import { PerMessageBinding } from './per-message-binding.js';

const CONFIG: GatewayConfig = {
  downstream: { transport: 'stdio', command: 'unused-in-test' },
  policy: [
    { ruleId: 'allow-data-reads', effect: 'allow', capabilityKind: 'fs.read', paths: ['./data/**'] },
  ],
  toolActions: [{ toolName: 'read_report', kind: 'fs.read', pathArg: 'path' }],
};

const TOOLS = [
  { name: 'read_report', description: 'Reads a report.', inputSchema: { type: 'object' as const } },
];

const bundle = wireGovern(CONFIG);
const downstreamCalls: string[] = [];
const downstream: DownstreamToolCaller = {
  async callTool(name, args) {
    downstreamCalls.push(name);
    return { content: [{ type: 'text', text: `read ${String(args['path'])}` }] };
  },
};

let defaultFace: RunningA2aFace;
let strictFace: RunningA2aFace;
let token: string;

beforeAll(async () => {
  const outcome = bundle.broker.request({
    agentId: 'client',
    taskId: 'ctx-1',
    capabilities: [{ kind: 'fs.read', paths: ['./data/**'] }],
    requestedDurationMs: 60_000,
  });
  if (outcome.type !== 'granted') throw new Error(`lease not granted: ${outcome.type}`);
  token = outcome.token;

  const card = generateAgentCard(TOOLS, CONFIG.toolActions, {
    name: 'Per-message binding face',
    description: 'test',
    version: '0.0.1',
    interfaceUrl: 'http://127.0.0.1:0/a2a/v1',
  }) as unknown as AgentCard;

  defaultFace = await serveA2aFace({ card, bundle, downstream });
  strictFace = await serveA2aFace({ card, bundle, downstream, binding: new PerMessageBinding() });
});

afterAll(async () => {
  await defaultFace.close();
  await strictFace.close();
});

const DECLARE = { 'a2a-extensions': LEASE_EXT_URI, 'a2a-version': '1.0' };

function message(contextId: string, withToken: string | undefined) {
  const base = {
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    contextId,
    role: 'ROLE_USER' as const,
    parts: [{ data: { tool: 'read_report', arguments: { path: './data/q3.csv' } } }],
    metadata: {} as Record<string, unknown>,
    extensions: [] as string[],
  };
  return withToken === undefined ? base : attachLeaseToken(base, withToken);
}

/** Send one message to `face`; return the task state, lowercased, and any status text. */
async function send(face: RunningA2aFace, contextId: string, withToken: string | undefined) {
  const response = await fetch(face.endpointUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...DECLARE },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'SendMessage',
      params: { message: message(contextId, withToken) },
    }),
  });
  const task = ((await response.json()) as { result?: { task?: { status?: { state?: unknown; message?: unknown } } } })
    .result?.task;
  return {
    state: String(task?.status?.state).toLowerCase(),
    text: JSON.stringify(task?.status?.message ?? ''),
  };
}

describe('PerMessageBinding', () => {
  it('never remembers a token, and accepts every bind', () => {
    const binding = new PerMessageBinding();
    expect(binding.bind('ctx', 'tok-a')).toEqual({ ok: true });
    expect(binding.tokenFor('ctx')).toBeUndefined();
    expect(binding.bind('ctx', 'tok-b')).toEqual({ ok: true }); // no mid-context conflict to report
    expect(binding.size).toBe(0);
  });

  it('is still an A2aLeaseBinding, so the face accepts it', () => {
    expect(new PerMessageBinding()).toBeInstanceOf(A2aLeaseBinding);
  });
});

describe('a face with the default binding (control)', () => {
  it('completes a tokenless message on a context the lease already bound', async () => {
    const first = await send(defaultFace, 'ctx-control', token);
    expect(first.state).toContain('completed');

    const tokenless = await send(defaultFace, 'ctx-control', undefined);

    // This is the bearer behaviour the flag exists to remove.
    expect(tokenless.state).toContain('completed');
  });
});

describe('a face with PerMessageBinding', () => {
  it('completes a message that carries a valid token', async () => {
    const before = downstreamCalls.length;
    const result = await send(strictFace, 'ctx-strict', token);
    expect(result.state).toContain('completed');
    expect(downstreamCalls.length).toBe(before + 1);
  });

  it('rejects a tokenless message on a context a valid token was just presented on', async () => {
    expect((await send(strictFace, 'ctx-strict-2', token)).state).toContain('completed');
    const before = downstreamCalls.length;

    const tokenless = await send(strictFace, 'ctx-strict-2', undefined);

    expect(tokenless.state).toContain('rejected');
    expect(tokenless.text).toContain('no lease token presented');
    expect(downstreamCalls.length).toBe(before); // nothing reached the downstream
  });

  it('still rejects a garbage token, on its own merits', async () => {
    const before = downstreamCalls.length;
    const result = await send(strictFace, 'ctx-strict-3', 'v4.public.garbage');
    expect(result.state).toContain('rejected');
    expect(result.text).toContain('invalid token');
    expect(downstreamCalls.length).toBe(before);
  });

  it('judges each message on its own token: a valid one after a rejected tokenless one still works', async () => {
    expect((await send(strictFace, 'ctx-strict-4', undefined)).state).toContain('rejected');
    expect((await send(strictFace, 'ctx-strict-4', token)).state).toContain('completed');
  });
});
