/**
 * CLI state-load integrity tests (stored chain).
 *
 * Regression guard for the evidence-laundering bug. loadAuditSink() used to
 * replay persisted events through InMemoryAuditSink.append(), which recomputes
 * `prevHash`/`hash`: a tampered audit.jsonl re-verified clean against its own
 * fresh chain, `gatewarden audit --verify` reported it intact, and the next
 * saveState() wrote the laundered chain back over the evidence. Loading must be
 * verbatim, verification must be against the STORED hashes, and a tampered file
 * must never be overwritten.
 *
 * Same contract as the govern CLI state (see govern/src/cli/state.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditTamperError, loadState, saveState, savePolicyRules } from './state.js';
import { cmdAudit } from './commands/audit.js';
import { wireComponents } from './wire.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'state-integrity-'));
  savePolicyRules(dir, [
    { ruleId: 'allow-data-reads', effect: 'allow', capabilityKind: 'fs.read', paths: ['/data/**'] },
  ]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Write a few real, hash-chained events to audit.jsonl by issuing a lease. */
async function writeIntactLog(): Promise<void> {
  const state = loadState(dir);
  const { broker } = wireComponents(state);
  const result = await broker.request({
    agentId: 'agent',
    taskId: 'task',
    capabilities: [{ kind: 'fs.read', paths: ['/data/**'] }],
    requestedDurationMs: 60_000,
  });
  if (result.type !== 'granted') throw new Error('could not mint');
  saveState(state);
}

/** Edit the content of the first stored event without touching its hashes. */
function tamperFirstEvent(): string {
  const path = join(dir, 'audit.jsonl');
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const first = JSON.parse(lines[0]!) as { detail: Record<string, unknown> };
  first.detail = { ...first.detail, tampered: true };
  lines[0] = JSON.stringify(first);
  const text = lines.join('\n') + '\n';
  writeFileSync(path, text);
  return text;
}

describe('loadState on the stored audit chain', () => {
  it('an intact log loads as intact', async () => {
    await writeIntactLog();
    expect(loadState(dir).auditIntegrity).toBe('intact');
  });

  it('a missing log is intact and empty, not tampered', () => {
    const state = loadState(dir);
    expect(state.auditIntegrity).toBe('intact');
    expect(state.auditSink.readVerbatim()).toHaveLength(0);
  });

  it('an edited event loads as tampered, and is shown as stored rather than re-chained', async () => {
    await writeIntactLog();
    tamperFirstEvent();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const state = loadState(dir);

    expect(state.auditIntegrity).toBe('tampered');
    expect((state.auditSink.readVerbatim()[0]?.detail as { tampered?: boolean }).tampered).toBe(true);
    // Verification runs against the stored hashes, so the sink itself refuses to vouch for it.
    expect(() => state.auditSink.read()).toThrow(/tampered/i);
  });

  it('warns on stderr when the stored chain fails verification', async () => {
    await writeIntactLog();
    tamperFirstEvent();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    loadState(dir);

    expect(err.mock.calls.flat().join(' ')).toMatch(/hash-chain verification/i);
  });
});

describe('saveState on a tampered log', () => {
  it('throws AuditTamperError and leaves the evidence byte-for-byte', async () => {
    await writeIntactLog();
    const tampered = tamperFirstEvent();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = loadState(dir);

    expect(() => saveState(state)).toThrow(AuditTamperError);
    expect(readFileSync(join(dir, 'audit.jsonl'), 'utf8')).toBe(tampered);
  });
});

describe('cmdAudit', () => {
  function exitSpy() {
    return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
  }

  it('--verify passes on an intact log', async () => {
    await writeIntactLog();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    exitSpy();

    cmdAudit(loadState(dir), { verify: true });

    expect(log.mock.calls.flat().join(' ')).toContain('"ok":true');
  });

  it('--verify fails with exit code 1 on a tampered log', async () => {
    await writeIntactLog();
    tamperFirstEvent();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy();

    expect(() => cmdAudit(loadState(dir), { verify: true })).toThrow('exit:1');
  });

  it('still prints a tampered log, because it is the evidence', async () => {
    await writeIntactLog();
    tamperFirstEvent();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    cmdAudit(loadState(dir), {});

    expect(log.mock.calls.flat().join(' ')).toContain('"tampered": true');
  });
});
