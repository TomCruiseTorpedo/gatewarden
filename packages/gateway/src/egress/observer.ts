/**
 * Egress observer — measures where a downstream ACTUALLY connected.
 *
 * WHAT PROBLEM THIS SOLVES. gatewarden's `http.call` capability checks a
 * DECLARED endpoint string against a policy pattern. That verifies what the
 * caller claimed, not what happened: a downstream can declare
 * `api.example.com` and then connect anywhere it likes, and nothing in the
 * system would notice. This module observes the actual connections so the two
 * can be compared.
 *
 * WHAT THIS IS NOT — read this before writing any copy about it.
 *
 *   It is NOT enforcement. Nothing here blocks a connection. It samples a
 *   process's open sockets and reports what it saw. A downstream that connects
 *   somewhere it should not will still succeed; the value is that the operator
 *   can find out.
 *
 *   It is NOT complete. Sampling has gaps BY CONSTRUCTION: a connection opened
 *   and closed between two samples is invisible to it. Every result is
 *   therefore "what we observed", never "everything that happened", and no
 *   caller may upgrade that phrasing. An absent destination is not evidence a
 *   destination was never contacted.
 *
 *   It is NOT an attestation. Do not use that word, do not add a badge, and do
 *   not ship a parity claim without saying which of the above applies.
 *
 * COVERAGE. Only processes gatewarden itself spawned, because only those have
 * a PID it can name. A REMOTE downstream (SSE/HTTP) has zero coverage — that
 * process runs on someone else's machine and no amount of local measurement
 * reaches it. `describeCoverage` in `./parity.js` states this at runtime so it
 * is surfaced rather than buried here.
 *
 * MECHANISM. `lsof -nP -i -a -p <pids> -F pcn`, whose field output was
 * verified directly rather than taken from the man page:
 *
 *   p55096                                  process id
 *   cnode                                   command
 *   f13                                     file descriptor
 *   n127.0.0.1:62937->127.0.0.1:62936       name; the arrow marks an
 *                                           established connection, and the
 *                                           right-hand side is the REMOTE peer
 *
 * A line with no arrow is a listening socket, not egress, and is ignored.
 */

import { execFile } from 'node:child_process';

/** One destination the downstream was observed connected to. */
export interface ObservedDestination {
  /** Remote peer as reported by lsof, e.g. `93.184.216.34:443`. */
  peer: string;
  /** Host portion — an address, since `-n` disables name resolution. */
  host: string;
  /** Port portion, as a number when parseable. */
  port: number | null;
  /** Which observed PID held the socket. */
  pid: number;
  /** Command name of that PID, for attribution when a child connects. */
  command: string;
}

/** Why an observation attempt produced nothing useful. */
export type ObserverUnavailableReason =
  | 'lsof-missing'
  | 'lsof-failed'
  | 'no-pids';

export interface ObservationResult {
  /** Distinct destinations seen in this sample. Empty is NOT proof of none. */
  destinations: ObservedDestination[];
  /**
   * Set when the sample could not be taken at all.
   *
   * Distinguished from "sampled and saw nothing" on purpose: a failed
   * measurement reported as a clean one is how a coverage gap turns into a
   * false assurance.
   */
  unavailable?: ObserverUnavailableReason;
}

