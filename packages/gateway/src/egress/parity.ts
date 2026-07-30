/**
 * Egress parity — declared endpoints vs observed connections, honestly fenced.
 *
 * The claim this produces is deliberately narrow: **"here is what we declared,
 * here is what we observed, here is the difference."** It is a measurement, not
 * an enforcement, and the coverage map below exists so the difference cannot be
 * read as more than it is.
 *
 * THE THREE BUCKETS, and what each actually means:
 *
 *   matched              An observed connection matched a declared endpoint.
 *                        Says the declaration was honest about that
 *                        destination. Says nothing about the others.
 *
 *   observedNotDeclared  THE ALARM. The downstream connected somewhere it did
 *                        not declare. This is the finding the whole module
 *                        exists to surface.
 *
 *   declaredNotObserved  Over-declaration: permission asked for and never
 *                        used. NOT a security finding — it is a least-privilege
 *                        hint, and it is weak because sampling misses short
 *                        connections. Never report it as "unused, safe to
 *                        remove" on the strength of one run.
 *
 * WHY THE COVERAGE MAP IS NOT A FOOTNOTE. Structural egress enforcement fails
 * SILENTLY: when it is not applied, everything works normally and nothing says
 * so. The same is true of measurement — a run with no observer looks identical
 * to a run with a clean result if you only read the destination list. So the
 * active tier is a first-class part of every report, and `EgressTier` has no
 * value meaning "enforced", because nothing here enforces.
 */

import { minimatch } from 'minimatch';
import type { EgressLog, ObservedDestination } from './observer.js';

/**
 * How much the report can be trusted, ordered weakest first.
 *
 * There is deliberately NO `enforced` member. Adding one would require code
 * that actually blocks a connection, which this module does not do.
 */
export type EgressTier =
  /** No measurement at all. A remote downstream, or the observer could not run. */
  | 'none'
  /** Sampled a process tree we own. Gaps between samples are real. */
  | 'observed';

export interface EgressCoverage {
  tier: EgressTier;
  /** One line an operator can act on, stating what is and is not covered. */
  summary: string;
  /** Specific things this run could not see. Never empty at tier 'observed'. */
  blindSpots: string[];
}

export interface EgressParityReport {
  coverage: EgressCoverage;
  matched: Array<{ destination: ObservedDestination; declared: string }>;
  /** The alarm: connected somewhere not declared. */
  observedNotDeclared: ObservedDestination[];
  /** Declared and never seen. A least-privilege hint, not a finding. */
  declaredNotObserved: string[];
  samplesTaken: number;
  samplesFailed: number;
}

/** Downstream kinds, which decide whether measurement is possible at all. */
export type DownstreamKind = 'stdio' | 'remote';

/**
 * State the coverage of this run.
 *
 * Called even when nothing was observed — especially then. A report with no
 * destinations and no coverage statement is indistinguishable from a clean
 * result, which is the confusion this whole design is built to prevent.
 */
export function describeCoverage(
  downstream: DownstreamKind,
  log: Pick<EgressLog, 'sampleCount' | 'failedSampleCount'>,
): EgressCoverage {
  if (downstream === 'remote') {
    return {
      tier: 'none',
      summary:
        'NO egress coverage: the downstream is remote (SSE/HTTP), so its network activity ' +
        'happens on a machine gatewarden does not control and cannot observe.',
      blindSpots: [
        'every connection the downstream makes — it is not our process',
        'local measurement cannot reach a remote downstream by any mechanism',
      ],
    };
  }

  if (log.sampleCount === 0 || log.failedSampleCount === log.sampleCount) {
    return {
      tier: 'none',
      summary:
        'NO egress coverage: no sample succeeded (lsof missing, or it could not read the ' +
        'process). An empty destination list here means NOT MEASURED, not "nothing happened".',
      blindSpots: ['everything — no successful observation was taken'],
    };
  }

  const blindSpots = [
    'connections opened and closed BETWEEN samples — sampling has gaps by construction',
    'UDP and unix-domain sockets are not reported by this observer',
    'DNS resolution performed by a system resolver on the process’s behalf',
    'any child process that started and exited between samples',
  ];
  if (log.failedSampleCount > 0) {
    blindSpots.push(
      `${log.failedSampleCount} of ${log.sampleCount} samples failed — coverage is weaker than the sample count suggests`,
    );
  }

  return {
    tier: 'observed',
    summary:
      `Egress OBSERVED (not enforced) across ${log.sampleCount - log.failedSampleCount} of ` +
      `${log.sampleCount} samples of the downstream process tree. Nothing was blocked; ` +
      'destinations listed are what was seen, not everything that occurred.',
    blindSpots,
  };
}

