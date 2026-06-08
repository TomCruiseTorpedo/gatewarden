/**
 * Barrel smoke test — verifies the full public API surface resolves correctly.
 *
 * Imports ONLY from the barrel (`./index.js`). If this file compiles and all
 * assertions pass, the barrel is complete and coherent.
 *
 * Deep behavioural tests live in the sub-module test files:
 *   - src/contract/contract.test.ts
 *   - src/config/config.test.ts
 *   - src/scoring/attach.test.ts
 *   - src/proxy/gateway.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  // Contract — functions
  buildToolActionResolver,
  // Contract — schemas
  GatewayConfigSchema,
  ToolActionMappingSchema,
  DownstreamSpecSchema,
  // Config — functions
  loadConfig,
  ConfigLoadError,
  wireGovern,
  // Scoring — functions
  attachSnapshot,
  rescore,
  // Proxy — class
  GatewardenProxy,
} from './index.js';

// ── Contract exports ──────────────────────────────────────────────────────

describe('barrel smoke — contract', () => {
  it('exports buildToolActionResolver as a function', () => {
    expect(typeof buildToolActionResolver).toBe('function');
  });

  it('exports GatewayConfigSchema as a zod schema', () => {
    expect(typeof GatewayConfigSchema.safeParse).toBe('function');
  });

  it('exports ToolActionMappingSchema as a zod schema', () => {
    expect(typeof ToolActionMappingSchema.safeParse).toBe('function');
  });

  it('exports DownstreamSpecSchema as a zod schema', () => {
    expect(typeof DownstreamSpecSchema.safeParse).toBe('function');
  });

  it('resolver from barrel works end-to-end', () => {
    const resolver = buildToolActionResolver([
      { toolName: 'read_file', kind: 'fs.read', pathArg: 'path' },
    ]);
    expect(resolver('read_file', { path: '/etc/hosts' })).toEqual({
      kind: 'fs.read',
      path: '/etc/hosts',
    });
    expect(resolver('unlisted_tool', {})).toBeUndefined();
  });
});

// ── Config exports ────────────────────────────────────────────────────────

describe('barrel smoke — config', () => {
  it('exports loadConfig as a function', () => {
    expect(typeof loadConfig).toBe('function');
  });

  it('exports ConfigLoadError as a class', () => {
    expect(typeof ConfigLoadError).toBe('function');
    const err = new ConfigLoadError('FILE_NOT_FOUND', 'missing.json');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('FILE_NOT_FOUND');
  });

  it('exports wireGovern as a function', () => {
    expect(typeof wireGovern).toBe('function');
  });
});

// ── Scoring exports ───────────────────────────────────────────────────────

describe('barrel smoke — scoring', () => {
  it('exports attachSnapshot as a function', () => {
    expect(typeof attachSnapshot).toBe('function');
  });

  it('exports rescore as a function', () => {
    expect(typeof rescore).toBe('function');
  });
});

// ── Proxy exports ─────────────────────────────────────────────────────────

describe('barrel smoke — proxy', () => {
  it('exports GatewardenProxy as a class constructor', () => {
    expect(typeof GatewardenProxy).toBe('function');
    // Prototype check confirms it's a class, not a plain function
    expect(typeof GatewardenProxy.prototype.attach).toBe('function');
    expect(typeof GatewardenProxy.prototype.getSnapshot).toBe('function');
    expect(typeof GatewardenProxy.prototype.rescore).toBe('function');
  });
});
