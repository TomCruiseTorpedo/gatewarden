import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireFileLock, FileLockTimeout } from './file-lock.js';

let dir: string;
let lock: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
  lock = join(dir, 'x.lock');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('acquireFileLock', () => {
  it('records who holds it, and removes the file on release', () => {
    const release = acquireFileLock(lock);

    const held = JSON.parse(readFileSync(lock, 'utf8')) as { pid: number; host: string };
    expect(held.pid).toBe(process.pid);
    expect(held.host).toBe(hostname());

    release();
    expect(existsSync(lock)).toBe(false);
  });

  it('excludes a second holder until the first releases', () => {
    const release = acquireFileLock(lock);

    expect(() => acquireFileLock(lock, { timeoutMs: 100 })).toThrow(FileLockTimeout);

    release();
    const second = acquireFileLock(lock, { timeoutMs: 100 }); // control: free once released
    second();
  });

  it('release is idempotent', () => {
    const release = acquireFileLock(lock);
    release();
    expect(() => release()).not.toThrow();
  });

  it("release never removes a lock that has since been taken by someone else", () => {
    const releaseMine = acquireFileLock(lock);
    // Mine was judged abandoned and replaced by another process's lock.
    writeFileSync(lock, JSON.stringify({ pid: process.pid + 1, host: hostname(), pidns: null }));

    releaseMine();

    expect(existsSync(lock)).toBe(true);
  });
});
