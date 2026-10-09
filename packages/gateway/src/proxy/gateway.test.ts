/**
 * E2E in-process tests for GatewardenProxy (gateway-004).
 *
 * Architecture under test:
 *   test-client ↔ [GatewardenProxy server] → [enforcer] → [GatewardenProxy client] ↔ mock-downstream
 *
 * All transports are InMemoryTransport — no network, no subprocesses — except the
 * final describe block, which drives the REAL StdioServerTransport over in-process
 * pipes. Govern bundle is wired directly (no config file I/O).
 *
 * Acceptance criteria:
 *   R1  — attach yields snapshot AND enforcement live in ONE flow (single downstream client)
 *   R3  — snapshot immutable after calls; rescore = new distinct snapshot
 *   R4  — no-token call DENIED; out-of-scope DENIED; in-scope forwarded
 *   R5  — unmapped tool passthrough (no enforcement)
 *   R7  — audit chain intact (InMemoryAuditSink.read() verifies hash chain)
 *   tsc = 0; vitest green
 */

import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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

  /** Number of tools/call requests that reached the mock downstream. */
  let downstreamCalls = 0;

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
    downstreamCalls = 0;
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
      downstreamCalls += 1;
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

  // ── R4: session binding on transports with no session identity ─────────────

  describe('session binding without a transport sessionId (R4, stdio)', () => {
    beforeEach(() => {
      // stdio never sets transport.sessionId, nor does streamable HTTP in
      // stateless mode. Remove the fixture's id so the proxy sees what those
      // transports present.
      delete proxyServerTransport.sessionId;
    });

    it('enforces normally when the transport carries no session id', async () => {
      // Keying the binding on sessionId alone filed the handshake token under
      // `undefined` and never found it again, so every mapped call was denied
      // for want of a token that was in fact presented.
      await proxy.attach(proxyServerTransport, proxyClientTransport);

      const lease = makeLease({ capabilities: [{ kind: 'fs.read', paths: ['/data/**'] }] });
      const token = signer.issue(lease);
      downstreamResponses.set('read_file', {
        content: [{ type: 'text', text: 'file contents' }],
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
      expect(content?.[0]?.text).toBe('file contents');
      expect(downstreamCalls).toBe(1);
    });

    it('still denies an out-of-scope call when the transport carries no session id', async () => {
      // Binding under a shared key is about FINDING the token, not trusting
      // it. Scope is still enforced.
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
      expect(downstreamCalls).toBe(0);
    });

    it('a handshake presenting no token clears the binding rather than inheriting it', async () => {
      // Under a shared binding key, a token left standing by an earlier
      // handshake would let a tokenless client inherit that lease. The
      // handshake is authoritative, so the absent case deletes.
      await proxy.attach(proxyServerTransport, proxyClientTransport);

      const lease = makeLease({ capabilities: [{ kind: 'fs.read', paths: ['/data/**'] }] });
      await initSession(clientTransport, signer.issue(lease), 1);

      // Re-handshake with NO token in _meta.
      await sendAndWait(clientTransport, {
        id: 2,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      });

      const response = await sendAndWait(clientTransport, {
        id: 3,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: '/data/readme.txt' } },
      });

      const result = response['result'] as Record<string, unknown> | undefined;
      expect(result?.['isError']).toBe(true);
      const content = result?.['content'] as Array<{ text: string }> | undefined;
      expect(content?.[0]?.text).toMatch(/no lease token/i);
      expect(downstreamCalls).toBe(0);
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

    // ── Audit attribution — every event names the lease it acted under ───────
    //
    // Regression: these events were once appended with no `leaseId` at all.
    // Under stdio one process was roughly one agent was roughly one lease, so
    // the field was recoverable from deployment context — but that stops being
    // true the moment one proxy serves many leases, and the hash chain seals an
    // unattributable record just as faithfully as an attributable one.
    it('attributes a use event to the lease id from the VERIFIED lease', async () => {
      await proxy.attach(proxyServerTransport, proxyClientTransport);

      const lease = makeLease({
        id: 'lease-attribution-use',
        taskId: 'task-attribution-use',
        capabilities: [{ kind: 'fs.read', paths: ['/data/**'] }],
      });
      const token = signer.issue(lease);

      await initSession(clientTransport, token);
      await sendAndWait(clientTransport, {
        id: 2,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: '/data/file.txt' } },
      });

      const useEvent = audit.read().find((e) => e.type === 'use');
      expect(useEvent).toBeDefined();
      expect(useEvent?.leaseId).toBe('lease-attribution-use');
      expect(useEvent?.detail['taskId']).toBe('task-attribution-use');
    });

    it('attributes a scope denial to the lease id — the token verified, it just did not authorize', async () => {
      await proxy.attach(proxyServerTransport, proxyClientTransport);

      const lease = makeLease({
        id: 'lease-attribution-denial',
        taskId: 'task-attribution-denial',
        capabilities: [{ kind: 'fs.read', paths: ['/data/**'] }],
      });
      const token = signer.issue(lease);

      await initSession(clientTransport, token);
      await sendAndWait(clientTransport, {
        id: 2,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: '/secrets/key.pem' } },
      });

      const denial = audit.read().find((e) => e.type === 'denial');
      expect(denial).toBeDefined();
      expect(denial?.leaseId).toBe('lease-attribution-denial');
      expect(denial?.detail['taskId']).toBe('task-attribution-denial');
    });

    it('records NO leaseId when the token fails signature verification', async () => {
      await proxy.attach(proxyServerTransport, proxyClientTransport);

      // A token signed by a DIFFERENT key: its claims decode, but no signature
      // in this proxy's keyring backs them. Attributing the denial to the id
      // inside it would let a forger write any lease id into the audit log.
      const foreignSigner = new PasetoV4PublicSigner(generateKeyPair('k1'));
      const forged = foreignSigner.issue(
        makeLease({
          id: 'lease-forged-not-ours',
          capabilities: [{ kind: 'fs.read', paths: ['/data/**'] }],
        }),
      );

      await initSession(clientTransport, forged);
      await sendAndWait(clientTransport, {
        id: 2,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: '/data/file.txt' } },
      });

      const denial = audit.read().find((e) => e.type === 'denial');
      expect(denial).toBeDefined();
      // Unattributed, and specifically NOT attributed to the forged id.
      expect(denial?.leaseId).toBeUndefined();
      expect(JSON.stringify(denial)).not.toContain('lease-forged-not-ours');
    });

    // ── Ungoverned calls are counted, not invisible ──────────────────────────
    //
    // Regression: an unmapped tool was forwarded with NO audit event at all, so
    // an operator reading the log saw only governed traffic and could infer
    // there had been no other kind.
    it('emits a passthrough event for an unmapped tool, and still forwards it', async () => {
      await proxy.attach(proxyServerTransport, proxyClientTransport);

      const token = signer.issue(makeLease({ capabilities: [] }));
      downstreamResponses.set('list_directory', {
        content: [{ type: 'text', text: 'file1.txt, file2.txt' }],
      });

      await initSession(clientTransport, token);
      const response = await sendAndWait(clientTransport, {
        id: 2,
        method: 'tools/call',
        params: { name: 'list_directory', arguments: { path: '/data' } },
      });

      // Still forwarded — the passthrough event must not change behaviour.
      const result = response['result'] as Record<string, unknown> | undefined;
      expect(result?.['isError']).toBeFalsy();
      const content = result?.['content'] as Array<{ text: string }> | undefined;
      expect(content?.[0]?.text).toBe('file1.txt, file2.txt');

      const passthroughs = audit.read().filter((e) => e.type === 'passthrough');
      expect(passthroughs).toHaveLength(1);
      expect(passthroughs[0]?.detail['toolName']).toBe('list_directory');
      // Not folded into `use` — that would claim governance never performed.
      expect(audit.read().some((e) => e.type === 'use')).toBe(false);
    });

    it('emits a passthrough event even with no session token at all', async () => {
      await proxy.attach(proxyServerTransport, proxyClientTransport);

      await initSession(clientTransport /* no token */);
      await sendAndWait(clientTransport, {
        id: 2,
        method: 'tools/call',
        params: { name: 'list_directory', arguments: { path: '/data' } },
      });

      const passthroughs = audit.read().filter((e) => e.type === 'passthrough');
      expect(passthroughs).toHaveLength(1);
      // Nothing was verified, so there is nothing to attribute it to.
      expect(passthroughs[0]?.leaseId).toBeUndefined();
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

// ---------------------------------------------------------------------------
// Session binding over a REAL stdio transport
// ---------------------------------------------------------------------------

/**
 * Regression coverage for the stdio session-binding defect.
 *
 * Every proxy test above drives an InMemoryTransport. The main fixture assigns
 * `proxyServerTransport.sessionId` by hand, and the "without a transport
 * sessionId" block deletes it again, but even that block only simulates what
 * stdio presents. The real StdioServerTransport never sets `sessionId`, so a
 * token bound at `initialize` and keyed on `extra.sessionId` alone was filed
 * under `undefined` and never found again: the published proxy denied every
 * mapped tool call over stdio while the suite stayed green.
 *
 * These tests therefore use the REAL StdioServerTransport class over real
 * pipes, speaking real newline-delimited JSON framing, and assign no session
 * identity anywhere. A test that supplies or simulates its own sessionId cannot
 * fail the way production failed, so it is not coverage of this bug.
 */
describe('GatewardenProxy over a real stdio transport', () => {
  let signer: PasetoV4PublicSigner;
  let audit: InMemoryAuditSink;
  let mockDownstream: Server;
  let proxy: GatewardenProxy;
  let stdioTransport: StdioServerTransport;

  /** Number of tools/call requests that reached the mock downstream. */
  let downstreamCalls: number;

  /** Client → proxy stdin, and proxy stdout → client. */
  let toProxy: PassThrough;
  let fromProxy: PassThrough;
  /** Responses parsed off the proxy's stdout, keyed by JSON-RPC id. */
  let responses: Map<number, Record<string, unknown>>;

  beforeEach(async () => {
    const kp = generateKeyPair('k1');
    signer = new PasetoV4PublicSigner(kp);
    audit = new InMemoryAuditSink();
    const revocationList = new InMemoryRevocationList();
    const spendLedger = new InMemorySpendLedger();

    const bundle: GovernBundle = {
      signer,
      policy: null as never,
      audit,
      revocationList,
      spendLedger,
      pendingStore: null as never,
      broker: null as never,
      enforcer: new LeaseEnforcer(signer, revocationList, spendLedger),
      resolver: (toolName, args) => {
        if (toolName === 'read_file') {
          const path = typeof args['path'] === 'string' ? args['path'] : '';
          return { kind: 'fs.read', path };
        }
        return undefined;
      },
    };

    downstreamCalls = 0;
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
      ],
    }));
    mockDownstream.setRequestHandler(CallToolRequestSchema, (req) => {
      downstreamCalls += 1;
      return { content: [{ type: 'text' as const, text: `${req.params.name}: ok` }] };
    });
    const [proxyClientTransport, downstreamServerTransport] =
      InMemoryTransport.createLinkedPair();
    await mockDownstream.connect(downstreamServerTransport);

    // The real stdio transport, over real pipes. No sessionId is set here —
    // that is the whole point, and StdioServerTransport never sets one itself.
    toProxy = new PassThrough();
    fromProxy = new PassThrough();
    stdioTransport = new StdioServerTransport(toProxy, fromProxy);

    responses = new Map();
    let buffer = '';
    fromProxy.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim() === '') continue;
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (typeof msg['id'] === 'number') responses.set(msg['id'], msg);
      }
    });

    proxy = new GatewardenProxy(bundle);
    await proxy.attach(stdioTransport, proxyClientTransport);
  });

  afterEach(async () => {
    await proxy.close().catch(() => {});
    await mockDownstream.close().catch(() => {});
  });

  /** Write one newline-delimited JSON-RPC message to the proxy's stdin. */
  function writeMessage(msg: Record<string, unknown>): void {
    toProxy.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  }

  /** Wait for the response with the given id to appear on the proxy's stdout. */
  async function awaitResponse(id: number): Promise<Record<string, unknown>> {
    for (let i = 0; i < 200; i++) {
      const hit = responses.get(id);
      if (hit !== undefined) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`Timeout waiting for response to id=${id}`);
  }

  /** Run the initialize handshake, presenting `token` in `_meta` when given. */
  async function handshake(token?: string): Promise<void> {
    writeMessage({
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'stdio-test-client', version: '1.0.0' },
        ...(token !== undefined ? { _meta: { 'x-lease-token': token } } : {}),
      },
    });
    await awaitResponse(1);
    writeMessage({ method: 'notifications/initialized' });
  }

  async function callReadFile(path: string): Promise<{
    isError: unknown;
    text: string | undefined;
  }> {
    writeMessage({
      id: 2,
      method: 'tools/call',
      params: { name: 'read_file', arguments: { path } },
    });
    const result = (await awaitResponse(2))['result'] as Record<string, unknown>;
    const content = result['content'] as Array<{ text: string }>;
    return { isError: result['isError'], text: content[0]?.text };
  }

  it('binds the lease token presented at initialize and forwards an in-scope call', async () => {
    // Guards the premise: if the SDK ever starts setting a stdio sessionId,
    // these tests would stop exercising the session-less path.
    expect(stdioTransport.sessionId).toBeUndefined();

    const token = signer.issue(makeLease({ capabilities: [{ kind: 'fs.read', paths: ['/data/**'] }] }));
    await handshake(token);

    const { isError, text } = await callReadFile('/data/report.txt');

    // The precise failure this guards: the binding is lost, so an in-scope call
    // is refused for having no token rather than being forwarded.
    expect(text).not.toContain('no lease token bound to session');
    expect(isError).toBeFalsy();
    expect(text).toBe('read_file: ok');
    expect(downstreamCalls).toBe(1);
  });

  it('still denies an out-of-scope call over stdio', async () => {
    const token = signer.issue(makeLease({ capabilities: [{ kind: 'fs.read', paths: ['/data/**'] }] }));
    await handshake(token);

    const { isError, text } = await callReadFile('/etc/shadow');

    // Restoring the binding must not cost enforcement: this has to be denied on
    // SCOPE, not for a missing token.
    expect(isError).toBe(true);
    expect(text).toContain('not permitted by the lease scope');
    expect(text).not.toContain('no lease token bound to session');
    expect(downstreamCalls).toBe(0);
  });

  it('denies when the handshake presented no token at all', async () => {
    // Negative control: it must stay green with the binding fix reverted, which
    // proves the two tests above fail because of the binding and not because
    // the harness cannot tell a presented token from an absent one.
    await handshake();

    const { isError, text } = await callReadFile('/data/report.txt');

    // The shared binding key must not become a way to call with no lease.
    expect(isError).toBe(true);
    expect(text).toContain('no lease token bound to session');
    expect(downstreamCalls).toBe(0);
  });
});
