/**
 * Fixture GatewayConfig — fronts @modelcontextprotocol/server-filesystem.
 *
 * Sandbox directory: packages/gateway/fixtures/
 *   - allowed.txt       — the one permitted read path
 *   - private/          — blocked by policy + lease scope
 *
 * Tool→Action map:
 *   read_file  → fs.read  (pathArg: 'path')
 *   write_file → fs.write (pathArg: 'path')
 *
 * Policy: allow fs.read for allowed.txt only (deny-by-default for everything else).
 *
 * Used by: scripts/demo.mjs
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { GatewayConfig } from '../src/contract/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the @modelcontextprotocol/server-filesystem entry point.
 * Resolved from the gateway package's own node_modules — no global install needed.
 */
const serverBin = join(
  __dirname,
  '..',
  'node_modules',
  '@modelcontextprotocol',
  'server-filesystem',
  'dist',
  'index.js',
);

/** The one file the policy permits agents to read. */
const allowedFile = join(__dirname, 'allowed.txt');

export default {
  downstream: {
    transport: 'stdio',
    command: 'node',
    args: [serverBin, __dirname],
  },
  toolActions: [
    { toolName: 'read_file', kind: 'fs.read', pathArg: 'path' },
    { toolName: 'write_file', kind: 'fs.write', pathArg: 'path' },
  ],
  policy: [
    {
      ruleId: 'allow-fixture-read',
      capabilityKind: 'fs.read',
      effect: 'allow',
      paths: [allowedFile],
    },
  ],
} satisfies GatewayConfig;
