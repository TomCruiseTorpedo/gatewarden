/**
 * Contract test suite — types, schemas, and buildToolActionResolver.
 *
 * Covers:
 *   - GatewayConfigSchema: accepts valid single-downstream configs
 *   - GatewayConfigSchema: rejects multi-downstream (R9) + malformed mappings
 *   - buildToolActionResolver: fs.read / fs.write / http.call / spend mapping
 *   - buildToolActionResolver: unmapped passthrough (R5)
 *   - buildToolActionResolver: missing args → Action (not undefined, R6)
 */

import { describe, it, expect } from 'vitest';
import { GatewayConfigSchema, ToolActionMappingSchema } from './schemas.js';
import { buildToolActionResolver } from './resolver.js';
import type { ToolActionMapping } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const validStdioConfig = {
  downstream: { transport: 'stdio' as const, command: 'node', args: ['server.js'] },
  policy: [],
  toolActions: [],
};

// ---------------------------------------------------------------------------
// GatewayConfigSchema
// ---------------------------------------------------------------------------

describe('GatewayConfigSchema', () => {
  describe('accepts valid configs', () => {
    it('parses a minimal stdio config', () => {
      const result = GatewayConfigSchema.safeParse(validStdioConfig);
      expect(result.success).toBe(true);
    });

    it('parses an SSE downstream config', () => {
      const result = GatewayConfigSchema.safeParse({
        downstream: { transport: 'sse', url: 'http://localhost:8080/sse' },
        policy: [],
        toolActions: [],
      });
      expect(result.success).toBe(true);
    });

    it('parses an HTTP downstream config', () => {
      const result = GatewayConfigSchema.safeParse({
        downstream: { transport: 'http', url: 'http://localhost:8080/mcp' },
        policy: [],
        toolActions: [],
      });
      expect(result.success).toBe(true);
    });

    it('defaults policy and toolActions to empty arrays', () => {
      const result = GatewayConfigSchema.safeParse({
        downstream: { transport: 'stdio', command: 'server' },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.policy).toEqual([]);
        expect(result.data.toolActions).toEqual([]);
      }
    });

    it('parses fs.read toolAction mapping', () => {
      const result = GatewayConfigSchema.safeParse({
        ...validStdioConfig,
        toolActions: [{ toolName: 'read_file', kind: 'fs.read', pathArg: 'path' }],
      });
      expect(result.success).toBe(true);
    });

    it('parses fs.write toolAction mapping', () => {
      const result = GatewayConfigSchema.safeParse({
        ...validStdioConfig,
        toolActions: [{ toolName: 'write_file', kind: 'fs.write', pathArg: 'path' }],
      });
      expect(result.success).toBe(true);
    });

    it('parses http.call toolAction mapping', () => {
      const result = GatewayConfigSchema.safeParse({
        ...validStdioConfig,
        toolActions: [{ toolName: 'fetch_url', kind: 'http.call', endpointArg: 'url' }],
      });
      expect(result.success).toBe(true);
    });

    it('parses spend toolAction mapping', () => {
      const result = GatewayConfigSchema.safeParse({
        ...validStdioConfig,
        toolActions: [
          { toolName: 'charge', kind: 'spend', currencyArg: 'currency', amountArg: 'amount' },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('parses optional scoring config', () => {
      const result = GatewayConfigSchema.safeParse({
        ...validStdioConfig,
        scoring: { eval: true },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('rejects invalid configs (R9)', () => {
    it('rejects when downstream is an array (multi-downstream)', () => {
      const result = GatewayConfigSchema.safeParse({
        downstream: [
          { transport: 'stdio', command: 'server1' },
          { transport: 'stdio', command: 'server2' },
        ],
        policy: [],
        toolActions: [],
      });
      expect(result.success).toBe(false);
    });

    it('rejects when downstream is missing', () => {
      const result = GatewayConfigSchema.safeParse({ policy: [], toolActions: [] });
      expect(result.success).toBe(false);
    });

    it('rejects unknown transport type', () => {
      const result = GatewayConfigSchema.safeParse({
        downstream: { transport: 'websocket', url: 'ws://localhost' },
        policy: [],
        toolActions: [],
      });
      expect(result.success).toBe(false);
    });

    it('rejects stdio without command', () => {
      const result = GatewayConfigSchema.safeParse({
        downstream: { transport: 'stdio' },
        policy: [],
        toolActions: [],
      });
      expect(result.success).toBe(false);
    });

    it('rejects sse/http with invalid URL', () => {
      const result = GatewayConfigSchema.safeParse({
        downstream: { transport: 'sse', url: 'not-a-url' },
        policy: [],
        toolActions: [],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('rejects malformed toolAction mappings', () => {
    it('rejects fs.read mapping missing pathArg', () => {
      const result = ToolActionMappingSchema.safeParse({
        toolName: 'read_file',
        kind: 'fs.read',
        // pathArg missing
      });
      expect(result.success).toBe(false);
    });

    it('rejects fs.write mapping with empty pathArg', () => {
      const result = ToolActionMappingSchema.safeParse({
        toolName: 'write_file',
        kind: 'fs.write',
        pathArg: '',
      });
      expect(result.success).toBe(false);
    });

    it('rejects http.call mapping missing endpointArg', () => {
      const result = ToolActionMappingSchema.safeParse({
        toolName: 'fetch_url',
        kind: 'http.call',
      });
      expect(result.success).toBe(false);
    });

    it('rejects spend mapping missing currencyArg', () => {
      const result = ToolActionMappingSchema.safeParse({
        toolName: 'charge',
        kind: 'spend',
        amountArg: 'amount',
        // currencyArg missing
      });
      expect(result.success).toBe(false);
    });

    it('rejects spend mapping missing amountArg', () => {
      const result = ToolActionMappingSchema.safeParse({
        toolName: 'charge',
        kind: 'spend',
        currencyArg: 'currency',
        // amountArg missing
      });
      expect(result.success).toBe(false);
    });

    it('rejects mapping with unknown kind', () => {
      const result = ToolActionMappingSchema.safeParse({
        toolName: 'some_tool',
        kind: 'db.query',
      });
      expect(result.success).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// buildToolActionResolver
// ---------------------------------------------------------------------------

describe('buildToolActionResolver', () => {
  describe('fs.read mapping', () => {
    const mappings: ToolActionMapping[] = [
      { toolName: 'read_file', kind: 'fs.read', pathArg: 'path' },
    ];
    const resolver = buildToolActionResolver(mappings);

    it('resolves read_file with a path arg to an fs.read Action', () => {
      const action = resolver('read_file', { path: '/home/user/doc.txt' });
      expect(action).toEqual({ kind: 'fs.read', path: '/home/user/doc.txt' });
    });

    it('returns Action (not undefined) when path arg is missing (R6)', () => {
      const action = resolver('read_file', {});
      expect(action).not.toBeUndefined();
      expect(action?.kind).toBe('fs.read');
      // The sentinel path must not be an empty string or anything realistic
      expect(action?.kind === 'fs.read' && action.path.length).toBeGreaterThan(0);
    });

    it('returns Action with sentinel when path arg has wrong type (R6)', () => {
      const action = resolver('read_file', { path: 42 });
      expect(action).not.toBeUndefined();
      expect(action?.kind).toBe('fs.read');
    });
  });

  describe('fs.write mapping', () => {
    const mappings: ToolActionMapping[] = [
      { toolName: 'write_file', kind: 'fs.write', pathArg: 'file_path' },
    ];
    const resolver = buildToolActionResolver(mappings);

    it('resolves write_file to an fs.write Action', () => {
      const action = resolver('write_file', { file_path: '/tmp/output.txt' });
      expect(action).toEqual({ kind: 'fs.write', path: '/tmp/output.txt' });
    });

    it('returns Action (not undefined) when pathArg is missing (R6)', () => {
      const action = resolver('write_file', {});
      expect(action).not.toBeUndefined();
      expect(action?.kind).toBe('fs.write');
    });
  });

  describe('http.call mapping', () => {
    const mappings: ToolActionMapping[] = [
      { toolName: 'fetch_url', kind: 'http.call', endpointArg: 'url' },
    ];
    const resolver = buildToolActionResolver(mappings);

    it('resolves fetch_url to an http.call Action', () => {
      const action = resolver('fetch_url', { url: 'https://api.example.com/data' });
      expect(action).toEqual({ kind: 'http.call', endpoint: 'https://api.example.com/data' });
    });

    it('returns Action (not undefined) when endpointArg is missing (R6)', () => {
      const action = resolver('fetch_url', {});
      expect(action).not.toBeUndefined();
      expect(action?.kind).toBe('http.call');
    });
  });

  describe('spend mapping', () => {
    const mappings: ToolActionMapping[] = [
      { toolName: 'charge', kind: 'spend', currencyArg: 'currency', amountArg: 'amount' },
    ];
    const resolver = buildToolActionResolver(mappings);

    it('resolves charge to a spend Action', () => {
      const action = resolver('charge', { currency: 'USD', amount: 500 });
      expect(action).toEqual({ kind: 'spend', currency: 'USD', amountMinor: 500 });
    });

    it('rounds float amounts to integers', () => {
      const action = resolver('charge', { currency: 'USD', amount: 9.99 });
      expect(action?.kind === 'spend' && Number.isInteger(action.amountMinor)).toBe(true);
    });

    it('returns Action (not undefined) when currency arg is missing (R6)', () => {
      const action = resolver('charge', { amount: 100 });
      expect(action).not.toBeUndefined();
      expect(action?.kind).toBe('spend');
    });

    it('returns Action (not undefined) when amount arg is missing (R6)', () => {
      const action = resolver('charge', { currency: 'USD' });
      expect(action).not.toBeUndefined();
      expect(action?.kind).toBe('spend');
      // Sentinel amount is MAX_SAFE_INTEGER — will always exceed any real spend cap
      expect(action?.kind === 'spend' && action.amountMinor).toBe(Number.MAX_SAFE_INTEGER);
    });
  });

  describe('unmapped passthrough (R5)', () => {
    const mappings: ToolActionMapping[] = [
      { toolName: 'read_file', kind: 'fs.read', pathArg: 'path' },
    ];
    const resolver = buildToolActionResolver(mappings);

    it('returns undefined for unmapped tools', () => {
      const action = resolver('list_tools', { anything: 'irrelevant' });
      expect(action).toBeUndefined();
    });

    it('returns undefined for empty tool name not in mappings', () => {
      const action = resolver('get_server_info', {});
      expect(action).toBeUndefined();
    });
  });

  describe('multiple mappings', () => {
    const mappings: ToolActionMapping[] = [
      { toolName: 'read_file', kind: 'fs.read', pathArg: 'path' },
      { toolName: 'write_file', kind: 'fs.write', pathArg: 'path' },
      { toolName: 'fetch_url', kind: 'http.call', endpointArg: 'url' },
      { toolName: 'charge', kind: 'spend', currencyArg: 'currency', amountArg: 'amount' },
    ];
    const resolver = buildToolActionResolver(mappings);

    it('resolves each mapped tool correctly', () => {
      expect(resolver('read_file', { path: '/a' })).toEqual({ kind: 'fs.read', path: '/a' });
      expect(resolver('write_file', { path: '/b' })).toEqual({ kind: 'fs.write', path: '/b' });
      expect(resolver('fetch_url', { url: 'https://x.com' })).toEqual({
        kind: 'http.call',
        endpoint: 'https://x.com',
      });
      expect(resolver('charge', { currency: 'USD', amount: 100 })).toEqual({
        kind: 'spend',
        currency: 'USD',
        amountMinor: 100,
      });
    });

    it('returns undefined for a tool not in the mapping', () => {
      expect(resolver('list_resources', {})).toBeUndefined();
    });
  });

  describe('empty mapping', () => {
    it('returns undefined for any tool when mapping is empty', () => {
      const resolver = buildToolActionResolver([]);
      expect(resolver('read_file', { path: '/a' })).toBeUndefined();
      expect(resolver('anything', {})).toBeUndefined();
    });
  });
});
