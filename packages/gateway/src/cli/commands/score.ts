/**
 * `gatewarden score <config>` — score the downstream server (no serve).
 *
 * Loads the gateway config, connects to the downstream MCP server via stdio,
 * runs the keyless scoring pipeline (R2), and prints the resulting snapshot
 * as JSON. The process exits after printing — it does NOT start a proxy.
 *
 * Output: GatewaySnapshot as JSON.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../../config/index.js';
import { attachSnapshot } from '../../scoring/index.js';
import type { StdioDownstreamSpec } from '../../contract/index.js';

export interface ScoreOptions {
  configPath: string;
}

export async function cmdScore(opts: ScoreOptions): Promise<void> {
  const config = await loadConfig(opts.configPath);

  const downstream = config.downstream;
  if (downstream.transport !== 'stdio') {
    // v1: only stdio transport supported for score/rescore
    console.error(
      `Error: score command only supports stdio transport in v1 (got "${downstream.transport}")`,
    );
    process.exit(1);
  }

  const spec = downstream as StdioDownstreamSpec;
  const client = new Client(
    { name: 'gatewarden-scorer', version: '1.0.0' },
    { capabilities: {} },
  );

  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args ?? [],
    env: spec.env !== undefined ? { ...process.env, ...spec.env } as Record<string, string> : undefined,
  });

  try {
    await client.connect(transport);
    const snapshot = await attachSnapshot(client, { transportKind: 'stdio' });
    console.log(JSON.stringify(snapshot, null, 2));
  } finally {
    await client.close();
  }
}
