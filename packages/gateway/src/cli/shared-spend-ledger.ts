/**
 * SharedSpendLedger — one spend cap, enforced across every gateway process that
 * shares a state directory.
 *
 * WHY. `InMemorySpendLedger` is a per-process snapshot. Stdio `serve` is spawned
 * once per MCP client, so several gateways normally run against one state
 * directory at the same time. Each loaded `spend.json` at startup and charged
 * against its own copy, so each could spend the full cap, and merging the
 * increases back at shutdown only recorded the sum: two gateways against a cap
 * of 100 ended with `spent: 200`.
 *
 * HOW. Every operation is one transaction under a lock file: take the lock,
 * read `spend.json` as it is now, check the cap against THAT, write the result
 * back atomically, release. Spend is on disk the moment it is charged, so there
 * is nothing left to merge at shutdown and a crashed gateway loses nothing.
 * Readers (`spent`) take no lock; the file is replaced by rename, so they see a
 * whole old version or a whole new one.
 *
 * FAILS CLOSED. If the lock cannot be taken in time, `accrue` refuses the charge
 * rather than spending without the check; an unreadable or malformed
 * `spend.json` throws rather than being read as zero spend. (The CLI's
 * `loadSpendLedger` starts fresh on corruption, which forgives spend; a ledger
 * that enforces a cap must not.)
 *
 * The on-disk format is the one `loadSpendLedger` already reads:
 * `{ [leaseId]: { spent, cap } }`.
 *
 * RESERVATIONS ARE REFUSED. `reserve`/`settle`/`release` hold headroom in one
 * process's memory, so two gateways could each hold the full cap — the same bug
 * through a different door. Nothing in the gateway calls them today (it charges
 * immediately via `check`), so rather than leave a silent per-process trap for
 * the day it adopts `checkAndReserve`, they throw. Supporting holds means
 * persisting them under this lock.
 *
 * THE LOCK (and what it does not cover) is in `file-lock.ts`.
 *
 * INPUT. The amount comes from a tool argument the client chose, so it is not
 * trusted: a negative charge would be a refund (it lowers recorded spend and
 * reopens the headroom the cap exists to close). Charges must be non-negative
 * safe integers; anything else is refused. The same holds for the file: negative,
 * fractional or non-numeric spend or cap is treated as corruption, not as data.
 * Lease ids are looked up in a prototype-less map, so an id such as
 * `constructor` or `__proto__` can never resolve to an inherited property.
 *
 * It extends `InMemorySpendLedger` only because `LeaseEnforcer` is typed to that
 * class; every method the enforcer uses is overridden and none of the parent's
 * in-memory state is read.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InMemorySpendLedger } from '@gatewarden/govern';
import type { SettleOutcome } from '@gatewarden/govern';
import { acquireFileLock, FileLockTimeout } from './file-lock.js';

interface SpendEntry {
  spent: number;
  cap: number;
}
/** Prototype-less, so no lease id can collide with an inherited property. */
type SpendFile = Record<string, SpendEntry>;

export interface SharedSpendLedgerOptions {
  /** How long to wait for the lock before refusing the charge. Default 5s. */
  lockTimeoutMs?: number;
  /** A lock untouched for this long is abandoned. Default 10s. */
  staleLockMs?: number;
}

const NO_HOLDS =
  'SharedSpendLedger: reservations are not supported across processes. A hold lives in one ' +
  'process\'s memory, so two gateways could each hold the full cap. Charge with check()/accrue(), ' +
  'or persist holds under the lock before using checkAndReserve.';

