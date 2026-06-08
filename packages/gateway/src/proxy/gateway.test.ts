/**
 * E2E in-process tests for GatewardenProxy (gateway-004).
 *
 * Architecture under test:
 *   test-client ↔ [GatewardenProxy server] → [enforcer] → [GatewardenProxy client] ↔ mock-downstream
 *
 * All transports are InMemoryTransport — no network, no subprocesses.
 * Govern bundle is wired directly (no config file I/O).
 *
 * Acceptance criteria:
 *   R1  — attach yields snapshot AND enforcement live in ONE flow (single downstream client)
 *   R3  — snapshot immutable after calls; rescore = new distinct snapshot
 *   R4  — no-token call DENIED; out-of-scope DENIED; in-scope forwarded
 *   R5  — unmapped tool passthrough (no enforcement)
 *   R7  — audit chain intact (InMemoryAuditSink.read() verifies hash chain)
 *   tsc = 0; vitest green
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type JSONRPCMessage,
  type JSONRPCRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type { Lease } from '@gatewarden/govern';
import {
  generateKeyPair,
  PasetoV4PublicSigner,
  InMemoryAuditSink,
  InMemoryRevocationList,
  InMemorySpendLedger,
  LeaseEnforcer,
} from '@gatewarden/govern';
import type { GovernBundle } from '../config/index.js';
import { GatewardenProxy } from './index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLease(overrides?: Partial<Lease>): Lease {
  return {
    id: 'lease-test-1',
    agentId: 'agent-test',
    taskId: 'task-test',
    capabilities: [{ kind: 'fs.read', paths: ['/data/**'] }],
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    kid: 'k1',
    ...overrides,
  };
}

/**
 * Send a JSON-RPC request over `transport` and wait for the response
 * with the matching id.
 */
async function sendAndWait(
  transport: InMemoryTransport,
  req: { id: number; method: string; params: unknown },
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const prev = transport.onmessage;
    transport.onmessage = (msg: JSONRPCMessage) => {
      const m = msg as Record<string, unknown>;
      if (m['id'] === req.id) {
        transport.onmessage = prev;
        resolve(m);
      } else {
        prev?.(msg);
      }
    };
    void transport.send({
      jsonrpc: '2.0',
      id: req.id,
      method: req.method,
      params: req.params,
    } as JSONRPCRequest);
    setTimeout(() => {
      transport.onmessage = prev;
      reject(new Error(`Timeout waiting for response to id=${req.id}`));
    }, 5_000);
  });
}

/**
 * Perform the MCP initialize handshake, optionally injecting a lease token.
 */
async function initSession(
  clientTransport: InMemoryTransport,
  token?: string,
  id = 1,
): Promise<void> {
  const meta: Record<string, unknown> = {};
  if (token !== undefined) {
    meta['x-lease-token'] = token;
  }

  await sendAndWait(clientTransport, {
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
      _meta: meta,
    },
  });

  // Send the initialized notification (no response expected).
  await clientTransport.send({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  } as JSONRPCMessage);
}

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

