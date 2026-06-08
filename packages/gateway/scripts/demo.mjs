/**
 * demo.mjs — Gatewarden Proxy end-to-end demo (keyless, deterministic — R10).
 *
 * Demonstrates the full proxy stack against @modelcontextprotocol/server-filesystem:
 *
 *   1. Load the fixture GatewayConfig (fixtures/config.ts)
 *   2. Wire the govern runtime (broker, enforcer, audit)
 *   3. Attach GatewardenProxy to the live filesystem server (scores at attach)
 *   4. Print the deterministic scorecard
 *   5. Issue a capability lease for allowed.txt only
 *   6. Attempt read_file on private/secret.txt  → DENIED by enforcer
 *   7. Attempt read_file on allowed.txt         → OK forwarded to server
 *
 * No API key required. Scoring is deterministic lint-only (R10).
 *
 * Run: bun run demo  (from packages/gateway/)
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// TypeScript source files — Bun resolves .js extensions to .ts
import { GatewardenProxy } from '../src/proxy/gateway.js';
import { wireGovern } from '../src/config/wire.js';
import { loadConfig } from '../src/config/loader.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = join(__dirname, '../fixtures/config.ts');
const fixturesDir = join(__dirname, '../fixtures');
const allowedFilePath = join(fixturesDir, 'allowed.txt');
const privateFilePath = join(fixturesDir, 'private', 'secret.txt');

// ---------------------------------------------------------------------------
// JSON-RPC helpers (mirrors proxy tests — sends raw messages, no SDK Client)
// ---------------------------------------------------------------------------

/** Send a JSON-RPC request and wait for the matching response. */
function sendAndWait(transport, req) {
  return new Promise((resolve, reject) => {
    const prev = transport.onmessage;
    transport.onmessage = (msg) => {
      const m = /** @type {Record<string, unknown>} */ (msg);
      if (m['id'] === req.id) {
        transport.onmessage = prev;
        resolve(m);
      } else {
        prev?.(msg);
      }
    };
    void transport.send({ jsonrpc: '2.0', ...req });
    setTimeout(() => {
      transport.onmessage = prev;
      reject(new Error(`Timeout waiting for response to id=${req.id}`));
    }, 15_000);
  });
}

/** Perform the MCP initialize handshake, injecting a lease token via _meta. */
async function initSession(transport, token) {
  const meta = token != null ? { 'x-lease-token': token } : {};
  await sendAndWait(transport, {
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'demo-client', version: '1.0.0' },
      _meta: meta,
    },
  });
  // initialized notification — no response expected
  await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

/**
 * Call a tool and return the result (or error) object.
 * @param {InMemoryTransport} transport
 * @param {string} toolName
 * @param {Record<string, unknown>} args
 * @param {number} id
 */
async function callTool(transport, toolName, args, id) {
  const response = await sendAndWait(transport, {
    id,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  });
  // result is the RPC result; if the call produced an MCP error, isError=true
  return response['result'] ?? response['error'];
}

// ---------------------------------------------------------------------------
// Scorecard renderer
// ---------------------------------------------------------------------------

const AXIS_NAMES = [
  'namespacing',
  'tool-selection-confusion',
  'param-strictness',
  'output-leanness',
  'error-helpfulness',
];

function grade(n) {
  if (n >= 9) return 'A';
  if (n >= 7) return 'B';
  if (n >= 5) return 'C';
  if (n >= 3) return 'D';
  return 'F';
}

