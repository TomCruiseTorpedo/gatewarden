/**
 * `serve` / `a2a-serve` session persistence tests.
 *
 * A long-running gateway loads the state directory once and shares it with
 * short-lived commands (`request`, `revoke`) that run as separate processes
 * while it is up. Saving the whole of its load-time view back over the
 * directory at shutdown rewrites every file from a stale snapshot: a lease
 * revoked mid-session is un-revoked, and audit events other processes wrote are
 * dropped, including the revocation record itself.
 *
 * Each `loadState(dir)` below is a separate load from disk, standing in for a
 * separate OS process. Same contract as the govern CLI's serve session.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AuditTamperError,
  loadState,
  openServeSession,
  savePolicyRules,
  saveState,
} from './state.js';
import { wireComponents } from './wire.js';
import { cmdRevoke } from './commands/revoke.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gw-serve-session-'));
  savePolicyRules(dir, [
    { ruleId: 'allow-data-reads', effect: 'allow', capabilityKind: 'fs.read', paths: ['/data/**'] },
  ]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const READ = { kind: 'fs.read' as const, path: '/data/a.txt' };

/** Mint a lease the way `request` does: load, issue, save. */
async function mint(): Promise<{ token: string; leaseId: string }> {
  const state = loadState(dir);
  const { broker } = wireComponents(state);
  const result = await broker.request({
    agentId: 'agent',
    taskId: 'task',
    capabilities: [{ kind: 'fs.read', paths: ['/data/**'] }],
    requestedDurationMs: 60_000,
  });
  if (result.type !== 'granted') throw new Error(`could not mint: ${JSON.stringify(result)}`);
  saveState(state);
  return { token: result.token, leaseId: result.lease.id };
}

/** Revoke the way `revoke` does, as another process. */
function revokeElsewhere(leaseId: string): void {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  cmdRevoke(loadState(dir), { leaseId });
}

function mark(state: ReturnType<typeof loadState>, from: string): void {
  state.auditSink.append({
    type: 'denial',
    at: new Date().toISOString(),
    detail: { from },
    prevHash: '',
    hash: '',
  });
}

function revokedOnDisk(): string[] {
  const path = join(dir, 'revoked.json');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as string[]) : [];
}

function auditFroms(): Array<string | undefined> {
  return readFileSync(join(dir, 'audit.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { detail: { from?: string } }).detail.from)
    .filter((f) => f !== undefined);
}

describe('serve session', () => {
  it('a revocation recorded by another process mid-session survives the session save', async () => {
    const { leaseId } = await mint();
    const session = openServeSession(dir);

    revokeElsewhere(leaseId);
    expect(revokedOnDisk()).toContain(leaseId); // control: the revoke reached disk

    session.save();

    expect(revokedOnDisk()).toContain(leaseId);
    expect(loadState(dir).revocationList.isRevoked(leaseId)).toBe(true);
  });

  it('the session enforcer refuses a lease revoked after the session began', async () => {
    const { token, leaseId } = await mint();
    const session = openServeSession(dir);
    const { enforcer } = wireComponents(session.state);

    expect(enforcer.check(token, READ).ok).toBe(true); // control: valid before the revoke

    revokeElsewhere(leaseId);

    const after = enforcer.check(token, READ);
    expect(after.ok).toBe(false);
    expect(after.reason).toContain('revoked');
  });

  it('keeps audit events other processes wrote and appends its own, chain intact', async () => {
    await mint();
    const session = openServeSession(dir);

    mark(session.state, 'session');
    const other = loadState(dir);
    mark(other, 'other');
    saveState(other);

    session.save();

    expect(loadState(dir).auditIntegrity).toBe('intact');
    expect(auditFroms()).toEqual(expect.arrayContaining(['other', 'session']));
  });

  it('saving twice does not duplicate the session events', async () => {
    await mint();
    const session = openServeSession(dir);
    mark(session.state, 'session');

    session.save();
    session.save();

    expect(auditFroms().filter((f) => f === 'session')).toHaveLength(1);
  });

  it('refuses to overwrite an audit log that was tampered with after the session began', async () => {
    await mint();
    const session = openServeSession(dir);
    mark(session.state, 'session');

    const path = join(dir, 'audit.jsonl');
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    const first = JSON.parse(lines[0]!) as { detail: Record<string, unknown> };
    first.detail = { ...first.detail, tampered: true };
    lines[0] = JSON.stringify(first);
    const tampered = lines.join('\n') + '\n';
    writeFileSync(path, tampered);

    expect(() => session.save()).toThrow(AuditTamperError);
    expect(readFileSync(path, 'utf8')).toBe(tampered);
  });

  it('does not rewrite files the session never changes', async () => {
    await mint();
    const session = openServeSession(dir);
    mark(session.state, 'session');

    const owned = ['revoked.json', 'pending.json', 'spend.json'];
    for (const f of owned) writeFileSync(join(dir, f), `{"written-by":"another-process","file":"${f}"}`);
    const before = owned.map((f) => readFileSync(join(dir, f), 'utf8'));

    session.save();

    expect(owned.map((f) => readFileSync(join(dir, f), 'utf8'))).toEqual(before);
  });
});

describe('spend across gateway processes', () => {
  const SPEND = { kind: 'spend' as const, currency: 'CAD', amountMinor: 60 };

  /** Mint a lease capped at 100 minor units, the way `request` does. */
  async function mintSpend(): Promise<string> {
    savePolicyRules(dir, [
      { ruleId: 'allow-spend', effect: 'allow', capabilityKind: 'spend', currency: 'CAD' },
    ]);
    const state = loadState(dir);
    const { broker } = wireComponents(state);
    const result = await broker.request({
      agentId: 'agent',
      taskId: 'task',
      capabilities: [{ kind: 'spend', currency: 'CAD', capMinor: 100 }],
      requestedDurationMs: 60_000,
    });
    if (result.type !== 'granted') throw new Error(`could not mint: ${JSON.stringify(result)}`);
    saveState(state);
    return result.token;
  }

  it('two concurrent sessions share one cap', async () => {
    const token = await mintSpend();
    const a = openServeSession(dir);
    const b = openServeSession(dir);

    expect(wireComponents(a.state).enforcer.check(token, SPEND).ok).toBe(true); // 60 of 100
    const second = wireComponents(b.state).enforcer.check(token, SPEND); // 120 of 100

    expect(second.ok).toBe(false);
    expect(second.reason).toContain('spend cap exceeded');
  });

  it('records spend as it happens, before any shutdown save', async () => {
    const token = await mintSpend();
    const a = openServeSession(dir);

    wireComponents(a.state).enforcer.check(token, SPEND);

    const onDisk = JSON.parse(readFileSync(join(dir, 'spend.json'), 'utf8')) as Record<string, { spent: number }>;
    expect(Object.values(onDisk).map((e) => e.spent)).toEqual([60]);
  });

  it('a short-lived command saving a stale snapshot does not erase spend recorded meanwhile', async () => {
    const token = await mintSpend();
    const staleCommand = loadState(dir); // e.g. `revoke`, loaded before the spend below
    const a = openServeSession(dir);
    wireComponents(a.state).enforcer.check(token, SPEND);

    saveState(staleCommand); // ...and saved after it

    const onDisk = JSON.parse(readFileSync(join(dir, 'spend.json'), 'utf8')) as Record<string, { spent: number }>;
    expect(Object.values(onDisk).map((e) => e.spent)).toEqual([60]);
  });
});