describe('GatewardenProxy', () => {
  let signer: PasetoV4PublicSigner;
  let audit: InMemoryAuditSink;
  let revocationList: InMemoryRevocationList;
  let spendLedger: InMemorySpendLedger;
  let bundle: GovernBundle;

  let mockDownstream: Server;
  let proxy: GatewardenProxy;

  // Transport pairs:
  //   [clientTransport, proxyServerTransport]  — test-client ↔ proxy server side
  //   [proxyClientTransport, downstreamServerTransport] — proxy client ↔ downstream
  let clientTransport: InMemoryTransport;
  let proxyServerTransport: InMemoryTransport;
  let proxyClientTransport: InMemoryTransport;
  let downstreamServerTransport: InMemoryTransport;

  /** Per-test canned responses from the mock downstream (tool name → content). */
  const downstreamResponses = new Map<
    string,
    { content: Array<{ type: 'text'; text: string }> }
  >();

  beforeEach(async () => {
    // Fresh govern components per test.
    const kp = generateKeyPair('k1');
    signer = new PasetoV4PublicSigner(kp);
    audit = new InMemoryAuditSink();
    revocationList = new InMemoryRevocationList();
    spendLedger = new InMemorySpendLedger();
    const enforcer = new LeaseEnforcer(signer, revocationList, spendLedger);

    bundle = {
      signer,
      policy: null as never, // not used by GatewardenProxy
      audit,
      revocationList,
      spendLedger,
      pendingStore: null as never, // not used by GatewardenProxy
      broker: null as never,       // not used by GatewardenProxy
      enforcer,
      resolver: (toolName, args) => {
        if (toolName === 'read_file') {
          const path = typeof args['path'] === 'string' ? args['path'] : '';
          return { kind: 'fs.read', path };
        }
        if (toolName === 'write_file') {
          const path = typeof args['path'] === 'string' ? args['path'] : '';
          return { kind: 'fs.write', path };
        }
        // unmapped → passthrough
        return undefined;
      },
    };

    // Transport pairs.
    [clientTransport, proxyServerTransport] = InMemoryTransport.createLinkedPair();
    [proxyClientTransport, downstreamServerTransport] = InMemoryTransport.createLinkedPair();

    // The proxy server transport needs a stable sessionId for token binding.
    proxyServerTransport.sessionId = 'test-session';

    // Mock downstream MCP server.
    downstreamResponses.clear();
    mockDownstream = new Server(
      { name: 'mock-downstream', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );

    mockDownstream.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [
        {
          name: 'read_file',
          description: 'Read a file. Returns the file contents as a string.',
          inputSchema: {
            type: 'object' as const,
            properties: { path: { type: 'string', description: 'Absolute path to read.' } },
            required: ['path'],
          },
        },
        {
          name: 'write_file',
          description: 'Write data to a file. Returns void on success.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              path: { type: 'string', description: 'Absolute path to write.' },
              content: { type: 'string', description: 'Content to write.' },
            },
            required: ['path', 'content'],
          },
        },
        {
          name: 'list_directory',
          description: 'List files in a directory.',
          inputSchema: {
            type: 'object' as const,
            properties: { path: { type: 'string', description: 'Directory path.' } },
            required: ['path'],
          },
        },
      ],
    }));

    mockDownstream.setRequestHandler(CallToolRequestSchema, (req) => {
      const toolName = req.params.name;
      const canned = downstreamResponses.get(toolName) ?? {
        content: [{ type: 'text' as const, text: `${toolName}: downstream ok` }],
      };
      return canned;
    });

    await mockDownstream.connect(downstreamServerTransport);

    // Build and attach the proxy.
    proxy = new GatewardenProxy(bundle);
    // attach() is called per-test (not in beforeEach) because some tests check
    // the snapshot returned by attach() directly.
  });

  afterEach(async () => {
    await proxy.close().catch(() => {});
    await mockDownstream.close().catch(() => {});
  });

  // ── R1: attach yields snapshot AND enforcement live in ONE flow ────────────

  describe('attach (R1)', () => {
    it('attach() returns an immutable GatewaySnapshot with server metadata', async () => {
      const snapshot = await proxy.attach(proxyServerTransport, proxyClientTransport);

      expect(snapshot.server.name).toBe('mock-downstream');
      expect(snapshot.server.version).toBe('1.0.0');
      expect(typeof snapshot.attachedAt).toBe('string');
      expect(Number.isNaN(new Date(snapshot.attachedAt).getTime())).toBe(false);
      expect(Object.isFrozen(snapshot)).toBe(true);
    });

    it('getSnapshot() returns the same object as attach()', async () => {
      const fromAttach = await proxy.attach(proxyServerTransport, proxyClientTransport);
      const fromGet = proxy.getSnapshot();

      expect(fromGet).toBe(fromAttach); // same reference
    });

    it('getSnapshot() throws if attach() was not called', () => {
      expect(() => proxy.getSnapshot()).toThrow(/attach/i);
    });

    it('attach scores the downstream (snapshot has a numeric lintScore)', async () => {
      const snapshot = await proxy.attach(proxyServerTransport, proxyClientTransport);

      expect(typeof snapshot.scorecard.aggregate.lintScore).toBe('number');
      expect(snapshot.scorecard.aggregate.lintScore).toBeGreaterThanOrEqual(1);
      expect(snapshot.scorecard.aggregate.lintScore).toBeLessThanOrEqual(10);
    });

    it('enforcement is live immediately after attach — in-scope call forwarded (R1)', async () => {
      await proxy.attach(proxyServerTransport, proxyClientTransport);

      const lease = makeLease({ capabilities: [{ kind: 'fs.read', paths: ['/data/**'] }] });
      const token = signer.issue(lease);
      downstreamResponses.set('read_file', {
        content: [{ type: 'text', text: 'hello from downstream' }],
      });

      await initSession(clientTransport, token);

      const response = await sendAndWait(clientTransport, {
        id: 2,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: '/data/readme.txt' } },
      });

      const result = response['result'] as Record<string, unknown> | undefined;
      expect(result?.['isError']).toBeFalsy();
      const content = result?.['content'] as Array<{ text: string }> | undefined;
      expect(content?.[0]?.text).toBe('hello from downstream');
    });
  });

  // ── R4: no-token DENIED ────────────────────────────────────────────────────

  describe('no-token call DENIED (R4)', () => {
    it('denies a mapped tool call when no lease token was presented at initialize', async () => {
      await proxy.attach(proxyServerTransport, proxyClientTransport);

      // Initialize WITHOUT a lease token.
      await initSession(clientTransport /* no token */);

      const response = await sendAndWait(clientTransport, {
        id: 2,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: '/data/file.txt' } },
      });

      const result = response['result'] as Record<string, unknown> | undefined;
      expect(result?.['isError']).toBe(true);
      const content = result?.['content'] as Array<{ text: string }> | undefined;
      expect(content?.[0]?.text).toMatch(/denied/i);
      expect(content?.[0]?.text).toMatch(/no lease token/i);
    });
  });

  // ── R4: out-of-scope DENIED, in-scope forwarded ────────────────────────────

  describe('scope enforcement (R4)', () => {
    it('denies an out-of-scope fs.read call', async () => {
      await proxy.attach(proxyServerTransport, proxyClientTransport);

      const lease = makeLease({ capabilities: [{ kind: 'fs.read', paths: ['/data/**'] }] });
      const token = signer.issue(lease);

      await initSession(clientTransport, token);

      const response = await sendAndWait(clientTransport, {
        id: 2,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: '/secrets/key.pem' } },
      });

      const result = response['result'] as Record<string, unknown> | undefined;
      expect(result?.['isError']).toBe(true);
      const content = result?.['content'] as Array<{ text: string }> | undefined;
      expect(content?.[0]?.text).toMatch(/denied/i);
    });

    it('forwards an in-scope fs.read call to the downstream', async () => {
      await proxy.attach(proxyServerTransport, proxyClientTransport);

      const lease = makeLease({ capabilities: [{ kind: 'fs.read', paths: ['/data/**'] }] });
      const token = signer.issue(lease);
      downstreamResponses.set('read_file', {
        content: [{ type: 'text', text: 'contents of the file' }],
      });

      await initSession(clientTransport, token);

      const response = await sendAndWait(clientTransport, {
        id: 2,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: '/data/report.txt' } },
      });

      const result = response['result'] as Record<string, unknown> | undefined;
      expect(result?.['isError']).toBeFalsy();
      const content = result?.['content'] as Array<{ text: string }> | undefined;
      expect(content?.[0]?.text).toBe('contents of the file');
    });

    it('denies an out-of-scope fs.write call', async () => {
      await proxy.attach(proxyServerTransport, proxyClientTransport);

      // Lease only allows fs.read — write should be denied.
      const lease = makeLease({ capabilities: [{ kind: 'fs.read', paths: ['/data/**'] }] });
      const token = signer.issue(lease);

      await initSession(clientTransport, token);

      const response = await sendAndWait(clientTransport, {
        id: 2,
        method: 'tools/call',
        params: { name: 'write_file', arguments: { path: '/data/file.txt', content: 'hello' } },
      });

      const result = response['result'] as Record<string, unknown> | undefined;
      expect(result?.['isError']).toBe(true);
    });
  });

  // ── R5: unmapped tool passthrough ──────────────────────────────────────────

  describe('unmapped tool passthrough (R5)', () => {
    it('passes through a call for an unmapped tool without enforcement', async () => {
      await proxy.attach(proxyServerTransport, proxyClientTransport);

      // Token with no capabilities — but list_directory is unmapped so it passes.
      const lease = makeLease({ capabilities: [] });
      const token = signer.issue(lease);
      downstreamResponses.set('list_directory', {
        content: [{ type: 'text', text: 'file1.txt, file2.txt' }],
      });

      await initSession(clientTransport, token);

      const response = await sendAndWait(clientTransport, {
        id: 2,
        method: 'tools/call',
        params: { name: 'list_directory', arguments: { path: '/data' } },
      });

      const result = response['result'] as Record<string, unknown> | undefined;
      expect(result?.['isError']).toBeFalsy();
      const content = result?.['content'] as Array<{ text: string }> | undefined;
      expect(content?.[0]?.text).toBe('file1.txt, file2.txt');
    });

    it('passes through even without a session token (unmapped = no enforcement)', async () => {
      await proxy.attach(proxyServerTransport, proxyClientTransport);

      // No token at all.
      await initSession(clientTransport);

      const response = await sendAndWait(clientTransport, {
        id: 2,
        method: 'tools/call',
        params: { name: 'list_directory', arguments: { path: '/data' } },
      });

      const result = response['result'] as Record<string, unknown> | undefined;
      // Unmapped tool → forwarded, no denial.
      expect(result?.['isError']).toBeFalsy();
    });
  });

  // ── R3: snapshot immutable after calls; rescore = new snapshot ─────────────

  describe('snapshot immutability and rescore (R3)', () => {
    it('snapshot is immutable (frozen) after attach', async () => {
      const snapshot = await proxy.attach(proxyServerTransport, proxyClientTransport);

      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.server)).toBe(true);
      expect(Object.isFrozen(snapshot.scorecard)).toBe(true);
    });

    it('snapshot is unchanged after tool calls', async () => {
      const snapshot = await proxy.attach(proxyServerTransport, proxyClientTransport);
      const originalLintScore = snapshot.scorecard.aggregate.lintScore;
      const originalAttachedAt = snapshot.attachedAt;

      const lease = makeLease({ capabilities: [{ kind: 'fs.read', paths: ['/data/**'] }] });
      const token = signer.issue(lease);

      await initSession(clientTransport, token);
      await sendAndWait(clientTransport, {
        id: 2,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: '/data/file.txt' } },
      });

      // Snapshot must not have changed.
      const after = proxy.getSnapshot();
      expect(after).toBe(snapshot); // same reference
      expect(after.scorecard.aggregate.lintScore).toBe(originalLintScore);
      expect(after.attachedAt).toBe(originalAttachedAt);
    });

    it('rescore() returns a new distinct snapshot (R3)', async () => {
      await proxy.attach(proxyServerTransport, proxyClientTransport);
      const original = proxy.getSnapshot();

      const rescored = await proxy.rescore();

      // Must be a different object.
      expect(rescored).not.toBe(original);
      expect(rescored.server).not.toBe(original.server);
      expect(rescored.scorecard).not.toBe(original.scorecard);
    });

    it('rescore() snapshot is also frozen (R3)', async () => {
      await proxy.attach(proxyServerTransport, proxyClientTransport);
      const rescored = await proxy.rescore();

      expect(Object.isFrozen(rescored)).toBe(true);
    });

    it('rescore() does NOT mutate the stored snapshot', async () => {
      const original = await proxy.attach(proxyServerTransport, proxyClientTransport);
      const originalAt = original.attachedAt;

      await proxy.rescore();

      // getSnapshot() still returns the original.
      expect(proxy.getSnapshot()).toBe(original);
      expect(proxy.getSnapshot().attachedAt).toBe(originalAt);
    });
  });

  // ── R7: audit chain intact ─────────────────────────────────────────────────

  describe('audit chain (R7)', () => {
    it('emits a use event for an allowed call — chain readable', async () => {
      await proxy.attach(proxyServerTransport, proxyClientTransport);

      const lease = makeLease({ capabilities: [{ kind: 'fs.read', paths: ['/data/**'] }] });
      const token = signer.issue(lease);

      await initSession(clientTransport, token);
      await sendAndWait(clientTransport, {
        id: 2,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: '/data/file.txt' } },
      });

      // read() verifies the hash chain — throws if tampered.
      const events = audit.read();
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events.some((e) => e.type === 'use')).toBe(true);
    });

    it('emits a denial event for a denied call — chain readable', async () => {
      await proxy.attach(proxyServerTransport, proxyClientTransport);

      // Lease for /data/** but call targets /secrets/
      const lease = makeLease({ capabilities: [{ kind: 'fs.read', paths: ['/data/**'] }] });
      const token = signer.issue(lease);

      await initSession(clientTransport, token);
      await sendAndWait(clientTransport, {
        id: 2,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: '/secrets/key.pem' } },
      });

      const events = audit.read();
      expect(events.some((e) => e.type === 'denial')).toBe(true);
    });

    it('audit chain is intact across multiple events', async () => {
      await proxy.attach(proxyServerTransport, proxyClientTransport);

      const lease = makeLease({ capabilities: [{ kind: 'fs.read', paths: ['/data/**'] }] });
      const token = signer.issue(lease);

      await initSession(clientTransport, token);

      // Allowed call.
      await sendAndWait(clientTransport, {
        id: 2,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: '/data/a.txt' } },
      });

      // Denied call.
      await sendAndWait(clientTransport, {
        id: 3,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: '/private/b.txt' } },
      });

      // read() verifies the full chain — will throw if any event was tampered.
      const events = audit.read();
      expect(events.length).toBe(2);
      expect(events[0]?.type).toBe('use');
      expect(events[1]?.type).toBe('denial');
    });
  });
});
