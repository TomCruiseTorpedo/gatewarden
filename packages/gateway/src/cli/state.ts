/**
 * Gateway CLI state management — file-backed persistence for govern stores.
 *
 * Mirrors the file layout of the govern CLI state but uses the public
 * `@gatewarden/govern` API only (no internal imports).
 *
 * Default state directory: `.gatewarden/` relative to cwd.
 * Override with --state-dir or GATEWARDEN_STATE_DIR env var.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

export function loadOrCreateKeyPair(stateDir: string): KeyPair {
  ensureDir(stateDir);
  const keysPath = join(stateDir, 'keys.json');
  if (existsSync(keysPath)) {
    const stored = JSON.parse(readFileSync(keysPath, 'utf8')) as StoredKeys;
    const secretKey = hexToBytes(stored.secretKeyHex);
    return keyPairFromSeed(secretKey, stored.kid);
  }
  const kp = generateKeyPair('k1');
  const stored: StoredKeys = {
    kid: kp.kid,
    secretKeyHex: bytesToHex(kp.secretKey),
    publicKeyHex: bytesToHex(kp.publicKey),
  };
  writeFileSync(keysPath, JSON.stringify(stored, null, 2));
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
  writeFileSync(join(stateDir, 'policy.json'), JSON.stringify(rules, null, 2));
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
  writeFileSync(join(stateDir, 'pending.json'), JSON.stringify(data, null, 2));
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
  writeFileSync(join(stateDir, 'audit.jsonl'), jsonl ? jsonl + '\n' : '');
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
  writeFileSync(join(stateDir, 'revoked.json'), JSON.stringify(ids, null, 2));
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
  saveAuditSink(state.stateDir, state.auditSink);
  savePendingStore(state.stateDir, state.pendingStore);
  saveRevocationList(state.stateDir, state.revocationList);
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
export function openServeSession(stateDir: string): ServeSession {
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
      }
    },
  };
}