function renderScorecard(snapshot) {
  const { server, scorecard } = snapshot;
  const { axes, aggregate } = scorecard;
  const hr = '─'.repeat(60);
  const lines = [];

  lines.push(`┌${hr}┐`);
  lines.push(
    `│  gatewarden scorecard · ${server.name} v${server.version} (${server.transport})`
      .padEnd(61) + '│',
  );
  lines.push(`├${hr}┤`);
  lines.push(
    `│  ${'Axis'.padEnd(32)} ${'Score'.padEnd(7)} ${'Grade'.padEnd(5)} Findings`.padEnd(61) + '│',
  );
  lines.push(`├${hr}┤`);

  for (const axis of AXIS_NAMES) {
    const ax = axes[axis];
    if (!ax) continue;
    const s = ax.score;
    const errCnt = ax.findings.filter((f) => f.severity === 'error').length;
    const warnCnt = ax.findings.filter((f) => f.severity === 'warning').length;
    const findingStr =
      s === null
        ? 'eval-only'
        : errCnt > 0 || warnCnt > 0
          ? `${errCnt}err ${warnCnt}warn`
          : 'clean';
    const scoreCol = s === null ? '—' : `${s}`;
    const gradeCol = s === null ? '·' : grade(s);
    lines.push(
      `│  ${axis.padEnd(32)} ${scoreCol.padEnd(3)}/10  ${gradeCol.padEnd(4)}  ${findingStr}`.padEnd(61) +
        '│',
    );
  }

  lines.push(`├${hr}┤`);
  lines.push(`│  LINT SCORE (deterministic)   ${aggregate.lintScore.toFixed(1)} / 10`.padEnd(61) + '│');
  lines.push(
    `│  WEIGHTED AGGREGATE           ${aggregate.weighted.toFixed(1)} / 10  [grade: ${grade(aggregate.weighted)}]`.padEnd(
      61,
    ) + '│',
  );
  lines.push(`└${hr}┘`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------

async function main() {
  const sep = '═'.repeat(62);

  console.log(sep);
  console.log('  GATEWARDEN PROXY — FILESYSTEM SERVER DEMO  (keyless, R10)');
  console.log(sep);
  console.log();

  // ── 1. Load fixture config ───────────────────────────────────────────────
  console.log('▶ Loading fixture config:', configPath);
  const config = await loadConfig(configPath);
  console.log('  ✓ Config loaded — downstream:', config.downstream.transport);
  console.log();

  // ── 2. Wire govern runtime ───────────────────────────────────────────────
  const bundle = wireGovern(config);

  // ── 3. Issue a lease for allowed.txt ONLY ───────────────────────────────
  console.log('▶ Requesting capability lease for:', allowedFilePath);
  const leaseResult = bundle.broker.request({
    agentId: 'demo-agent',
    taskId: 'demo-read-task',
    capabilities: [{ kind: 'fs.read', paths: [allowedFilePath] }],
    requestedDurationMs: 60_000,
  });

  if (leaseResult.type !== 'granted') {
    throw new Error(`Lease was not granted: ${JSON.stringify(leaseResult)}`);
  }
  const token = leaseResult.token;
  console.log(`  ✓ Lease granted (id: ${leaseResult.lease.id})`);
  console.log();

  // ── 4. Set up transports ─────────────────────────────────────────────────
  const [clientSide, proxySide] = InMemoryTransport.createLinkedPair();
  proxySide.sessionId = 'demo-session';

  // Spawn the real @modelcontextprotocol/server-filesystem subprocess
  const downstreamTransport = new StdioClientTransport({
    command: config.downstream.command,
    args: config.downstream.args ?? [],
    stderr: 'ignore',
  });

  // ── 5. Attach proxy (connects + scores downstream) ───────────────────────
  console.log('▶ Attaching GatewardenProxy to filesystem server...');
  const proxy = new GatewardenProxy(bundle);
  const snapshot = await proxy.attach(proxySide, downstreamTransport);
  console.log('  ✓ Attached — snapshot captured at:', snapshot.attachedAt);
  console.log();

  // ── 6. Print scorecard ───────────────────────────────────────────────────
  console.log(renderScorecard(snapshot));
  console.log();

  // ── 7. Initialize session with lease token ───────────────────────────────
  await initSession(clientSide, token);

  // ── 8. Attempt: private/secret.txt — EXPECT DENIED ──────────────────────
  console.log('▶ Attempt 1: read_file(private/secret.txt)  [EXPECT: DENIED]');
  const denyResult = await callTool(clientSide, 'read_file', { path: privateFilePath }, 2);

  if (denyResult?.isError === true) {
    const msg = denyResult.content?.[0]?.text ?? '(no message)';
    console.log(`  ✗ DENIED — ${msg}`);
  } else {
    console.error('  ✗ UNEXPECTED ALLOW — enforcement failed!');
    process.exitCode = 1;
  }
  console.log();

  // ── 9. Attempt: allowed.txt — EXPECT OK ─────────────────────────────────
  console.log('▶ Attempt 2: read_file(allowed.txt)         [EXPECT: OK]');
  const allowResult = await callTool(clientSide, 'read_file', { path: allowedFilePath }, 3);

  if (!allowResult?.isError) {
    const text = allowResult?.content?.[0]?.text ?? '(empty)';
    console.log(`  ✓ OK — "${text.trim()}"`);
  } else {
    const msg = allowResult?.content?.[0]?.text ?? allowResult?.message ?? '(no message)';
    console.error(`  ✗ UNEXPECTED DENY — ${msg}`);
    process.exitCode = 1;
  }
  console.log();

  // ── 10. Clean up ─────────────────────────────────────────────────────────
  await proxy.close();

  console.log(sep);
  if (process.exitCode) {
    console.log('  DEMO FAILED — see errors above');
  } else {
    console.log('  DEMO COMPLETE — keyless, deterministic ✓');
  }
  console.log(sep);
}

main().catch((err) => {
  console.error('\nDemo crashed:', err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
