/**
 * `leasebroker audit` — view the audit log.
 *
 * Prints audit events from the hash-chained log. Optionally filters by type
 * or limits to the last N events.
 *
 * Usage:
 *   leasebroker audit
 *   leasebroker audit --last 20
 *   leasebroker audit --type issuance
 *   leasebroker audit --verify     (verify hash chain integrity)
 *
 * Output: JSON array of AuditEvent objects.
 *
 * DELIBERATE DIVERGENCE from leasebroker's copy, which is why this file is not
 * in the govern drift manifest: leasebroker additionally offers `--by-workflow`
 * and `--verify-anchor`, which depend on its `audit/workflow-report.ts` and
 * `anchor/` modules. Gatewarden does not vendor those. The chain-integrity
 * behaviour below IS shared and must match leasebroker exactly — it was drift,
 * not divergence, and reconciling it is what closed the gap where a tampered
 * log verified as intact.
 */

import type { AuditEventType } from '../../contract/index.js';
import type { CliState } from '../state.js';

export interface AuditOptions {
  last?: number;
  type?: AuditEventType;
  verify?: boolean;
}

export function cmdAudit(state: CliState, opts: AuditOptions): void {
  if (opts.verify) {
    // Judged against the STORED chain at load time (state.auditIntegrity).
    // Verifying the in-memory chain instead would be theatre: loading re-chained
    // events would always pass against their own recomputed hashes.
    if (state.auditIntegrity === 'intact') {
      console.log(JSON.stringify({ ok: true, message: 'Audit log hash chain is intact' }));
    } else {
      console.error(
        JSON.stringify({
          ok: false,
          error: 'Audit log fails stored hash-chain verification — possible tampering',
        }),
      );
      process.exit(1);
    }
    return;
  }

  // A tampered log must still be inspectable — it IS the evidence. Show it
  // verbatim (loadState already warned on stderr); an intact chain goes
  // through read()'s verified path.
  let events =
    state.auditIntegrity === 'intact' ? state.auditSink.read() : state.auditSink.readVerbatim();

  if (opts.type !== undefined) {
    events = events.filter((e) => e.type === opts.type);
  }

  if (opts.last !== undefined && opts.last > 0) {
    events = events.slice(-opts.last);
  }

  console.log(JSON.stringify(events, null, 2));
}
