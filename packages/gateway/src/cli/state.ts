/**
 * Gateway CLI state management — file-backed persistence for govern stores.
 *
 * Mirrors the file layout of the govern CLI state but uses the public
 * `@gatewarden/govern` API only (no internal imports).
 *
 * Default state directory: `.gatewarden/` relative to cwd.
 * Override with --state-dir or GATEWARDEN_STATE_DIR env var.
 */

import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuditEvent, AuditIntegrity, LeaseRequest, PolicyRule } from '@gatewarden/govern';
import {
  InMemoryAuditSink,
  InMemoryPendingStore,
  InMemoryRevocationList,
  InMemorySpendLedger,
  generateKeyPair,
  keyPairFromSeed,
  parseStoredAuditJsonl,
} from '@gatewarden/govern';
import type { KeyPair } from '@gatewarden/govern';
import { acquireFileLock, FileLockTimeout } from './file-lock.js';
import type { FileLockHandle, FileLockOptions } from './file-lock.js';
import { SharedSpendLedger } from './shared-spend-ledger.js';

// ---------------------------------------------------------------------------
// State directory resolution
// ---------------------------------------------------------------------------

export function resolveStateDir(override?: string): string {
  return (
    override ??
    process.env['GATEWARDEN_STATE_DIR'] ??
    join(process.cwd(), '.gatewarden')
  );
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Key persistence
// ---------------------------------------------------------------------------

interface StoredKeys {
  kid: string;
  secretKeyHex: string;
  publicKeyHex: string;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Create `target` with `data` only if it does not exist yet; never replace one.
 * The data is written to a temp file first (so nobody reads a half-written file)
 * and installed with a hard link, which fails if the target exists.
 *
 * @returns `true` if this call installed the file, `false` if one was already there.
 */
export function publishExclusively(target: string, data: string, mode: number): boolean {
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode });
  try {
    linkSync(tmp, target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  } finally {
    unlinkSync(tmp);
  }
}

export function loadOrCreateKeyPair(stateDir: string): KeyPair {
  ensureDir(stateDir);
  const keysPath = join(stateDir, 'keys.json');
  const readKeys = (): KeyPair => {
    const stored = JSON.parse(readFileSync(keysPath, 'utf8')) as StoredKeys;
    return keyPairFromSeed(hexToBytes(stored.secretKeyHex), stored.kid);
  };
  if (existsSync(keysPath)) return readKeys();

  const kp = generateKeyPair('k1');
  const stored: StoredKeys = {
    kid: kp.kid,
    secretKeyHex: bytesToHex(kp.secretKey),
    publicKeyHex: bytesToHex(kp.publicKey),
  };
  // Two first runs can both see no key. Install it exclusively so exactly one key is ever
  // published and the loser adopts it: a lease signed with a key that lost the race would
  // never verify.
  if (!publishExclusively(keysPath, JSON.stringify(stored, null, 2), 0o600)) return readKeys();
  return kp;
}

// ---------------------------------------------------------------------------
// Policy rules persistence
// ---------------------------------------------------------------------------

export function loadPolicyRules(stateDir: string, rulesFilePath?: string): PolicyRule[] {
  const path = rulesFilePath ?? join(stateDir, 'policy.json');
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PolicyRule[];
  } catch {
    return [];
  }
}

export function savePolicyRules(stateDir: string, rules: PolicyRule[]): void {
  ensureDir(stateDir);
  writeFileAtomic(join(stateDir, 'policy.json'), JSON.stringify(rules, null, 2));
}

// ---------------------------------------------------------------------------
// Pending store persistence
// ---------------------------------------------------------------------------

interface StoredPending {
  [reqId: string]: LeaseRequest;
}

export function loadPendingStore(stateDir: string): InMemoryPendingStore {
  const store = new InMemoryPendingStore();
  const path = join(stateDir, 'pending.json');
  if (!existsSync(path)) return store;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as StoredPending;
    for (const [reqId, request] of Object.entries(data)) {
      store.put(reqId, request);
    }
  } catch {
    // Corrupted state — start fresh
  }
  return store;
}

