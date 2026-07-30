/**
 * Tests for egress observation and parity.
 *
 * The lsof fixture is REAL captured output (macOS, `lsof -nP -i -a -p <pid> -F pcn`
 * against a process with one listener and two established sockets), not
 * invented from the man page — parsing real tool output is exactly where this
 * kind of code breaks.
 *
 * The cases that matter most are the ones where coverage is ABSENT, because a
 * report that cannot distinguish "measured nothing" from "nothing happened" is
 * worse than no report.
 */

import { describe, it, expect } from 'vitest';
import { EgressLog, parseLsofFieldOutput } from '../observer.js';
import {
  computeEgressParity,
  describeCoverage,
  destinationMatchesDeclared,
  renderEgressParity,
} from '../parity.js';

// Captured verbatim from a control process with a known listener + connection.
const LSOF_FIXTURE = [
  'p55096',
  'cnode',
  'f12',
  'n127.0.0.1:62936',
  'f13',
  'n127.0.0.1:62937->127.0.0.1:62936',
  'f14',
  'n127.0.0.1:62936->127.0.0.1:62937',
].join('\n');

describe('parseLsofFieldOutput', () => {
  it('extracts the REMOTE side of established connections only', () => {
    const found = parseLsofFieldOutput(LSOF_FIXTURE);
    expect(found.map((d) => d.peer)).toEqual(['127.0.0.1:62936', '127.0.0.1:62937']);
  });

  it('ignores listening sockets — a bind is inbound surface, not egress', () => {
    // The fixture's first entry (no arrow) is a LISTEN and must not appear.
    const found = parseLsofFieldOutput('p1\ncnode\nf12\nn127.0.0.1:62936\n');
    expect(found).toHaveLength(0);
  });

  it('carries pid and command through for attribution', () => {
    const [first] = parseLsofFieldOutput(LSOF_FIXTURE);
    expect(first?.pid).toBe(55096);
    expect(first?.command).toBe('node');
  });

  it('splits host:port from the right so IPv6 literals survive', () => {
    const [d] = parseLsofFieldOutput('p1\ncnode\nf5\nn[::1]:100->[2606:2800::1]:443\n');
    expect(d?.host).toBe('[2606:2800::1]');
    expect(d?.port).toBe(443);
  });

  it('returns nothing for empty input rather than throwing', () => {
    expect(parseLsofFieldOutput('')).toEqual([]);
  });
});

describe('describeCoverage — the part that must never quietly pass', () => {
  it('reports NO coverage for a remote downstream, whatever was sampled', () => {
    const c = describeCoverage('remote', { sampleCount: 99, failedSampleCount: 0 });
    expect(c.tier).toBe('none');
    expect(c.summary).toMatch(/NO egress coverage/);
  });

  it('reports NO coverage when every sample failed, and says so explicitly', () => {
    const c = describeCoverage('stdio', { sampleCount: 5, failedSampleCount: 5 });
    expect(c.tier).toBe('none');
    // The distinction that matters: not-measured must not read as nothing-happened.
    expect(c.summary).toMatch(/NOT MEASURED/i);
  });

  it('never claims coverage with an empty blind-spot list', () => {
    const c = describeCoverage('stdio', { sampleCount: 10, failedSampleCount: 0 });
    expect(c.tier).toBe('observed');
    expect(c.blindSpots.length).toBeGreaterThan(0);
    expect(c.blindSpots.join(' ')).toMatch(/BETWEEN samples/i);
  });

  it('surfaces partial sample failure in the blind spots', () => {
    const c = describeCoverage('stdio', { sampleCount: 10, failedSampleCount: 4 });
    expect(c.tier).toBe('observed');
    expect(c.blindSpots.join(' ')).toMatch(/4 of 10 samples failed/);
  });

  it('has no tier meaning "enforced" — nothing here blocks anything', () => {
    const tiers = [
      describeCoverage('remote', { sampleCount: 0, failedSampleCount: 0 }).tier,
      describeCoverage('stdio', { sampleCount: 1, failedSampleCount: 0 }).tier,
    ];
    expect(tiers).not.toContain('enforced');
    expect(tiers.every((t) => t === 'none' || t === 'observed')).toBe(true);
  });
});

