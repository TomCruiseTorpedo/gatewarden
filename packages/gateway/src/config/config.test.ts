/**
 * Tests for the config module: loader + govern wiring.
 *
 * Coverage:
 *   - loadConfig: valid JSON, invalid JSON, schema errors, R9 (multi-downstream)
 *   - wireGovern: real signed lease DENIES out-of-scope (R4), ALLOWS in-scope (R4),
 *                 audit sink receives events (R7)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadConfig, ConfigLoadError, wireGovern } from './index.js';
import type { GatewayConfig } from '../contract/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid stdio-based GatewayConfig for testing. */
const VALID_CONFIG: GatewayConfig = {
  downstream: {
    transport: 'stdio',
    command: 'node',
    args: ['server.js'],
  },
  policy: [
    {
      ruleId: 'allow-read-allowed',
      effect: 'allow',
      capabilityKind: 'fs.read',
      paths: ['/allowed/**'],
    },
  ],
  toolActions: [
    { toolName: 'read_file', kind: 'fs.read', pathArg: 'path' },
  ],
};

/** Config with only passthrough tools and a broad allow-policy (no fs constraints). */
function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return { ...VALID_CONFIG, ...overrides };
}

let tmpDir: string;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tmpDir = join(tmpdir(), `gw-config-test-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });
});

// ---------------------------------------------------------------------------
// loadConfig tests
// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  it('loads and validates a valid JSON config', async () => {
    const p = join(tmpDir, 'valid.json');
    await writeFile(p, JSON.stringify(VALID_CONFIG), 'utf8');

    const cfg = await loadConfig(p);
    expect(cfg.downstream).toEqual(VALID_CONFIG.downstream);
    expect(cfg.policy).toHaveLength(1);
    expect(cfg.toolActions).toHaveLength(1);
  });

  it('throws NOT_FOUND for a missing file', async () => {
    await expect(loadConfig(join(tmpDir, 'nonexistent.json'))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('throws PARSE_ERROR for malformed JSON', async () => {
    const p = join(tmpDir, 'bad.json');
    await writeFile(p, '{ not json }', 'utf8');

    await expect(loadConfig(p)).rejects.toMatchObject({ code: 'PARSE_ERROR' });
  });

  it('throws INVALID_CONFIG when required fields are missing', async () => {
    const p = join(tmpDir, 'missing.json');
    await writeFile(p, JSON.stringify({ policy: [] }), 'utf8');

    await expect(loadConfig(p)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('throws INVALID_CONFIG for an unknown downstream transport', async () => {
    const p = join(tmpDir, 'bad-transport.json');
    const bad = { ...VALID_CONFIG, downstream: { transport: 'websocket', url: 'ws://x' } };
    await writeFile(p, JSON.stringify(bad), 'utf8');

    await expect(loadConfig(p)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('R9: rejects a config where downstream is an array (multi-downstream)', async () => {
    const p = join(tmpDir, 'multi.json');
    // Forcefully pass an array — the schema rejects it as "Expected object, received array"
    const bad = {
      ...VALID_CONFIG,
      downstream: [VALID_CONFIG.downstream, VALID_CONFIG.downstream],
    };
    await writeFile(p, JSON.stringify(bad), 'utf8');

    const err = await loadConfig(p).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect((err as ConfigLoadError).code).toBe('INVALID_CONFIG');
  });

  it('defaults policy and toolActions to empty arrays when omitted', async () => {
    const p = join(tmpDir, 'minimal.json');
    await writeFile(
      p,
      JSON.stringify({ downstream: VALID_CONFIG.downstream }),
      'utf8',
    );

    const cfg = await loadConfig(p);
    expect(cfg.policy).toEqual([]);
    expect(cfg.toolActions).toEqual([]);
  });

  it('throws UNSUPPORTED_FORMAT for an unknown extension', async () => {
    const p = join(tmpDir, 'config.yaml');
    await writeFile(p, 'downstream: {}', 'utf8');

    await expect(loadConfig(p)).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
  });
});

// ---------------------------------------------------------------------------
// wireGovern tests
// ---------------------------------------------------------------------------

describe('wireGovern', () => {
  it('returns a bundle with all expected properties', () => {
    const bundle = wireGovern(VALID_CONFIG);
    expect(bundle.signer).toBeDefined();
    expect(bundle.policy).toBeDefined();
    expect(bundle.audit).toBeDefined();
    expect(bundle.revocationList).toBeDefined();
    expect(bundle.spendLedger).toBeDefined();
    expect(bundle.pendingStore).toBeDefined();
    expect(bundle.broker).toBeDefined();
    expect(bundle.enforcer).toBeDefined();
    expect(bundle.resolver).toBeDefined();
    expect(typeof bundle.resolver).toBe('function');
  });

  it('R4: DENIES a real signed lease for an out-of-scope path', async () => {
    // Config allows only /allowed/** reads
    const cfg = makeConfig({
      policy: [
        {
          ruleId: 'allow-read-allowed',
          effect: 'allow',
          capabilityKind: 'fs.read',
          paths: ['/allowed/**'],
        },
      ],
    });
    const { broker, enforcer } = wireGovern(cfg);

    // Issue a lease restricted to /allowed/**
    const result = await broker.request({
      agentId: 'test-agent',
      taskId: 'task-1',
      capabilities: [{ kind: 'fs.read', paths: ['/allowed/**'] }],
      requestedDurationMs: 60_000,
    });

    expect(result.type).toBe('granted');
    if (result.type !== 'granted') return;

    const token = result.token;

    // In-scope action (should pass)
    const allowResult = enforcer.check(token, {
      kind: 'fs.read',
      path: '/allowed/data.txt',
    });
    expect(allowResult.ok).toBe(true);

    // Out-of-scope action (private path — should be DENIED, R4)
    const denyResult = enforcer.check(token, {
      kind: 'fs.read',
      path: '/private/secret.txt',
    });
    expect(denyResult.ok).toBe(false);
    expect((denyResult as { ok: false; reason: string }).reason).toBeTruthy();
  });

  it('R4: ALLOWS a real signed lease for in-scope path', async () => {
    const cfg = makeConfig({
      policy: [
        {
          ruleId: 'allow-all-reads',
          effect: 'allow',
          capabilityKind: 'fs.read',
          paths: ['**'],
        },
      ],
    });
    const { broker, enforcer } = wireGovern(cfg);

    const result = await broker.request({
      agentId: 'test-agent',
      taskId: 'task-2',
      capabilities: [{ kind: 'fs.read', paths: ['**'] }],
      requestedDurationMs: 60_000,
    });

    expect(result.type).toBe('granted');
    if (result.type !== 'granted') return;

    const checkResult = enforcer.check(result.token, {
      kind: 'fs.read',
      path: '/any/path/whatsoever.txt',
    });
    expect(checkResult.ok).toBe(true);
  });

  it('R7: audit sink receives events after request + check', async () => {
    const cfg = makeConfig({
      policy: [
        {
          ruleId: 'allow-read',
          effect: 'allow',
          capabilityKind: 'fs.read',
          paths: ['/data/**'],
        },
      ],
    });
    const { broker, enforcer, audit } = wireGovern(cfg);

    // No events before anything
    expect(audit.read()).toHaveLength(0);

    // Issue a lease → broker appends request + decision audit events
    const result = await broker.request({
      agentId: 'agent-r7',
      taskId: 'task-r7',
      capabilities: [{ kind: 'fs.read', paths: ['/data/**'] }],
      requestedDurationMs: 30_000,
    });

    expect(result.type).toBe('granted');

    const eventsAfterIssue = audit.read();
    // Broker emits: request + decision + issuance = at least 2-3 events
    expect(eventsAfterIssue.length).toBeGreaterThanOrEqual(2);

    // Verify event types include at least a 'request' and a 'grant'
    const types = eventsAfterIssue.map((e) => e.type);
    expect(types).toContain('request');
    expect(types.some((t) => t === 'issuance' || t === 'decision')).toBe(true);
  });

  it('R9: wireGovern works with empty policy (deny-by-default)', async () => {
    const cfg = makeConfig({ policy: [] });
    const { broker, enforcer } = wireGovern(cfg);

    // Request should be DENIED (no matching allow-rule)
    const result = await broker.request({
      agentId: 'agent-denied',
      taskId: 'task-denied',
      capabilities: [{ kind: 'fs.read', paths: ['**'] }],
      requestedDurationMs: 60_000,
    });

    expect(result.type).toBe('denied');
  });

  it('resolver maps configured tool names to Actions', () => {
    const cfg = makeConfig({
      toolActions: [
        { toolName: 'read_file', kind: 'fs.read', pathArg: 'path' },
        { toolName: 'write_file', kind: 'fs.write', pathArg: 'path' },
      ],
    });
    const { resolver } = wireGovern(cfg);

    expect(resolver('read_file', { path: '/etc/hosts' })).toEqual({
      kind: 'fs.read',
      path: '/etc/hosts',
    });
    expect(resolver('write_file', { path: '/tmp/out.txt' })).toEqual({
      kind: 'fs.write',
      path: '/tmp/out.txt',
    });
    // Unmapped tool → undefined (passthrough)
    expect(resolver('unlisted_tool', {})).toBeUndefined();
  });
});
