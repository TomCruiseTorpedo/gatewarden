/**
 * Gateway CLI wiring — constructs govern components from CLI state.
 *
 * Uses only the public `@gatewarden/govern` API.
 */

import {
  Broker,
  LeaseEnforcer,
  DeclarativePolicyEngine,
  PasetoV4PublicSigner,
  loadRules,
} from '@gatewarden/govern';
import type { CliState } from './state.js';
import { loadPolicyRules } from './state.js';

export interface WiredComponents {
  broker: Broker;
  enforcer: LeaseEnforcer;
  signer: PasetoV4PublicSigner;
}

/**
 * Wire all govern components from the CLI state.
 *
 * @param state     Loaded CLI state (stores + key pair).
 * @param rulesFile Optional path to a policy rules JSON file.
 */
export function wireComponents(state: CliState, rulesFile?: string): WiredComponents {
  const kp = state.keyPair;
  const signer = new PasetoV4PublicSigner(kp);

  const rawRules = loadPolicyRules(state.stateDir, rulesFile);
  const rules = rawRules.length > 0 ? loadRules(rawRules) : [];
  const policy = new DeclarativePolicyEngine(rules);

  const broker = new Broker(policy, signer, state.auditSink, state.pendingStore, kp.kid);
  const enforcer = new LeaseEnforcer(signer, state.revocationList, state.spendLedger);

  return { broker, enforcer, signer };
}