/** A non-negative integer that can be added without losing precision. */
function isMinorUnits(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

export class SharedSpendLedger extends InMemorySpendLedger {
  private readonly spendPath: string;
  private readonly lockPath: string;
  private readonly lockOpts: { timeoutMs?: number; staleMs?: number };

  constructor(stateDir: string, opts: SharedSpendLedgerOptions = {}) {
    super();
    mkdirSync(stateDir, { recursive: true });
    this.spendPath = join(stateDir, 'spend.json');
    this.lockPath = join(stateDir, 'spend.lock');
    this.lockOpts = {
      ...(opts.lockTimeoutMs !== undefined ? { timeoutMs: opts.lockTimeoutMs } : {}),
      ...(opts.staleLockMs !== undefined ? { staleMs: opts.staleLockMs } : {}),
    };
  }

  /** Register (or update) the cap for a lease. Throws if the lock cannot be taken. */
  override setCap(leaseId: string, capMinor: number): void {
    if (!isMinorUnits(capMinor)) {
      throw new Error(`SpendLedger: cap for lease "${leaseId}" must be a non-negative integer, got ${String(capMinor)}`);
    }
    this.transact((entries) => {
      const existing = entries[leaseId];
      if (existing === undefined) {
        entries[leaseId] = { spent: 0, cap: capMinor };
        return true;
      }
      if (existing.cap === capMinor) return false;
      existing.cap = capMinor;
      return true;
    });
  }

  /**
   * Charge immediately and irreversibly, against the spend on disk now.
   *
   * @returns `true` if within the cap (at the cap is allowed) and recorded;
   *   `false` if it would breach the cap, if the amount is not a non-negative
   *   safe integer, OR if the lock could not be taken in time. Nothing is
   *   recorded in any `false` case.
   * @throws if no cap is registered for the lease, or `spend.json` is unreadable.
   */
  override accrue(leaseId: string, amountMinor: number, _nowMs?: number): boolean {
    // Checked before anything else: a negative amount would LOWER recorded spend.
    if (!isMinorUnits(amountMinor)) return false;

    let allowed = false;
    try {
      this.transact((entries) => {
        const entry = entries[leaseId];
        if (entry === undefined) {
          throw new Error(
            `SpendLedger: no cap registered for lease "${leaseId}". ` +
              `Call setCap(leaseId, capMinor) when the lease is issued.`,
          );
        }
        if (entry.spent + amountMinor > entry.cap) return false;
        entry.spent += amountMinor;
        allowed = true;
        return true;
      });
    } catch (err) {
      if (err instanceof FileLockTimeout) {
        process.stderr.write(`gatewarden: spend ledger busy, charge refused: ${err.message}\n`);
        return false;
      }
      throw err;
    }
    return allowed;
  }

  /** Total settled spend for the lease, as of the file now. 0 for an unknown lease. */
  override spent(leaseId: string): number {
    return this.read()[leaseId]?.spent ?? 0;
  }

  override reserve(
    _leaseId: string,
    _amountMinor: number,
    _nowMs: number,
    _key?: string,
  ): string | undefined {
    throw new Error(NO_HOLDS);
  }

  override settle(_reservationId: string, _nowMs: number): SettleOutcome {
    throw new Error(NO_HOLDS);
  }

  override release(_reservationId: string): boolean {
    throw new Error(NO_HOLDS);
  }

  override reserved(_leaseId: string, _nowMs: number): number {
    throw new Error(NO_HOLDS);
  }

  // -------------------------------------------------------------------------
  // Transaction
  // -------------------------------------------------------------------------

  /** Run `fn` on the file's current contents under the lock; write back if it returns true. */
  private transact(fn: (entries: SpendFile) => boolean): void {
    const release = acquireFileLock(this.lockPath, this.lockOpts);
    try {
      const entries = this.read();
      if (fn(entries)) this.write(entries);
    } finally {
      release();
    }
  }

  private read(): SpendFile {
    const entries: SpendFile = Object.create(null) as SpendFile;
    if (!existsSync(this.spendPath)) return entries;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.spendPath, 'utf8'));
    } catch (err) {
      throw new Error(`SpendLedger: ${this.spendPath} is unreadable (${(err as Error).message}); refusing to treat it as zero spend`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`SpendLedger: ${this.spendPath} is not an object; refusing to treat it as zero spend`);
    }
    for (const [id, e] of Object.entries(parsed)) {
      const entry = e as Partial<SpendEntry> | null;
      if (!isMinorUnits(entry?.spent) || !isMinorUnits(entry?.cap)) {
        throw new Error(`SpendLedger: ${this.spendPath} has a malformed entry for "${id}"; refusing to treat it as zero spend`);
      }
      entries[id] = { spent: entry.spent, cap: entry.cap };
    }
    return entries;
  }

  private write(entries: SpendFile): void {
    const tmp = `${this.spendPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries, null, 2));
    renameSync(tmp, this.spendPath);
  }
}