export function savePendingStore(stateDir: string, store: InMemoryPendingStore): void {
  ensureDir(stateDir);
  const data: StoredPending = {};
  for (const { reqId, request } of store.list()) {
    data[reqId] = request;
  }
  writeFileAtomic(join(stateDir, 'pending.json'), JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Audit sink persistence (JSONL)
// ---------------------------------------------------------------------------

export interface AuditSinkLoadResult {
  sink: InMemoryAuditSink;
  /** Verdict against the STORED hash chain, judged at load time. */
  integrity: AuditIntegrity;
}

/**
 * Load audit.jsonl verbatim and verify the STORED hash chain.
 *
 * Events are loaded exactly as persisted (`loadVerbatim`), never replayed
 * through `append()`: appending recomputes `prevHash`/`hash`, which would
 * re-chain a tampered file into a "valid" log and launder the evidence. A
 * tampered log is still loaded (the operator must be able to inspect it); the
 * verdict gates `saveState()` and the serving commands instead.
 */
export function loadAuditSink(stateDir: string): AuditSinkLoadResult {
  const sink = new InMemoryAuditSink();
  const path = join(stateDir, 'audit.jsonl');
  if (!existsSync(path)) return { sink, integrity: 'intact' };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // Unreadable evidence is indistinguishable from tampering: fail closed.
    return { sink, integrity: 'tampered' };
  }
  const { events, integrity } = parseStoredAuditJsonl(raw);
  sink.loadVerbatim(events);
  return { sink, integrity };
}

export function saveAuditSink(stateDir: string, sink: InMemoryAuditSink): void {
  ensureDir(stateDir);
  const events = sink.read();
  const jsonl = events.map((e) => JSON.stringify(e)).join('\n');
  writeFileAtomic(join(stateDir, 'audit.jsonl'), jsonl ? jsonl + '\n' : '');
}

// ---------------------------------------------------------------------------
// Revocation list persistence
// ---------------------------------------------------------------------------

export function loadRevocationList(stateDir: string): InMemoryRevocationList {
  const list = new InMemoryRevocationList();
  const path = join(stateDir, 'revoked.json');
  if (!existsSync(path)) return list;
  try {
    const ids = JSON.parse(readFileSync(path, 'utf8')) as string[];
    for (const id of ids) {
      list.revoke(id);
    }
  } catch {
    // Corrupted — start fresh
  }
  return list;
}

export function saveRevocationList(stateDir: string, list: InMemoryRevocationList): void {
  ensureDir(stateDir);
  // Access the internal Set via cast — we own InMemoryRevocationList.
  const internal = list as unknown as { revoked: Set<string> };
  const ids = Array.from(internal.revoked);
  writeFileAtomic(join(stateDir, 'revoked.json'), JSON.stringify(ids, null, 2));
}

// ---------------------------------------------------------------------------
// Spend ledger persistence
// ---------------------------------------------------------------------------

interface StoredSpend {
  [leaseId: string]: { spent: number; cap: number };
}

export function loadSpendLedger(stateDir: string): InMemorySpendLedger {
  const ledger = new InMemorySpendLedger();
  const path = join(stateDir, 'spend.json');
  if (!existsSync(path)) return ledger;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as StoredSpend;
    for (const [leaseId, entry] of Object.entries(data)) {
      ledger.setCap(leaseId, entry.cap);
      const internal = ledger as unknown as {
        ledger: Map<string, { spent: number; cap: number }>;
      };
      const stored = internal.ledger.get(leaseId);
      if (stored !== undefined && entry.spent > 0) {
        stored.spent = entry.spent;
      }
    }
  } catch {
    // Corrupted — start fresh
  }
  return ledger;
}

// ---------------------------------------------------------------------------
// Combined state bundle
// ---------------------------------------------------------------------------

/** Thrown when persisting state would overwrite tamper evidence in audit.jsonl. */
export class AuditTamperError extends Error {}

export interface CliState {
  stateDir: string;
  keyPair: KeyPair;
  auditSink: InMemoryAuditSink;
  /** Stored-chain verdict for audit.jsonl at load time. */
  auditIntegrity: AuditIntegrity;
  pendingStore: InMemoryPendingStore;
  revocationList: InMemoryRevocationList;
  spendLedger: InMemorySpendLedger;
}

export function loadState(stateDir: string): CliState {
  ensureDir(stateDir);
  const { sink, integrity } = loadAuditSink(stateDir);
  if (integrity === 'tampered') {
    console.error(
      `WARNING: audit log at ${join(stateDir, 'audit.jsonl')} fails stored hash-chain verification — possible tampering. ` +
        'Commands that persist state will refuse to run so the evidence is preserved. ' +
        'Inspect it with `gatewarden audit`, then archive the file manually before resuming.',
    );
  }
  return {
    stateDir,
    keyPair: loadOrCreateKeyPair(stateDir),
    auditSink: sink,
    auditIntegrity: integrity,
    pendingStore: loadPendingStore(stateDir),
    revocationList: loadRevocationList(stateDir),
    spendLedger: loadSpendLedger(stateDir),
  };
}

/**
 * Persist the state a short-lived command changed.
 *
 * `spend.json` is deliberately NOT written here. No short-lived command charges
 * spend, so its in-memory ledger is only the snapshot it loaded; writing that
 * back would erase any spend a running gateway recorded in between, and with it
 * the cap. `SharedSpendLedger` is the one writer of `spend.json`.
 */