describe('destinationMatchesDeclared', () => {
  const dest = (host: string, port: number | null = 443) => ({
    peer: `${host}:${port ?? ''}`,
    host,
    port,
    pid: 1,
    command: 'node',
  });

  it('matches a declared URL against an observed host', () => {
    expect(destinationMatchesDeclared(dest('api.example.com'), 'https://api.example.com/**')).toBe(true);
  });

  it('does not match a different host', () => {
    expect(destinationMatchesDeclared(dest('evil.example.net'), 'https://api.example.com/**')).toBe(false);
  });

  it('honours a glob in the declared host', () => {
    expect(destinationMatchesDeclared(dest('a.example.com'), 'https://*.example.com')).toBe(true);
  });

  it('rejects on an explicit port mismatch', () => {
    expect(destinationMatchesDeclared(dest('api.example.com', 8080), 'api.example.com:443')).toBe(false);
  });
});

describe('computeEgressParity', () => {
  function logWith(peers: string[], failed = 0): EgressLog {
    const log = new EgressLog();
    log.record({
      destinations: peers.map((p) => {
        const i = p.lastIndexOf(':');
        return {
          peer: p,
          host: p.slice(0, i),
          port: Number.parseInt(p.slice(i + 1), 10),
          pid: 1,
          command: 'node',
        };
      }),
    });
    for (let i = 0; i < failed; i += 1) log.record({ destinations: [], unavailable: 'lsof-failed' });
    return log;
  }

  it('FLAGS a destination that was never declared — the alarm', () => {
    const report = computeEgressParity(
      ['https://api.example.com/**'],
      logWith(['api.example.com:443', 'exfil.example.net:443']),
      'stdio',
    );
    expect(report.observedNotDeclared.map((d) => d.host)).toEqual(['exfil.example.net']);
    expect(report.matched).toHaveLength(1);
  });

  it('reports over-declaration separately from the alarm', () => {
    const report = computeEgressParity(
      ['https://api.example.com/**', 'https://unused.example.com/**'],
      logWith(['api.example.com:443']),
      'stdio',
    );
    expect(report.observedNotDeclared).toHaveLength(0);
    expect(report.declaredNotObserved).toEqual(['https://unused.example.com/**']);
  });

  it('carries coverage into the report even when the result looks clean', () => {
    // Zero destinations plus zero declarations LOOKS like a clean run. The
    // report must still say what was covered, or a skimmer reads silence as
    // safety.
    const report = computeEgressParity([], logWith([]), 'stdio');
    expect(report.observedNotDeclared).toHaveLength(0);
    expect(report.coverage.tier).toBe('observed');
    expect(report.coverage.blindSpots.length).toBeGreaterThan(0);
  });

  it('drops to tier none when EVERY sample failed, not merely some', () => {
    const log = new EgressLog();
    log.record({ destinations: [], unavailable: 'lsof-missing' });
    log.record({ destinations: [], unavailable: 'lsof-missing' });
    const report = computeEgressParity(['https://api.example.com'], log, 'stdio');
    expect(report.coverage.tier).toBe('none');
    expect(report.samplesFailed).toBe(2);
    // And the declared endpoint must NOT be reported as unused, because
    // nothing was measured.
    expect(report.coverage.summary).toMatch(/NOT MEASURED/i);
  });
});

describe('renderEgressParity', () => {
  it('leads with the tier so a skimmer cannot miss that nothing was enforced', () => {
    const log = new EgressLog();
    log.record({ destinations: [] });
    const text = renderEgressParity(computeEgressParity([], log, 'stdio'));
    expect(text.split('\n')[0]).toMatch(/^egress: tier=/);
    expect(text).toMatch(/not enforced/i);
  });

  it('never presents a silent result as proof of absence', () => {
    const log = new EgressLog();
    log.record({ destinations: [] });
    const text = renderEgressParity(computeEgressParity([], log, 'stdio'));
    expect(text).toMatch(/not proof there were none/i);
  });

  it('states blind spots in every rendered report', () => {
    const log = new EgressLog();
    log.record({ destinations: [] });
    expect(renderEgressParity(computeEgressParity([], log, 'stdio'))).toMatch(/blind spots:/);
  });
});
