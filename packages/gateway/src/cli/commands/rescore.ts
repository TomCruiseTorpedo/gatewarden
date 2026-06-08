/**
 * `gatewarden rescore <config>` — fresh keyless score of the downstream.
 *
 * Semantically identical to `score` — connects to the downstream, runs the
 * keyless scoring pipeline, prints a new GatewaySnapshot. The name conveys
 * intent: "I want a fresh score, not the cached attach-time snapshot."
 *
 * Output: GatewaySnapshot as JSON.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../../config/index.js';
import { rescore } from '../../scoring/index.js';
import type { StdioDownstreamSpec } from '../../contract/index.js';

export interface RescoreOptions {
  configPath: string;
}

export async function cmdRescore(opts: RescoreOptions): Promise<void> {
  const config = await loadConfig(opts.configPath);

  const downstream = config.downstream;
  if (downstream.transport !== 'stdio') {
    console.error(
      `Error: rescore command only supports stdio transport in v1 (got "${downstream.transport}")`,
    );
    process.exit(1);
  }

  const spec = downstream as StdioDownstreamSpec;
  const client = new Client(
    { name: 'gatewarden-rescorer', version: '1.0.0' },
    { capabilities: {} },
  );

  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args ?? [],
    env: spec.env !== undefined ? { ...process.env, ...spec.env } as Record<string, string> : undefined,
  });

  try {
    await client.connect(transport);
    const snapshot = await rescore(client, { transportKind: 'stdio' });
    console.log(JSON.stringify(snapshot, null, 2));
  } finally {
    await client.close();
  }
}