/**
 * Match an observed destination against a declared endpoint pattern.
 *
 * Declared endpoints are URL-ish (`https://api.example.com/**`) while an
 * observation is `host:port`, so the comparison is on HOST, with the port
 * checked when the pattern implies one. Deliberately generous: this feeds a
 * report a human reads, and a false ALARM is more costly here than a missed
 * match, because an alarm nobody trusts gets switched off.
 */
export function destinationMatchesDeclared(
  destination: ObservedDestination,
  declared: string,
): boolean {
  let pattern = declared;

  // Strip a scheme if present, then any path — we compare authorities.
  const scheme = pattern.indexOf('://');
  if (scheme !== -1) pattern = pattern.slice(scheme + 3);
  const slash = pattern.indexOf('/');
  if (slash !== -1) pattern = pattern.slice(0, slash);

  const colon = pattern.lastIndexOf(':');
  const hostPattern = colon === -1 ? pattern : pattern.slice(0, colon);
  const portPattern = colon === -1 ? null : pattern.slice(colon + 1);

  if (portPattern !== null && destination.port !== null) {
    if (portPattern !== String(destination.port) && portPattern !== '*') return false;
  }

  return (
    hostPattern === destination.host ||
    minimatch(destination.host, hostPattern)
  );
}

/** Diff what was declared against what was observed. */
export function computeEgressParity(
  declaredEndpoints: readonly string[],
  log: EgressLog,
  downstream: DownstreamKind,
): EgressParityReport {
  const coverage = describeCoverage(downstream, log);
  const observed = log.destinations();

  const matched: EgressParityReport['matched'] = [];
  const observedNotDeclared: ObservedDestination[] = [];
  const usedDeclarations = new Set<string>();

  for (const destination of observed) {
    const hit = declaredEndpoints.find((d) => destinationMatchesDeclared(destination, d));
    if (hit === undefined) {
      observedNotDeclared.push(destination);
    } else {
      usedDeclarations.add(hit);
      matched.push({ destination, declared: hit });
    }
  }

  return {
    coverage,
    matched,
    observedNotDeclared,
    declaredNotObserved: declaredEndpoints.filter((d) => !usedDeclarations.has(d)),
    samplesTaken: log.sampleCount,
    samplesFailed: log.failedSampleCount,
  };
}

/**
 * Render a report for an operator.
 *
 * Leads with coverage, on purpose. Someone skimming for the destination list
 * must not be able to miss that nothing was enforced and that the list is
 * partial.
 */
export function renderEgressParity(report: EgressParityReport): string {
  const lines: string[] = [];
  lines.push(`egress: tier=${report.coverage.tier}`);
  lines.push(`  ${report.coverage.summary}`);

  if (report.observedNotDeclared.length > 0) {
    lines.push('  UNDECLARED DESTINATIONS (the downstream connected somewhere it did not declare):');
    for (const d of report.observedNotDeclared) {
      lines.push(`    ${d.peer}  (pid ${d.pid} ${d.command})`);
    }
  } else if (report.coverage.tier === 'observed') {
    lines.push('  No undeclared destination was OBSERVED. This is not proof there were none —');
    lines.push('  see blind spots below.');
  }

  if (report.matched.length > 0) {
    lines.push('  matched declarations:');
    for (const m of report.matched) {
      lines.push(`    ${m.destination.peer} -> declared ${m.declared}`);
    }
  }

  if (report.declaredNotObserved.length > 0) {
    lines.push('  declared but not observed (least-privilege hint, NOT a finding —');
    lines.push('  sampling misses short connections, so do not prune on this alone):');
    for (const d of report.declaredNotObserved) lines.push(`    ${d}`);
  }

  lines.push('  blind spots:');
  for (const b of report.coverage.blindSpots) lines.push(`    - ${b}`);

  return lines.join('\n');
}
