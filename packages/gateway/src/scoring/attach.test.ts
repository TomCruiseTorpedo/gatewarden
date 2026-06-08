/**
 * Unit tests for packages/gateway/src/scoring/attach.ts
 *
 * Acceptance criteria (gateway-003):
 *   1. Deterministic snapshot with eval-only axes null (R2)
 *   2. Two rescore calls return distinct frozen objects (R3)
 *   3. No API key required (lint-only path, no LLM calls)
 *   4. tsc = 0, vitest green
 *
 * Test strategy: mock Client — no live MCP server, no network, no API keys.
 */

import { describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { attachSnapshot, rescore } from './index.js';

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

/**
 * Minimal mock of the MCP SDK `Client` interface.
 * Satisfies `introspect()`'s usage: getServerVersion, getServerCapabilities,
 * listTools, listResources, listPrompts.
 */
function makeMockClient(overrides: Partial<{
  name: string;
  version: string;
  tools: Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  }>;
}> = {}): Client {
  const {
    name = 'test-server',
    version = '1.0.0',
    tools = [
      {
        name: 'fs_read_file',
        description:
          'Read the contents of a file at the given path and return a string. Returns an error object on failure.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path of the file to read.' },
          },
          required: ['path'],
        },
      },
      {
        name: 'fs_write_file',
        description:
          'Write data to a file at the given path, creating it if necessary. Returns an error object on failure.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path of the file to write.' },
            content: { type: 'string', description: 'UTF-8 content to write.' },
          },
          required: ['path', 'content'],
        },
      },
    ],
  } = overrides;

  return {
    getServerVersion: () => ({ name, version }),
    getServerCapabilities: () => ({ tools: {} }),
    listTools: async () => ({ tools }),
    listResources: async () => ({ resources: [] }),
    listPrompts: async () => ({ prompts: [] }),
  } as unknown as Client;
}

// ---------------------------------------------------------------------------
// Acceptance tests
// ---------------------------------------------------------------------------

