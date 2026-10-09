/**
 * `gatewarden serve <config>` — start the gateway proxy.
 *
 * Loads the gateway config, wires the govern runtime from the persisted CLI
 * state, creates a GatewardenProxy, and starts serving on stdio.
 *
 * The signing key, revocation list, spend ledger and audit log come from the
 * state directory (`--state-dir`, `GATEWARDEN_STATE_DIR`, or `.gatewarden/`),
 * the same place `gatewarden request` and `gatewarden revoke` write. That is
 * what lets a lease minted by `request` verify here and a revoked one be
 * refused, including one revoked while this process is running. Spend is
 * charged against `spend.json` under a lock as it happens, so every gateway
 * sharing the directory shares one cap. On SIGINT/SIGTERM only this session's
 * own audit events are merged back; nothing else in the directory is rewritten.
 *
 * The proxy server reads from stdin / writes to stdout (StdioServerTransport).
 * The downstream MCP server is spawned as a subprocess (StdioClientTransport).
 *
 * Usage:
 *   gatewarden serve ./gateway.config.json
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../../config/index.js';
import { wireGovern } from '../../config/index.js';
import { GatewardenProxy } from '../../proxy/index.js';
import { openServeSession, resolveStateDir } from '../state.js';
import type { StdioDownstreamSpec } from '../../contract/index.js';
import { EgressLog, processTree, sampleEgress } from '../../egress/observer.js';
import { computeEgressParity, describeCoverage, renderEgressParity } from '../../egress/parity.js';

/**
 * Pull every declared `http.call` endpoint out of the policy rules.
 *
 * These are the DECLARATIONS the observed connections get diffed against. A
 * config with no http.call rules yields an empty list, which is meaningful:
 * every observed destination is then undeclared.
 */
function collectDeclaredEndpoints(config: unknown): string[] {
  const out = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const record = node as Record<string, unknown>;
    if (Array.isArray(record['endpoints'])) {
      for (const e of record['endpoints']) if (typeof e === 'string') out.add(e);
    }
    for (const value of Object.values(record)) visit(value);
  };
  visit(config);
  return [...out];
}

export interface ServeOptions {
  configPath: string;
  /** State directory holding the signing key and stores. Defaults per `resolveStateDir`. */
  stateDir?: string;
}

export async function cmdServe(opts: ServeOptions): Promise<void> {
  const config = await loadConfig(opts.configPath);

  if (config.downstream.transport !== 'stdio') {
    console.error(
      `Error: serve command only supports stdio transport in v1 (got "${config.downstream.transport}")`,
    );
    process.exit(1);
  }

  const spec = config.downstream as StdioDownstreamSpec;
  // Wire from the persisted state, not a fresh in-memory runtime: a fresh one
  // generates its own signing key, so no lease `gatewarden request` ever issued
  // could verify here.
  const session = openServeSession(resolveStateDir(opts.stateDir));
  // A long-running proxy persists its session's audit events at shutdown, and
  // that save is refused on a tampered log, so the session's events would be
  // lost. Fail closed at startup instead.
  if (session.state.auditIntegrity === 'tampered') {
    process.stderr.write(
      'refusing to start: audit log fails stored hash-chain verification — possible tampering. ' +
        'Archive the audit log manually to resume with a fresh chain.\n',
    );
    process.exit(1);
  }
  const bundle = wireGovern(config, session.state);
  const proxy = new GatewardenProxy(bundle);

  const clientTransport = new StdioServerTransport();
  const downstreamTransport = new StdioClientTransport({
    command: spec.command,
    args: spec.args ?? [],
    env: spec.env !== undefined ? { ...process.env, ...spec.env } as Record<string, string> : undefined,
  });

  const snapshot = await proxy.attach(clientTransport, downstreamTransport);

  // ── Egress observation (D3 tier 1) ────────────────────────────────────
  // Measures where the downstream ACTUALLY connects, so the declared
  // endpoints can be diffed against reality. It observes; it does not block.
  // The tier is announced up front because a run with no observer looks
  // exactly like a clean run if you only read the destination list.
  const downstreamPid = downstreamTransport.pid;
  const egressLog = new EgressLog();
  const declaredEndpoints = collectDeclaredEndpoints(config);

  let egressTimer: ReturnType<typeof setInterval> | undefined;
  if (downstreamPid !== null && downstreamPid !== undefined) {
    const tick = async (): Promise<void> => {
      egressLog.record(await sampleEgress(await processTree(downstreamPid)));
    };
    void tick();
    egressTimer = setInterval(() => void tick(), 2000);
    egressTimer.unref?.();
  }

  process.stderr.write(
    `${describeCoverage(downstreamPid == null ? 'remote' : 'stdio', egressLog).summary}\n`,
  );

  // Log to stderr so it doesn't pollute the MCP stdio channel.
  process.stderr.write(
    `gatewarden proxy ready — score: ${snapshot.scorecard.aggregate.lintScore}\n`,
  );

  const cleanup = (): void => {
    if (egressTimer !== undefined) clearInterval(egressTimer);
    // Print the parity report on the way out — it is the whole point of
    // observing, and an operator will not go looking for it.
    process.stderr.write(
      renderEgressParity(
        computeEgressParity(
          declaredEndpoints,
          egressLog,
          downstreamPid == null ? 'remote' : 'stdio',
        ),
      ) + '\n',
    );
    // Persist this session's audit events. The session merges them onto the
    // log as it is on disk now rather than rewriting the state directory from
    // the snapshot taken at startup, which would undo anything `request` and
    // `revoke` did while this process was up. If the log was tampered with
    // meanwhile the save refuses; say so rather than exit with events unsaved.
    try {
      session.save();
    } catch (err) {
      process.stderr.write(`gatewarden: ${(err as Error).message}\n`);
    }
    proxy.close().catch(() => {
      /* ignore */
    });
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}
