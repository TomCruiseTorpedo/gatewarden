/**
 * SharedSpendLedger — one spend cap enforced across gateway processes.
 *
 * The stock InMemorySpendLedger is a per-process snapshot. Stdio `serve` is
 * spawned once per MCP client, so several gateways run against one state
 * directory at once. With a snapshot each can spend the full cap, and the
 * shutdown merge then records the sum: two processes against a cap of 100
 * ended with `spent: 200`.
 *
 * Each `new SharedSpendLedger(dir)` below stands in for one OS process: they
 * share nothing in memory, only the state directory.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpendLedger } from './state.js';
import { SharedSpendLedger } from './shared-spend-ledger.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shared-spend-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const spendFile = () => join(dir, 'spend.json');
const lockFile = () => join(dir, 'spend.lock');
const onDisk = (): Record<string, { spent: number; cap: number }> =>
  JSON.parse(readFileSync(spendFile(), 'utf8')) as Record<string, { spent: number; cap: number }>;

/** A pid that is guaranteed not to be alive: a child that has already exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(r.stdout.toString());
}

describe('one cap across processes', () => {
  it('enforces a cap that was spent through a different ledger', () => {
    const a = new SharedSpendLedger(dir);
    const b = new SharedSpendLedger(dir);
    a.setCap('L', 100);
    b.setCap('L', 100); // each gateway registers the cap lazily on its own first check

    expect(a.accrue('L', 60)).toBe(true);
    expect(b.accrue('L', 60)).toBe(false); // would be 120 of 100
    expect(b.accrue('L', 40)).toBe(true); // exactly the cap
    expect(a.accrue('L', 1)).toBe(false);

    expect(onDisk()['L']).toEqual({ spent: 100, cap: 100 });
  });

  it('control: a single ledger enforces the cap the same way', () => {
    const a = new SharedSpendLedger(dir);
    a.setCap('L', 100);
    expect(a.accrue('L', 100)).toBe(true); // at the cap is allowed
    expect(a.accrue('L', 1)).toBe(false);
  });

  it('records spend on disk the moment it is charged, not at shutdown', () => {
    const a = new SharedSpendLedger(dir);
    a.setCap('L', 100);
    a.accrue('L', 30);
    expect(onDisk()['L']?.spent).toBe(30);
  });

  it('registering a cap from a second process neither resets nor duplicates the spend', () => {
    const a = new SharedSpendLedger(dir);
    a.setCap('L', 100);
    a.accrue('L', 30);

    const b = new SharedSpendLedger(dir);
    b.setCap('L', 100);

    expect(b.spent('L')).toBe(30); // read through, not a stale zero
    expect(onDisk()['L']).toEqual({ spent: 30, cap: 100 });
  });

  it('accruing against a lease with no registered cap still throws', () => {
    expect(() => new SharedSpendLedger(dir).accrue('nope', 1)).toThrow(/no cap registered/);
  });

  it('writes the format loadSpendLedger reads, so other tooling still works', () => {
    const a = new SharedSpendLedger(dir);
    a.setCap('L', 100);
    a.accrue('L', 30);
    expect(loadSpendLedger(dir).spent('L')).toBe(30);
  });
});

describe('an unreadable spend.json is refused, never read as zero spend', () => {
  it.each([
    ['not JSON', '{not json'],
    ['not an object', '[1,2,3]'],
    ['a malformed entry', '{"L":{"spent":"lots","cap":100}}'],
  ])('%s', (_name, contents) => {
    const a = new SharedSpendLedger(dir);
    writeFileSync(spendFile(), contents);

    expect(() => a.accrue('L', 1)).toThrow(/refusing to treat it as zero spend/);
    expect(() => a.setCap('L', 100)).toThrow(/refusing to treat it as zero spend/);
    expect(readFileSync(spendFile(), 'utf8')).toBe(contents); // and it is left as found
    expect(existsSync(lockFile())).toBe(false); // the lock is not leaked by the failure
  });
});

describe('reservations are refused rather than silently kept per process', () => {
  it.each([
    ['reserve', (l: SharedSpendLedger) => l.reserve('L', 1, Date.now())],
    ['settle', (l: SharedSpendLedger) => l.settle('L#1', Date.now())],
    ['release', (l: SharedSpendLedger) => l.release('L#1')],
    ['reserved', (l: SharedSpendLedger) => l.reserved('L', Date.now())],
  ])('%s throws', (_name, call) => {
    expect(() => call(new SharedSpendLedger(dir))).toThrow(/not supported across processes/);
  });
});

describe('the cross-process lock', () => {
  it('fails closed while a live process holds it, recording nothing', () => {
    const a = new SharedSpendLedger(dir, { lockTimeoutMs: 150 });
    a.setCap('L', 100);
    writeFileSync(lockFile(), String(process.pid)); // held by a live process (this one)

    expect(a.accrue('L', 10)).toBe(false);
    expect(onDisk()['L']?.spent).toBe(0);

    rmSync(lockFile());
    expect(a.accrue('L', 10)).toBe(true); // control: the same call succeeds once the lock is free
  });

  it('steals a lock left behind by a process that is no longer running', () => {
    const a = new SharedSpendLedger(dir, { lockTimeoutMs: 500 });
    a.setCap('L', 100);
    writeFileSync(lockFile(), String(deadPid()));

    expect(a.accrue('L', 10)).toBe(true);
    expect(onDisk()['L']?.spent).toBe(10);
  });

  it('steals a lock that is held by a live pid but has not been touched for staleLockMs', () => {
    const a = new SharedSpendLedger(dir, { lockTimeoutMs: 500, staleLockMs: 1_000 });
    a.setCap('L', 100);
    writeFileSync(lockFile(), String(process.pid));
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockFile(), old, old);

    expect(a.accrue('L', 10)).toBe(true);
  });

  it('releases the lock after every operation and leaves no temp files', () => {
    const a = new SharedSpendLedger(dir);
    a.setCap('L', 100);
    a.accrue('L', 10);
    a.accrue('L', 1_000); // a refusal also takes and releases the lock

    expect(existsSync(lockFile())).toBe(false);
    expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
  });
});
