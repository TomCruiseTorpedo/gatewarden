/**
 * An exclusive advisory lock on a file path, for the CLI's state directory.
 *
 * Taken by creating the lock file with O_EXCL; the file records who holds it.
 * Synchronous on purpose: the callers (the spend ledger, behind a synchronous
 * enforcer; the state transaction around a command) cannot await.
 *
 * ABANDONED LOCKS. A holder that crashes leaves its file behind, so a lock is
 * taken over when it is judged abandoned:
 *   - it has not been touched for `staleMs`, whoever holds it; or
 *   - its holder is on THIS host and in THIS pid namespace and is no longer
 *     running.
 * The second rule is only valid where the pid means something. A pid recorded on
 * another host, or in another pid namespace that shares the directory through a
 * volume, looks dead from here whether or not it is; trusting that would steal
 * the lock from a process that is mid-transaction. Those holders expire by age
 * alone. (A holder that is alive but stalled for longer than `staleMs` is also
 * taken over. The critical sections here are milliseconds, so that means a
 * wedged process, and refusing to wait forever is the safer side.)
 *
 * NOT A NETWORK LOCK. Do not put a state directory on a filesystem whose
 * O_EXCL create is not atomic (some NFS configurations).
 *
 * RESIDUAL. Two waiters taking over the same abandoned lock at the same instant
 * can both proceed. That needs a crashed holder AND a simultaneous pair of
 * waiters, and is not closed here.
 */

import {
  closeSync,
  openSync,
  readFileSync,
  readlinkSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';

export interface FileLockOptions {
  /** How long to wait to take the lock. Default 5s. */
  timeoutMs?: number;
  /** A lock untouched for this long is abandoned. Default 10s. */
  staleMs?: number;
}

export class FileLockTimeout extends Error {}

interface LockRecord {
  pid: number;
  host: string;
  pidns: string | null;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_MS = 10_000;

/** The pid namespace this process is in, where the OS exposes one (Linux). */
function ownPidNamespace(): string | null {
  try {
    return readlinkSync('/proc/self/ns/pid');
  } catch {
    return null;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // exists, not ours to signal
  }
}

function readRecord(lockPath: string): LockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<LockRecord> | null;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      Number.isInteger(parsed.pid) &&
      typeof parsed.host === 'string'
    ) {
      return { pid: parsed.pid as number, host: parsed.host, pidns: parsed.pidns ?? null };
    }
  } catch {
    /* empty, partial or foreign content */
  }
  return null;
}

function isAbandoned(lockPath: string, staleMs: number): boolean {
  let ageMs: number;
  try {
    ageMs = Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return false; // vanished between the failed create and now; the caller retries
  }
  if (ageMs >= staleMs) return true;
  const record = readRecord(lockPath);
  // Unparseable or empty: a holder between creating the file and writing its record.
  if (record === null) return false;
  if (record.host !== hostname() || record.pidns !== ownPidNamespace()) return false;
  return !isAlive(record.pid);
}

/**
 * Take the lock, waiting up to `timeoutMs`. Returns a function that releases it
 * (idempotent; removes the file only if it is still this process's).
 *
 * @throws {FileLockTimeout} if the lock could not be taken in time.
 */
export function acquireFileLock(lockPath: string, opts: FileLockOptions = {}): () => void {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const deadline = Date.now() + timeoutMs;
  const me: LockRecord = { pid: process.pid, host: hostname(), pidns: ownPidNamespace() };

  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, JSON.stringify(me));
      closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    if (isAbandoned(lockPath, staleMs)) {
      try {
        unlinkSync(lockPath);
      } catch {
        /* someone else removed it first */
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new FileLockTimeout(`could not take ${lockPath} within ${timeoutMs}ms`);
    }
    sleepSync(10);
  }

  return () => {
    try {
      const held = readRecord(lockPath);
      if (held !== null && held.pid === me.pid && held.host === me.host) unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  };
}