describe('attachSnapshot', () => {
  it('returns a snapshot with correct server metadata', async () => {
    const client = makeMockClient();
    const snapshot = await attachSnapshot(client);

    expect(snapshot.server.name).toBe('test-server');
    expect(snapshot.server.version).toBe('1.0.0');
    expect(snapshot.server.transport).toBe('stdio'); // default transport kind
  });

  it('attachedAt is a valid ISO 8601 timestamp', async () => {
    const client = makeMockClient();
    const snapshot = await attachSnapshot(client);

    expect(typeof snapshot.attachedAt).toBe('string');
    // ISO 8601: parsing must not produce NaN
    expect(Number.isNaN(new Date(snapshot.attachedAt).getTime())).toBe(false);
  });

  it('snapshot is frozen (top-level immutability, R3)', async () => {
    const client = makeMockClient();
    const snapshot = await attachSnapshot(client);

    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('server sub-object is frozen', async () => {
    const client = makeMockClient();
    const snapshot = await attachSnapshot(client);

    expect(Object.isFrozen(snapshot.server)).toBe(true);
  });

  it('scorecard sub-object is frozen', async () => {
    const client = makeMockClient();
    const snapshot = await attachSnapshot(client);

    expect(Object.isFrozen(snapshot.scorecard)).toBe(true);
  });

  // ─── R2: eval-only axes must carry null scores in lint-only mode ──────────

  it('eval-only axes have null scores (R2 — no API key, no LLM)', async () => {
    const client = makeMockClient();
    const snapshot = await attachSnapshot(client);
    const { axes } = snapshot.scorecard;

    // These three axes are NOT in DETERMINISTIC_AXES — lint cannot grade them.
    // scoreLintOnly must pass through the null scores from lint().
    expect(axes['tool-selection-confusion'].score).toBeNull();
    expect(axes['output-leanness'].score).toBeNull();
    expect(axes['error-helpfulness'].score).toBeNull();
  });

  it('deterministic axes have numeric scores', async () => {
    const client = makeMockClient();
    const snapshot = await attachSnapshot(client);
    const { axes } = snapshot.scorecard;

    // namespacing and param-strictness are assessed by static lint.
    expect(typeof axes['namespacing'].score).toBe('number');
    expect(typeof axes['param-strictness'].score).toBe('number');
  });

  it('scorecard has a numeric lintScore aggregate', async () => {
    const client = makeMockClient();
    const snapshot = await attachSnapshot(client);

    expect(typeof snapshot.scorecard.aggregate.lintScore).toBe('number');
    expect(snapshot.scorecard.aggregate.lintScore).toBeGreaterThanOrEqual(1);
    expect(snapshot.scorecard.aggregate.lintScore).toBeLessThanOrEqual(10);
  });

  it('evalScore is absent (no LLM eval ran — R2)', async () => {
    const client = makeMockClient();
    const snapshot = await attachSnapshot(client);

    // evalScore should not be present in a lint-only scorecard.
    expect(snapshot.scorecard.aggregate.evalScore).toBeUndefined();
  });

  it('accepts explicit transportKind option', async () => {
    const client = makeMockClient();
    const snapshot = await attachSnapshot(client, { transportKind: 'sse' });

    // The transport kind is threaded through introspect() to ServerMeta.
    expect(snapshot.server.transport).toBe('sse');
  });

  it('result is deterministic: two calls with the same tools produce equal scorecard', async () => {
    const client = makeMockClient();
    const snap1 = await attachSnapshot(client);
    const snap2 = await attachSnapshot(client);

    // Values must be identical (same tools → same lint → same score).
    expect(snap1.scorecard.aggregate.lintScore).toBe(snap2.scorecard.aggregate.lintScore);
    expect(snap1.scorecard.axes['namespacing'].score).toBe(
      snap2.scorecard.axes['namespacing'].score
    );
  });
});

// ---------------------------------------------------------------------------
// rescore — R3: distinct frozen objects
// ---------------------------------------------------------------------------

describe('rescore', () => {
  it('returns a GatewaySnapshot with the same structure as attachSnapshot', async () => {
    const client = makeMockClient();
    const snapshot = await rescore(client);

    expect(snapshot.server).toBeDefined();
    expect(snapshot.scorecard).toBeDefined();
    expect(typeof snapshot.attachedAt).toBe('string');
  });

  it('two rescore calls return distinct object references (R3 — no mutation)', async () => {
    const client = makeMockClient();
    const snap1 = await rescore(client);
    const snap2 = await rescore(client);

    // Must be different objects — rescore never returns the same reference.
    expect(snap1).not.toBe(snap2);
    expect(snap1.server).not.toBe(snap2.server);
    expect(snap1.scorecard).not.toBe(snap2.scorecard);
  });

  it('both rescored snapshots are frozen (R3)', async () => {
    const client = makeMockClient();
    const snap1 = await rescore(client);
    const snap2 = await rescore(client);

    expect(Object.isFrozen(snap1)).toBe(true);
    expect(Object.isFrozen(snap2)).toBe(true);
  });

  it('eval-only axes null on rescore (R2)', async () => {
    const client = makeMockClient();
    const snapshot = await rescore(client);
    const { axes } = snapshot.scorecard;

    expect(axes['tool-selection-confusion'].score).toBeNull();
    expect(axes['output-leanness'].score).toBeNull();
    expect(axes['error-helpfulness'].score).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// No API key guard — smoke test
// ---------------------------------------------------------------------------

describe('no API key required', () => {
  it('completes successfully without any API key env vars', async () => {
    // Remove all known API key variables from the environment.
    const savedAnthropicKey = process.env['ANTHROPIC_API_KEY'];
    const savedOpenAiKey = process.env['OPENAI_API_KEY'];
    try {
      delete process.env['ANTHROPIC_API_KEY'];
      delete process.env['OPENAI_API_KEY'];

      const client = makeMockClient();
      const snapshot = await attachSnapshot(client);

      // If we get here without throwing, no API key was needed.
      expect(snapshot).toBeDefined();
      expect(snapshot.scorecard.aggregate.evalScore).toBeUndefined();
    } finally {
      // Restore env — don't pollute other tests.
      if (savedAnthropicKey !== undefined) {
        process.env['ANTHROPIC_API_KEY'] = savedAnthropicKey;
      }
      if (savedOpenAiKey !== undefined) {
        process.env['OPENAI_API_KEY'] = savedOpenAiKey;
      }
    }
  });
});
