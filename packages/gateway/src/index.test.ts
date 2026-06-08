/**
 * Barrel smoke test — verifies the public API surface resolves correctly.
 *
 * Replaces the scaffold placeholder (re-home smoke). The real contract tests
 * live in src/contract/contract.test.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  buildToolActionResolver,
  GatewayConfigSchema,
  ToolActionMappingSchema,
  DownstreamSpecSchema,
} from './index.js';

describe('barrel smoke', () => {
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
