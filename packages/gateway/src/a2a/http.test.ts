/**
 * Full-stack A2A face tests (ADR-I HTTP mount).
 *
 * The whole trilogy in one loop, over live HTTP: wireGovern issues a REAL
 * PASETO v4.public lease via the broker, the client carries it per the W3
 * profile (metadata + extensions + A2A-Extensions header), the face runs the
 * ingress ladder through the SDK's DefaultRequestHandler, and the governed
 * downstream call comes back as a COMPLETED task artifact. Deny paths are
 * verified to produce the right protocol/task outcomes with zero downstream
 * traffic.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentCard } from '@a2a-js/sdk';
import { attachLeaseToken, LEASE_EXT_URI } from '@gatewarden/govern';

import { wireGovern } from '../config/index.js';
import type { GatewayConfig } from '../contract/index.js';
import { generateAgentCard } from './card-generator.js';
import { serveA2aFace, type RunningA2aFace } from './http.js';
import type { DownstreamToolCaller } from './server-face.js';

// ---------------------------------------------------------------------------
// Rig: real govern bundle + real lease + fake downstream + live HTTP
// ---------------------------------------------------------------------------

const CONFIG: GatewayConfig = {
  downstream: { transport: 'stdio', command: 'unused-in-test' },
  policy: [
    { ruleId: 'allow-data-reads', effect: 'allow', capabilityKind: 'fs.read', paths: ['./data/**'] },
  ],
  toolActions: [{ toolName: 'read_report', kind: 'fs.read', pathArg: 'path' }],
};

const TOOLS = [
  {
    name: 'read_report',
    description: 'Reads a report file from the data directory.',
    inputSchema: { type: 'object' as const },
  },
];

const bundle = wireGovern(CONFIG);
const downstreamCalls: string[] = [];
const downstream: DownstreamToolCaller = {
  async callTool(name, args) {
    downstreamCalls.push(name);
    return { content: [{ type: 'text', text: `read ${String(args['path'])}` }] };
  },
};

let face: RunningA2aFace;
let leaseToken: string;

beforeAll(async () => {
  // Issue a REAL lease through the broker (policy: fs.read under ./data/**).
  const outcome = bundle.broker.request({
    agentId: 'remote-client-1',
    taskId: 'ctx-e2e-1',
    capabilities: [{ kind: 'fs.read', paths: ['./data/**'] }],
    requestedDurationMs: 60_000,
  });
  if (outcome.type !== 'granted') throw new Error(`lease not granted: ${outcome.type}`);
  leaseToken = outcome.token;

  const card = generateAgentCard(TOOLS, CONFIG.toolActions, {
    name: 'E2E Gatewarden Face',
    description: 'Full-stack test face.',
    version: '0.0.1',
    interfaceUrl: 'http://127.0.0.1:0/a2a/v1',
  }) as unknown as AgentCard;

  face = await serveA2aFace({ card, bundle, downstream });
});

afterAll(async () => {
  await face.close();
});

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

// Builds the v1 proto-JSON wire shape the active SDK handler deserializes via
// SendMessageRequest.fromJSON: role "ROLE_USER", parts carry a bare `data`
// object. attachLeaseToken adds the metadata key + extensions array, both of
// which survive Message.fromJSON.
function invocationMessage(over: { contextId?: string; token?: string | null; tool?: string; path?: string }) {
  const base = {
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    contextId: over.contextId ?? 'ctx-e2e-1',
    role: 'ROLE_USER' as const,
    parts: [
      { data: { tool: over.tool ?? 'read_report', arguments: { path: over.path ?? './data/q3.csv' } } },
    ],
    metadata: {} as Record<string, unknown>,
    extensions: [] as string[],
  };
  return over.token === null || over.token === undefined
    ? base
    : attachLeaseToken(base, over.token);
}

interface WireTask {
  id?: string;
  status?: { state?: unknown };
}

/** Task from a SendMessage result envelope ({ task } | { message }). */
function taskOf(result: { task?: WireTask }): WireTask {
  return result.task ?? {};
}

/** Task state string (v1 serializes to "TASK_STATE_*"), lowercased. */
function stateOf(result: { task?: WireTask }): string {
  return String(taskOf(result).status?.state).toLowerCase();
}

