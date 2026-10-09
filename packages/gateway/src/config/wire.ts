/**
 * Govern wiring — constructs the full govern runtime from a validated GatewayConfig.
 *
 * Produces a `GovernBundle` containing all the components the proxy layer (gateway-004)
 * needs to enforce capability leases:
 *
 *   - signer          — PasetoV4PublicSigner (Ed25519) for issuing and verifying leases
 *   - policy          — DeclarativePolicyEngine seeded with config.policy rules
 *   - audit           — InMemoryAuditSink (append-only, hash-chained)
 *   - revocationList  — InMemoryRevocationList
 *   - spendLedger     — InMemorySpendLedger
 *   - pendingStore    — InMemoryPendingStore
 *   - broker          — Broker (issuance orchestration)
 *   - enforcer        — LeaseEnforcer (per-call enforcement)
 *   - resolver        — ToolActionResolver built from config.toolActions
 *
 * All components are wired by constructor injection — no global singletons.
 * The caller owns the bundle and manages its lifetime.
 *
 * Usage:
 *   const config = await loadConfig('./gateway.config.json');
 *   const bundle = wireGovern(config);
 *   // bundle.enforcer.check(token, action)
 *   // bundle.broker.request(leaseRequest)
 *   // bundle.audit.read()
 */

import {
  PasetoV4PublicSigner,
  generateKeyPair,
  DeclarativePolicyEngine,
  InMemoryAuditSink,
  InMemoryRevocationList,
  InMemorySpendLedger,
  InMemoryPendingStore,
  Broker,
  LeaseEnforcer,
} from '@gatewarden/govern';

import type { Enforcer, AuditSink, KeyPair, ToolActionResolver } from '@gatewarden/govern';

import { buildToolActionResolver } from '../contract/index.js';
import type { GatewayConfig } from '../contract/index.js';

// ---------------------------------------------------------------------------
// GovernBundle — the wired runtime returned by wireGovern
// ---------------------------------------------------------------------------

/**
 * All govern components wired and ready to use.
 *
 * The proxy layer (gateway-004) consumes:
 *   - `enforcer`  — to check leases on every tools/call
 *   - `audit`     — to log use and denial events
 *   - `resolver`  — to map tool calls to Actions
 *   - `broker`    — to issue leases (govern CLI / session setup)
 *
 * The concrete types of audit and broker are exposed for tests that need
 * to assert on `audit.read()` or call `broker.request(...)` directly.
 */
export interface GovernBundle {
  /** PASETO v4.public signer — signs and verifies leases. */
  signer: PasetoV4PublicSigner;
  /** Declarative policy engine seeded from config.policy. */
  policy: DeclarativePolicyEngine;
  /** Append-only, hash-chained audit log. */
  audit: InMemoryAuditSink;
  /** In-memory revocation list. */
  revocationList: InMemoryRevocationList;
  /** In-memory spend ledger. */
  spendLedger: InMemorySpendLedger;
  /** In-memory pending store for veto-required requests. */
  pendingStore: InMemoryPendingStore;
  /** Lease issuance orchestrator. */
  broker: Broker;
  /** Per-call enforcer — composes all checks. */
  enforcer: Enforcer;
  /** Tool → Action resolver built from config.toolActions. */
  resolver: ToolActionResolver;
}

// ---------------------------------------------------------------------------
// GovernState — the persistable subset of the runtime
// ---------------------------------------------------------------------------

/**
 * The parts of the govern runtime that outlive one process.
 *
 * `gatewarden request`, `revoke` and `audit` each run as their own process and
 * share these through the state directory. The structural shape matches the
 * CLI's `CliState` (which carries a `stateDir` as well), so a loaded CLI state
 * can be passed straight in.
 */
export interface GovernState {
  /** Signing key. Leases verify only against the key that signed them. */
  keyPair: KeyPair;
  auditSink: InMemoryAuditSink;
  pendingStore: InMemoryPendingStore;
  revocationList: InMemoryRevocationList;
  spendLedger: InMemorySpendLedger;
}

// ---------------------------------------------------------------------------
// wireGovern
// ---------------------------------------------------------------------------

/**
 * Construct the full govern runtime from a validated GatewayConfig.
 *
 * Without `state`, every component is fresh and the signing key is generated
 * for this call alone, so only the bundle's own broker can mint a lease its
 * enforcer will accept. That suits in-process use and tests, and it is the wrong
 * wiring for a process that must honour leases issued elsewhere.
 *
 * With `state`, the key, audit sink, revocation list, spend ledger and pending
 * store are adopted rather than created, so this bundle verifies the leases
 * `gatewarden request` issued and honours the revocations `gatewarden revoke`
 * recorded. This is how `gatewarden serve` is wired. The caller owns persisting
 * the state again.
 *
 * Key ID defaults to `"k1"` for a generated key; a supplied key keeps its own.
 * The proxy layer passes the token back through the enforcer (same signer),
 * so the key always resolves from the keyring.
 *
 * @param config - A validated GatewayConfig (from loadConfig).
 * @param state  - Optional persisted components to adopt (see GovernState).
 * @returns     A fully wired GovernBundle.
 */
export function wireGovern(config: GatewayConfig, state?: GovernState): GovernBundle {
  // ── 1. Signing lane ───────────────────────────────────────────────────────
  const keyPair = state?.keyPair ?? generateKeyPair('k1');
  const signer = new PasetoV4PublicSigner(keyPair);

  // ── 2. Policy lane ────────────────────────────────────────────────────────
  const policy = new DeclarativePolicyEngine(config.policy);

  // ── 3. Audit lane ─────────────────────────────────────────────────────────
  const audit = state?.auditSink ?? new InMemoryAuditSink();
  const revocationList = state?.revocationList ?? new InMemoryRevocationList();
  const spendLedger = state?.spendLedger ?? new InMemorySpendLedger();
  const pendingStore = state?.pendingStore ?? new InMemoryPendingStore();

  // ── 4. Broker ─────────────────────────────────────────────────────────────
  // The kid passed to Broker must match the signer's active key so that
  // issued leases carry the correct kid for ring-based verification.
  const broker = new Broker(policy, signer, audit, pendingStore, keyPair.kid);

  // ── 5. Enforcer ───────────────────────────────────────────────────────────
  const enforcer = new LeaseEnforcer(signer, revocationList, spendLedger);

  // ── 6. ToolActionResolver ─────────────────────────────────────────────────
  const resolver = buildToolActionResolver(config.toolActions);

  return {
    signer,
    policy,
    audit,
    revocationList,
    spendLedger,
    pendingStore,
    broker,
    enforcer,
    resolver,
  };
}