export function saveState(state: CliState): void {
  if (state.auditIntegrity === 'tampered') {
    throw new AuditTamperError(
      `refusing to save state: audit log at ${join(state.stateDir, 'audit.jsonl')} fails stored hash-chain verification. ` +
        'Overwriting it would destroy the tamper evidence. No state files were written. ' +
        'Archive the audit log manually (e.g. move it aside) to resume with a fresh chain.',
    );
  }
  // Commit point: if this transaction no longer holds the lock, another command may have changed the
  // state since this one loaded it. Writing now would erase that change, so write nothing.
  if (currentTransaction !== undefined && !currentTransaction.isHeld()) {
    throw new LockLostError(
      `refusing to save state: the lock on ${state.stateDir} was lost while this command was running, ` +
        'so another command may have changed it. No state files were written; retry the command.',
    );
  }
  // Order matters because a crash can land between files. Enforcement state goes first and the
  // audit log last: "revoked in force, not yet in the log" fails safe, while "revoked in the log,
  // still valid" is false assurance.
  saveRevocationList(state.stateDir, state.revocationList);
  savePendingStore(state.stateDir, state.pendingStore);
  saveAuditSink(state.stateDir, state.auditSink);
}

// ---------------------------------------------------------------------------
// Serve session
// ---------------------------------------------------------------------------

/** Replace `target` atomically, so a reader never sees a half-written file. */
function writeFileAtomic(target: string, data: string): void {
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, target);
}

/**
 * A revocation list that reads `revoked.json` through on every check.
 *
 * A gateway is long-lived and `revoke` is a separate process, so a list loaded
 * once at startup cannot see a lease revoked while the proxy is up: the
 * revocation would not apply until a restart. This one folds the file in before
 * each answer.
 *
 * Ids are only ever added. Revocation is monotone, so a file that goes missing,
 * is truncated, or fails to parse mid-session leaves what was already learned in
 * force instead of quietly un-revoking it.
 */
export class DiskBackedRevocationList extends InMemoryRevocationList {
  constructor(private readonly path: string) {
    super();
    this.refresh();
  }

  override isRevoked(leaseId: string): boolean {
    this.refresh();
    return super.isRevoked(leaseId);
  }

  private refresh(): void {
    let ids: unknown;
    try {
      ids = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      return; // absent or unreadable: keep what is already known
    }
    if (!Array.isArray(ids)) return;
    for (const id of ids) {
      if (typeof id === 'string') super.revoke(id);
    }
  }
}

/**
 * Keep events a session could not merge into the log, in a file beside it.
 *
 * A session that cannot save (the state lock is held, or the log on disk fails verification) must
 * not simply lose its events. They are NOT merged into audit.jsonl: it cannot be locked, or cannot
 * be trusted, right now. Each spill is its own exclusively created file and is reported on stderr.
 */
function spillUnsavedEvents(stateDir: string, events: AuditEvent[]): void {
  const path = join(stateDir, `audit.unsaved.${process.pid}.${Date.now()}.jsonl`);
  try {
    publishExclusively(path, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 0o600);
    process.stderr.write(`gatewarden: ${events.length} audit event(s) could not be saved to the log and were kept in ${path}\n`);
  } catch (err) {
    process.stderr.write(`gatewarden: ${events.length} audit event(s) could not be saved and could not be kept: ${(err as Error).message}\n`);
  }
}

export interface ServeSession {
  /** State to wire the proxy from. Its revocation list reads through to disk. */
  state: CliState;
  /**
   * Persist what this session changed: its audit events, merged onto the log
   * as it is on disk now. Idempotent. Throws {@link AuditTamperError}, writing
   * nothing, if the audit log on disk fails stored-chain verification. Spend is
   * not saved here: it is written through to `spend.json` as it is charged.
   */
  save(): void;
}

/**
 * Open the state directory for a long-running `serve` / `a2a-serve` process.
 *
 * `loadState` + `saveState` is right for a command that runs and exits. It is
 * wrong for a gateway: the process holds its load-time snapshot for hours while
 * `request` and `revoke` change the directory under it, and `saveState` at
 * shutdown rewrites every file from that stale snapshot. A lease revoked
 * mid-session came back to life, and the audit events other processes wrote
 * (including the revocation record) were dropped.
 *
 * So a session owns only what it changes. Its audit events are merged onto the
 * log at shutdown. Spend cannot wait for shutdown: concurrent gateways must
 * share one cap, so every charge goes through `SharedSpendLedger`, which checks
 * and records it under a lock against `spend.json` as it is now. It never
 * mutates revocations or pending requests, and never writes those files. If a
 * gateway ever starts changing something else, persist it here with merge
 * semantics, not by rewriting the file from a snapshot.
 */