async function rpc(
  method: string,
  params: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await fetch(face.endpointUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

const DECLARE = { 'a2a-extensions': LEASE_EXT_URI, 'a2a-version': '1.0' };

// ---------------------------------------------------------------------------
// Card availability (§8.1)
// ---------------------------------------------------------------------------

describe('well-known card', () => {
  it('serves the generated card at /.well-known/agent-card.json', async () => {
    const response = await fetch(face.cardUrl);
    expect(response.status).toBe(200);
    const card = (await response.json()) as { name: string; capabilities: { extensions: Array<{ uri: string; required: boolean }> } };
    expect(card.name).toBe('E2E Gatewarden Face');
    expect(card.capabilities.extensions[0]).toMatchObject({ uri: LEASE_EXT_URI, required: true });
  });
});

// ---------------------------------------------------------------------------
// The governed loop
// ---------------------------------------------------------------------------

describe('message/send over live HTTP', () => {
  it('rejects extension-unaware clients with JSON-RPC -32008 before dispatch (§3.3.4)', async () => {
    const { status, body } = await rpc('SendMessage', {
      message: invocationMessage({ token: leaseToken }),
    }); // NO A2A-Extensions header
    expect(status).toBe(400);
    expect(body.error.code).toBe(-32008);
    expect(downstreamCalls).toHaveLength(0);
  });

  it('completes a governed call with a REAL PASETO lease end-to-end', async () => {
    const { status, body, headers } = await rpc(
      'SendMessage',
      { message: invocationMessage({ token: leaseToken }) },
      DECLARE,
    );
    expect(status).toBe(200);
    expect(headers.get('a2a-extensions')).toContain(LEASE_EXT_URI); // activation echoed
    expect(stateOf(body.result)).toContain('completed');
    expect(downstreamCalls).toEqual(['read_report']);
  });

  it('rejects a lease that does not cover the requested path (deny = no downstream call)', async () => {
    const before = downstreamCalls.length;
    const { status, body } = await rpc(
      'SendMessage',
      {
        message: invocationMessage({
          contextId: 'ctx-e2e-1',
          token: leaseToken,
          path: './secrets/passwords.txt', // outside ./data/**
        }),
      },
      DECLARE,
    );
    expect(status).toBe(200); // task-level rejection, not protocol
    expect(stateOf(body.result)).toContain('rejected');
    expect(downstreamCalls.length).toBe(before);
  });

  it('rejects a garbage token', async () => {
    const before = downstreamCalls.length;
    const { body } = await rpc(
      'SendMessage',
      { message: invocationMessage({ contextId: 'ctx-other', token: 'v4.public.garbage' }) },
      DECLARE,
    );
    expect(stateOf(body.result)).toContain('rejected');
    expect(downstreamCalls.length).toBe(before);
  });

  it('retrieves the completed task via GetTask', async () => {
    const send = await rpc(
      'SendMessage',
      { message: invocationMessage({ token: leaseToken, path: './data/q4.csv' }) },
      DECLARE,
    );
    const taskId = taskOf(send.body.result).id as string;
    const got = await rpc('GetTask', { id: taskId }, DECLARE);
    expect(got.status).toBe(200);
    expect(got.body.result.id).toBe(taskId);
  });

  it('returns 404 off the two mounted routes and parse errors as -32700', async () => {
    const miss = await fetch(`${face.url}/nope`, { method: 'POST' });
    expect(miss.status).toBe(404);
    const bad = await fetch(face.endpointUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...DECLARE },
      body: '{not json',
    });
    expect(bad.status).toBe(400);
    const badBody = (await bad.json()) as { error: { code: number } };
    expect(badBody.error.code).toBe(-32700);
  });
});

// ---------------------------------------------------------------------------
// Signed card + live JWKS (ADR-I re-signing key)
// ---------------------------------------------------------------------------

describe('signed card over live HTTP', () => {
  it('serves a signed card + JWKS and verifies at crypto-jku end-to-end', async () => {
    const { generateCardSigningKeys, signAgentCard, verifyCardSignature } = await import(
      '@gatewarden/score'
    );
    const keys = await generateCardSigningKeys({ kid: 'e2e-key' });

    const unsigned = generateAgentCard(TOOLS, CONFIG.toolActions, {
      name: 'Signed E2E Face',
      description: 'Signed full-stack test face.',
      version: '0.0.2',
      interfaceUrl: 'http://127.0.0.1:0/a2a/v1',
    });

    // Sign FIRST with a placeholder jku, then rewrite once the port is known?
    // No — sign against the real jku by binding the server in two phases is
    // overkill for the test: serve on an ephemeral port, then embed the
    // ACTUAL jku by signing after bind would change the card. Instead run a
    // dedicated face whose jku we control: bind, read the port, sign with
    // the live jku, and serve a SECOND face with the final signed card.
    const probe = await serveA2aFace({
      card: unsigned as never,
      bundle,
      downstream,
      jwks: keys.jwks as { keys: unknown[] },
    });
    await probe.close();

    const signedFace = await (async () => {
      // Two-phase: reserve a port by binding once, close, rebind same port.
      const first = await serveA2aFace({
        card: unsigned as never,
        bundle,
        downstream,
        jwks: keys.jwks as { keys: unknown[] },
      });
      const port = Number(new URL(first.url).port);
      await first.close();
      const jku = `http://127.0.0.1:${port}/.well-known/jwks.json`;
      const signed = await signAgentCard(unsigned, keys.privateJwk, { jku });
      return serveA2aFace({
        card: signed as never,
        bundle,
        downstream,
        jwks: keys.jwks as { keys: unknown[] },
        port,
      });
    })();

    try {
      // The JWKS endpoint serves the public key…
      const jwksResponse = await fetch(signedFace.jwksUrl!);
      expect(jwksResponse.status).toBe(200);

      // …and the raw served card verifies at crypto-jku via that live URL.
      //
      // The jku fetch is SSRF-guarded and refuses loopback by default. This
      // jku points at a server THIS TEST started moments ago on 127.0.0.1 —
      // the one case the opt-in exists for: caller intent, not card intent.
      // Production callers scoring third-party cards must never set it.
      const rawCard = await (await fetch(signedFace.cardUrl)).json();
      const report = await verifyCardSignature(rawCard as never, {
        fetchJku: true,
        dangerouslyAllowPrivateJku: true,
      });
      expect(report.tier).toBe('crypto-jku');

      // Pinned beats jku when the key store is supplied too.
      const pinned = await verifyCardSignature(rawCard as never, {
        keyStore: { keys: { 'e2e-key': keys.publicJwk } },
        fetchJku: true,
        dangerouslyAllowPrivateJku: true,
      });
      expect(pinned.tier).toBe('crypto-pinned');
    } finally {
      await signedFace.close();
    }
  });

  it('returns 404 from the JWKS route when serving an unsigned card', async () => {
    const response = await fetch(`${face.url}/.well-known/jwks.json`);
    expect(response.status).toBe(404);
  });
});