/** Run lsof and return raw stdout, or null when it could not run. */
async function runLsof(pids: readonly number[]): Promise<string | null> {
  if (pids.length === 0) return null;
  return new Promise((resolve) => {
    execFile(
      'lsof',
      ['-nP', '-i', '-a', '-p', pids.join(','), '-F', 'pcn'],
      { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        // lsof exits non-zero when it finds nothing, which is not an error for
        // our purposes — distinguish "ran, found none" from "could not run" by
        // whether we got usable output rather than by the exit code alone.
        if (error && stdout.length === 0) {
          resolve(null);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Parse lsof `-F pcn` output into observed egress destinations.
 *
 * Exported for tests: parsing real tool output is where this kind of code
 * breaks, and a fixture-driven test is cheaper than re-running lsof.
 */
export function parseLsofFieldOutput(stdout: string): ObservedDestination[] {
  const out: ObservedDestination[] = [];
  let pid = 0;
  let command = '';

  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    const tag = line[0];
    const value = line.slice(1);

    if (tag === 'p') {
      const parsed = Number.parseInt(value, 10);
      pid = Number.isFinite(parsed) ? parsed : 0;
      continue;
    }
    if (tag === 'c') {
      command = value;
      continue;
    }
    if (tag !== 'n') continue;

    // Only established connections carry the arrow. Everything else is a
    // listener or a bare bind, which is inbound surface, not egress.
    const arrow = value.indexOf('->');
    if (arrow === -1) continue;

    const peer = value.slice(arrow + 2).trim();
    if (peer.length === 0) continue;

    // Split host:port from the RIGHT, so IPv6 literals survive.
    const colon = peer.lastIndexOf(':');
    const host = colon === -1 ? peer : peer.slice(0, colon);
    const portRaw = colon === -1 ? '' : peer.slice(colon + 1);
    const portNum = Number.parseInt(portRaw, 10);

    out.push({
      peer,
      host,
      port: Number.isFinite(portNum) ? portNum : null,
      pid,
      command,
    });
  }
  return out;
}

/** Expand a root PID to itself plus its descendants, best-effort. */
export async function processTree(rootPid: number): Promise<number[]> {
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];

  while (queue.length > 0) {
    const parent = queue.shift() as number;
    const children = await new Promise<number[]>((resolve) => {
      execFile('pgrep', ['-P', String(parent)], { timeout: 3000 }, (error, stdout) => {
        if (error && stdout.length === 0) {
          resolve([]);
          return;
        }
        resolve(
          stdout
            .split('\n')
            .map((l) => Number.parseInt(l.trim(), 10))
            .filter((n) => Number.isFinite(n) && n > 0),
        );
      });
    });
    for (const child of children) {
      if (!seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
    }
  }
  return [...seen];
}

/**
 * Take one sample of the destinations a process tree is currently connected to.
 *
 * A single sample is a snapshot. Repeated sampling narrows the gap but never
 * closes it — see the module header.
 */
export async function sampleEgress(pids: readonly number[]): Promise<ObservationResult> {
  if (pids.length === 0) return { destinations: [], unavailable: 'no-pids' };

  const stdout = await runLsof(pids);
  if (stdout === null) {
    // Tell the two failure modes apart so the coverage report can be precise
    // about whether the tool is absent or merely refused this sample.
    const present = await new Promise<boolean>((resolve) => {
      execFile('lsof', ['-v'], { timeout: 3000 }, (error) => resolve(!error));
    });
    return { destinations: [], unavailable: present ? 'lsof-failed' : 'lsof-missing' };
  }

  return { destinations: parseLsofFieldOutput(stdout) };
}

/**
 * Accumulates distinct destinations across many samples.
 *
 * Deduplicates on `peer`, keeping the first sighting: the question is WHETHER
 * a destination was contacted, not how often.
 */
export class EgressLog {
  readonly #byPeer = new Map<string, ObservedDestination>();
  #samples = 0;
  #failedSamples = 0;

  record(result: ObservationResult): void {
    this.#samples += 1;
    if (result.unavailable !== undefined) {
      this.#failedSamples += 1;
      return;
    }
    for (const destination of result.destinations) {
      if (!this.#byPeer.has(destination.peer)) {
        this.#byPeer.set(destination.peer, destination);
      }
    }
  }

  destinations(): ObservedDestination[] {
    return [...this.#byPeer.values()];
  }

  /** Total samples attempted, including failures. */
  get sampleCount(): number {
    return this.#samples;
  }

  /**
   * Samples that could not be taken.
   *
   * Surfaced rather than hidden: a run whose samples mostly failed has weak
   * coverage, and a parity report drawn from it must say so instead of
   * presenting a short observed-list as a quiet all-clear.
   */
  get failedSampleCount(): number {
    return this.#failedSamples;
  }
}