export function openServeSession(
  stateDir: string,
  opts: { lockTimeoutMs?: number } = {},
): ServeSession {
  const state = loadState(stateDir);
  state.revocationList = new DiskBackedRevocationList(join(stateDir, 'revoked.json'));
  // Not the snapshot loadState read: every charge goes to spend.json under a lock,
  // checked against what is on disk now, so concurrent gateways share one cap.
  state.spendLedger = new SharedSpendLedger(stateDir);

  // Events present at load are already on disk. Everything after is this session's.
  let persistedEvents = state.auditSink.readVerbatim().length;

  return {
    state,
    save(): void {
      // ── audit ───────────────────────────────────────────────────────────
      const mine = state.auditSink.readVerbatim().slice(persistedEvents);
      if (mine.length > 0) {
        try {
          // The read-merge-write below must not interleave with a command that is
          // mid-transaction, or one of the two would overwrite the other's events.
          const lock = acquireFileLock(stateLockPath(stateDir), {
            timeoutMs: opts.lockTimeoutMs ?? STATE_LOCK_TIMEOUT_MS,
          });
          try {
            // Re-read the log as it is NOW, verified, and append onto its tail. The
            // chain is recomputed only for the session's own new events, after the
            // stored chain has been checked; a tampered log is never re-chained.
            const { sink, integrity } = loadAuditSink(stateDir);
            if (integrity === 'tampered') {
              throw new AuditTamperError(
                `refusing to save session: audit log at ${join(stateDir, 'audit.jsonl')} fails stored hash-chain verification. ` +
                  'Overwriting it would destroy the tamper evidence. Nothing was written.',
              );
            }
            for (const event of mine) sink.append({ ...event, prevHash: '', hash: '' });
            writeFileAtomic(
              join(stateDir, 'audit.jsonl'),
              sink
                .read()
                .map((e) => JSON.stringify(e))
                .join('\n') + '\n',
            );
            persistedEvents = state.auditSink.readVerbatim().length;
          } finally {
            lock.release();
          }
        } catch (err) {
          // Do not lose the evidence: keep what could not be merged next to the log.
          spillUnsavedEvents(stateDir, mine);
          throw err;
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// State transaction lock
// ---------------------------------------------------------------------------

/** How long a command waits for another to finish with the state directory. */
const STATE_LOCK_TIMEOUT_MS = 10_000;

/** Thrown by `saveState` when the transaction it belongs to no longer holds the state lock. */
export class LockLostError extends Error {}

/**
 * The state-lock handle of the transaction running in this process, if any. `saveState` is the
 * commit point of every command, so it checks this before writing: a transaction that has lost
 * its lock may be holding a snapshot another command has since changed, and committing it would
 * erase that change.
 */
let currentTransaction: FileLockHandle | undefined;

function stateLockPath(stateDir: string): string {
  return join(stateDir, 'state.lock');
}

/** Turn a lock timeout into something an operator can act on. */
function explainLockTimeout(err: unknown, stateDir: string, waitedMs: number): unknown {
  if (err instanceof FileLockTimeout) {
    return new Error(
      `another command is using the state directory ${stateDir}: waited ${waitedMs}ms for ${stateLockPath(stateDir)}. ` +
        'Retry; if no gatewarden process is running, the lock is left over and can be removed.',
    );
  }
  return err;
}

/**
 * Run `fn` as one transaction on the state directory.
 *
 * `saveState` rewrites every state file from the snapshot its command loaded. Two
 * short commands running at once therefore each saved a stale snapshot over the
 * other's change: with 12 `revoke` and 12 `request` launched together, about half
 * the revocations and about 37 of 84 audit events were lost, and the audit chain
 * still verified because each surviving file was internally consistent. So a
 * command that changes state must load, change and save INSIDE this lock, and the
 * commands queue instead of overwriting each other.
 *
 * It is a lock around the whole command, not around `saveState`: a lock only at
 * save time would still let both commands load the same snapshot.
 *
 * Read-only commands do not need it (writes replace files atomically, so a reader
 * sees a whole old file or a whole new one). A long-running gateway never holds
 * it: it takes it only for the brief merge in `ServeSession.save`.
 */
export async function withStateLock<T>(
  stateDir: string,
  fn: () => T | Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  ensureDir(stateDir);
  const timeoutMs = opts.timeoutMs ?? STATE_LOCK_TIMEOUT_MS;
  let lock: FileLockHandle;
  try {
    lock = acquireFileLock(stateLockPath(stateDir), { ...opts, timeoutMs });
  } catch (err) {
    throw explainLockTimeout(err, stateDir, timeoutMs);
  }
  // process.exit() inside fn skips the finally below; 'exit' handlers still run, and releasing is synchronous.
  process.once('exit', lock.release);
  const outer = currentTransaction;
  currentTransaction = lock;
  try {
    return await fn();
  } finally {
    currentTransaction = outer;
    process.removeListener('exit', lock.release);
    lock.release();
  }
}
