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

  // Log to stderr so it doesn't pollute the MCP stdio channel.
  process.stderr.write(
    `gatewarden proxy ready — score: ${snapshot.scorecard.aggregate.lintScore}\n`,
  );

  const cleanup = (): void => {
    proxy.close().catch(() => {
      /* ignore */
    });
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}
