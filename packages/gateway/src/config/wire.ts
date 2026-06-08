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

import type { Enforcer, AuditSink, ToolActionResolver } from '@gatewarden/govern';

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
// wireGovern
// ---------------------------------------------------------------------------

/**
 * Construct the full govern runtime from a validated GatewayConfig.
 *
 * Key ID defaults to `"k1"` — a stable identifier for the initial signing key.
 * The proxy layer passes the token back through the enforcer (same signer),
 * so the key always resolves from the keyring.
 *
 * @param config - A validated GatewayConfig (from loadConfig).
 * @returns     A fully wired GovernBundle.
 */
export function wireGovern(config: GatewayConfig): GovernBundle {
  // ── 1. Signing lane ───────────────────────────────────────────────────────
  const keyPair = generateKeyPair('k1');
  const signer = new PasetoV4PublicSigner(keyPair);

  // ── 2. Policy lane ────────────────────────────────────────────────────────
  const policy = new DeclarativePolicyEngine(config.policy);

  // ── 3. Audit lane ─────────────────────────────────────────────────────────
  const audit = new InMemoryAuditSink();
  const revocationList = new InMemoryRevocationList();
  const spendLedger = new InMemorySpendLedger();
  const pendingStore = new InMemoryPendingStore();

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
