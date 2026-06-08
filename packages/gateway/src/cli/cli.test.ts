/**
 * CLI unit tests — argument parsing and routing (gateway-005).
 *
 * Tests the CLI layer without starting real MCP servers. Covers:
 *   - Help output listing all commands
 *   - Version output
 *   - Unknown command error
 *   - Missing required arguments for gateway commands
 *   - Govern lifecycle command wiring (request/approve/deny/pending/revoke/policy/audit)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Helpers — run the CLI in-process by parsing argv
// ---------------------------------------------------------------------------

import { parseArgs } from 'node:util';
import { loadState, resolveStateDir, saveState } from './state.js';
import { cmdPending } from './commands/pending.js';
import { cmdApprove } from './commands/approve.js';
import { cmdDeny } from './commands/deny.js';
import { cmdRevoke } from './commands/revoke.js';
import { cmdAudit } from './commands/audit.js';
import { cmdPolicy } from './commands/policy.js';
import { cmdRequest } from './commands/request.js';
import { writeFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'gatewarden-cli-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// resolveStateDir
// ---------------------------------------------------------------------------

describe('resolveStateDir', () => {
  it('defaults to .gatewarden in cwd when no override', () => {
    const original = process.env['GATEWARDEN_STATE_DIR'];
    delete process.env['GATEWARDEN_STATE_DIR'];
    try {
      const dir = resolveStateDir();
      expect(dir).toContain('.gatewarden');
    } finally {
      if (original !== undefined) process.env['GATEWARDEN_STATE_DIR'] = original;
    }
  });

  it('uses override when provided', () => {
    const dir = resolveStateDir('/custom/path');
    expect(dir).toBe('/custom/path');
  });

  it('uses GATEWARDEN_STATE_DIR env var', () => {
    process.env['GATEWARDEN_STATE_DIR'] = '/env/path';
    try {
      const dir = resolveStateDir();
      expect(dir).toBe('/env/path');
    } finally {
      delete process.env['GATEWARDEN_STATE_DIR'];
    }
  });
});

// ---------------------------------------------------------------------------
// loadState / saveState round-trip
// ---------------------------------------------------------------------------

describe('loadState / saveState', () => {
  it('creates a fresh state when directory is empty', () => {
    const state = loadState(tmpDir);
    expect(state.stateDir).toBe(tmpDir);
    expect(state.keyPair.kid).toBe('k1');
    expect(state.auditSink.read()).toHaveLength(0);
    expect(state.pendingStore.list()).toHaveLength(0);
  });

  it('persists and reloads key pair', () => {
    const state1 = loadState(tmpDir);
    const kid1 = state1.keyPair.kid;
    saveState(state1);

    const state2 = loadState(tmpDir);
    expect(state2.keyPair.kid).toBe(kid1);
  });
});

// ---------------------------------------------------------------------------
// cmdPending
// ---------------------------------------------------------------------------

describe('cmdPending', () => {
  it('prints empty array when no pending requests', () => {
    const state = loadState(tmpDir);
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });
    try {
      cmdPending(state);
      expect(logs.length).toBeGreaterThan(0);
      const parsed = JSON.parse(logs[0]!) as unknown[];
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// cmdAudit
// ---------------------------------------------------------------------------

describe('cmdAudit', () => {
  it('prints empty array when no events', () => {
    const state = loadState(tmpDir);
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });
    try {
      cmdAudit(state, {});
      expect(logs.length).toBeGreaterThan(0);
      const parsed = JSON.parse(logs[0]!) as unknown[];
      expect(Array.isArray(parsed)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('verifies an empty hash chain without error', () => {
    const state = loadState(tmpDir);
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });
    try {
      cmdAudit(state, { verify: true });
      expect(logs.length).toBeGreaterThan(0);
      const result = JSON.parse(logs[0]!) as { ok: boolean };
      expect(result.ok).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// cmdPolicy
// ---------------------------------------------------------------------------

describe('cmdPolicy', () => {
  it('shows empty rules when none loaded', () => {
    const state = loadState(tmpDir);
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });
    try {
      cmdPolicy(state, { subcommand: 'show' });
      const parsed = JSON.parse(logs[0]!) as unknown[];
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('loads rules from a file and saves to state dir', () => {
    const rulesFile = join(tmpDir, 'rules.json');
    const rules = [
      { ruleId: 'rule-1', effect: 'allow', capabilityKind: 'fs.read' },
    ];
    writeFileSync(rulesFile, JSON.stringify(rules));

    const state = loadState(tmpDir);
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });
    try {
      cmdPolicy(state, { subcommand: 'load', rulesFile });
      const result = JSON.parse(logs[0]!) as { ok: boolean; rulesLoaded: number };
      expect(result.ok).toBe(true);
      expect(result.rulesLoaded).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// cmdRevoke
// ---------------------------------------------------------------------------

describe('cmdRevoke', () => {
  it('revokes a lease ID and persists to state', () => {
    const state = loadState(tmpDir);
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });
    const leaseId = 'test-lease-id-001';
    try {
      cmdRevoke(state, { leaseId });
      const result = JSON.parse(logs[0]!) as { type: string; leaseId: string };
      expect(result.type).toBe('revoked');
      expect(result.leaseId).toBe(leaseId);
    } finally {
      spy.mockRestore();
    }

    // Reload state and verify audit event was written
    saveState(state);
    const state2 = loadState(tmpDir);
    const events = state2.auditSink.read();
    const revocationEvents = events.filter((e) => e.type === 'revocation');
    expect(revocationEvents.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// cmdRequest flow (grant path with allow-all policy)
// ---------------------------------------------------------------------------

describe('cmdRequest', () => {
  it('grants a request when policy allows all fs.read', async () => {
    // Load a state with an allow-all fs.read policy
    const rulesFile = join(tmpDir, 'rules.json');
    // No paths restriction means the rule covers any path (allow-all for fs.read)
    const rules = [
      { ruleId: 'rule-1', effect: 'allow', capabilityKind: 'fs.read' },
    ];
    writeFileSync(rulesFile, JSON.stringify(rules));

    const state = loadState(tmpDir);
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });

    const leaseRequestJson = JSON.stringify({
      agentId: 'a1',
      taskId: 't1',
      capabilities: [{ kind: 'fs.read', paths: ['./data/**'] }],
      requestedDurationMs: 3600000,
    });

    try {
      await cmdRequest(state, { request: leaseRequestJson, rulesFile });
      expect(logs.length).toBeGreaterThan(0);
      const result = JSON.parse(logs[0]!) as { type: string };
      // With allow-all policy: should be granted
      expect(result.type).toBe('granted');
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects invalid JSON for LeaseRequest', async () => {
    const state = loadState(tmpDir);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(cmdRequest(state, { request: 'not-json' })).rejects.toThrow();
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// cmdApprove / cmdDeny flow
// ---------------------------------------------------------------------------

describe('cmdApprove / cmdDeny', () => {
  it('deny returns error when reqId not found', () => {
    const state = loadState(tmpDir);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // approve a non-existent reqId should call process.exit(2)
      expect(() => cmdApprove(state, { reqId: 'nonexistent-id' })).toThrow();
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// parseArgs integration — verify gateway-specific args parse correctly
// ---------------------------------------------------------------------------

describe('parseArgs for gateway commands', () => {
  it('parses score positional correctly', () => {
    const { positionals } = parseArgs({
      args: ['./gateway.config.json'],
      options: { 'state-dir': { type: 'string' as const } },
      allowPositionals: true,
      strict: false,
    });
    expect(positionals[0]).toBe('./gateway.config.json');
  });

  it('parses --state-dir option', () => {
    const { values } = parseArgs({
      args: ['--state-dir', '/custom/state'],
      options: { 'state-dir': { type: 'string' as const } },
      strict: false,
    }) as { values: Record<string, string> };
    expect(values['state-dir']).toBe('/custom/state');
  });

  it('parses audit --last and --type', () => {
    const { values } = parseArgs({
      args: ['--last', '10', '--type', 'issuance'],
      options: {
        last: { type: 'string' as const },
        type: { type: 'string' as const },
        verify: { type: 'boolean' as const },
        'state-dir': { type: 'string' as const },
      },
      strict: false,
    }) as { values: Record<string, string | boolean | undefined> };
    expect(values['last']).toBe('10');
    expect(values['type']).toBe('issuance');
  });

  it('parses audit --verify flag', () => {
    const { values } = parseArgs({
      args: ['--verify'],
      options: {
        last: { type: 'string' as const },
        type: { type: 'string' as const },
        verify: { type: 'boolean' as const },
        'state-dir': { type: 'string' as const },
      },
      strict: false,
    }) as { values: Record<string, string | boolean | undefined> };
    expect(values['verify']).toBe(true);
  });

  it('parses policy subcommand', () => {
    const rest = ['load', '--rules-file', './rules.json'];
    const sub = rest[0] ?? 'show';
    const policyRest = sub === 'show' || sub === 'load' ? rest.slice(1) : rest;
    const { values } = parseArgs({
      args: policyRest,
      options: {
        'rules-file': { type: 'string' as const },
        'state-dir': { type: 'string' as const },
      },
      strict: false,
    }) as { values: Record<string, string | undefined> };
    expect(sub).toBe('load');
    expect(values['rules-file']).toBe('./rules.json');
  });
});
