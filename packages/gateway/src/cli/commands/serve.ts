/**
 * `gatewarden serve <config>` — start the gateway proxy.
 *
 * Loads the gateway config, wires the govern runtime, creates a
 * GatewardenProxy, and starts serving on stdio.
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
  const bundle = wireGovern(config);
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
    proxy.close().catch(() => {
      /* ignore */
    });
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}
