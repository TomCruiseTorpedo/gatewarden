#!/usr/bin/env bun
/**
 * gatewarden CLI — entry point.
 *
 * Gateway commands (use a GatewayConfig file):
 *   score <config>    Score the downstream server (print scorecard, no serve)
 *   serve <config>    Start the gateway proxy
 *   rescore <config>  Fresh score of the downstream
 *
 * Govern lifecycle commands (use a state directory):
 *   request           Submit a lease request
 *   approve           Approve a pending (veto-required) request
 *   deny              Deny a pending request
 *   pending           List pending requests
 *   revoke            Revoke an active lease
 *   policy            View/manage policy rules
 *   audit             View the audit log
 *
 * Global options:
 *   --state-dir <path>   State directory for govern lifecycle (default: .gatewarden/)
 *   --help, -h           Show help
 *   --version, -v        Show version
 */

import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { loadState, resolveStateDir } from './state.js';
import { cmdScore } from './commands/score.js';
import { cmdServe } from './commands/serve.js';
import { cmdRescore } from './commands/rescore.js';
import { cmdRequest } from './commands/request.js';
import { cmdApprove } from './commands/approve.js';
import { cmdDeny } from './commands/deny.js';
import { cmdPending } from './commands/pending.js';
import { cmdRevoke } from './commands/revoke.js';
import { cmdPolicy } from './commands/policy.js';
import { cmdAudit } from './commands/audit.js';

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

function getVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req('../../package.json') as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const HELP = `
gatewarden — MCP gateway: score + govern every downstream tool call

USAGE
  gatewarden <command> [options]

GATEWAY COMMANDS
  score <config>    Score the downstream server (deterministic, keyless)
  serve <config>    Start the gateway proxy fronting a downstream MCP server
  rescore <config>  Re-score the downstream and print a fresh snapshot

GOVERN LIFECYCLE COMMANDS
  request           Submit a lease request (reads JSON from --request or stdin)
  approve <reqId>   Approve a pending (veto-required) request
  deny <reqId>      Deny a pending request
  pending           List all pending requests
  revoke <leaseId>  Revoke an active lease
  policy            View or load policy rules
  audit             View the audit log

GLOBAL OPTIONS
  --state-dir <path>   State directory for govern lifecycle (default: .gatewarden/)
                       Override with GATEWARDEN_STATE_DIR env var
  --help, -h           Show this help
  --version, -v        Show version

COMMAND HELP
  gatewarden <command> --help

EXAMPLES
  # Score the downstream server (no serve)
  gatewarden score ./gateway.config.json

  # Start the gateway proxy
  gatewarden serve ./gateway.config.json

  # Re-score the downstream
  gatewarden rescore ./gateway.config.json

  # Submit a lease request
  gatewarden request --request '{"agentId":"a1","taskId":"t1","capabilities":[{"kind":"fs.read","paths":["./data/**"]}],"requestedDurationMs":3600000}'

  # List pending requests
  gatewarden pending

  # Approve a pending request
  gatewarden approve <reqId>

  # Revoke a lease
  gatewarden revoke <leaseId>

  # View audit log
  gatewarden audit --last 20
`.trim();

const COMMAND_HELP: Record<string, string> = {
  score: `
gatewarden score <config> — score the downstream server

USAGE
  gatewarden score <config-path>

ARGUMENTS
  <config-path>   Path to a GatewayConfig JSON or JS file

OUTPUT
  GatewaySnapshot as JSON (server identity + scorecard + timestamp)

EXAMPLE
  gatewarden score ./gateway.config.json
`.trim(),

  serve: `
gatewarden serve <config> — start the gateway proxy

USAGE
  gatewarden serve <config-path>

ARGUMENTS
  <config-path>   Path to a GatewayConfig JSON or JS file

DESCRIPTION
  Wires the govern runtime from the config (policy, signer, broker, enforcer)
  and starts an enforcing MCP proxy on stdio fronting the downstream server.

EXAMPLE
  gatewarden serve ./gateway.config.json
`.trim(),

  rescore: `
gatewarden rescore <config> — fresh score of the downstream

USAGE
  gatewarden rescore <config-path>

ARGUMENTS
  <config-path>   Path to a GatewayConfig JSON or JS file

OUTPUT
  GatewaySnapshot as JSON (fresh, distinct from the attach-time snapshot)

EXAMPLE
  gatewarden rescore ./gateway.config.json
`.trim(),

  request: `
gatewarden request — submit a lease request

USAGE
  gatewarden request [--request <json>] [--rules-file <path>]
  echo '<json>' | gatewarden request

OPTIONS
  --request <json>     LeaseRequest as JSON string
  --rules-file <path>  Path to policy rules JSON file

OUTPUT (JSON)
  { "type": "granted", "token": "...", "leaseId": "..." }
  { "type": "pending", "reqId": "..." }
  { "type": "denied", "reason": "..." }

EXAMPLE
  gatewarden request --request '{"agentId":"a1","taskId":"t1","capabilities":[{"kind":"fs.read","paths":["./data/**"]}],"requestedDurationMs":3600000}'
`.trim(),

  approve: `
gatewarden approve <reqId> — approve a pending request

USAGE
  gatewarden approve <reqId>

EXAMPLE
  gatewarden approve 550e8400-e29b-41d4-a716-446655440000
`.trim(),

  deny: `
gatewarden deny <reqId> — deny a pending request

USAGE
  gatewarden deny <reqId>

EXAMPLE
  gatewarden deny 550e8400-e29b-41d4-a716-446655440000
`.trim(),

  pending: `
gatewarden pending — list pending requests awaiting approval

USAGE
  gatewarden pending

OUTPUT
  JSON array of { reqId, request } objects
`.trim(),

  revoke: `
gatewarden revoke <leaseId> — revoke an active lease

USAGE
  gatewarden revoke <leaseId>

EXAMPLE
  gatewarden revoke 550e8400-e29b-41d4-a716-446655440000
`.trim(),

  policy: `
gatewarden policy — view or manage policy rules

SUBCOMMANDS
  gatewarden policy show [--rules-file <path>]   Print current rules
  gatewarden policy load --rules-file <path>     Load rules into state dir

OPTIONS
  --rules-file <path>   Path to a JSON file containing an array of PolicyRule objects

EXAMPLE
  gatewarden policy show
  gatewarden policy load --rules-file ./policy.json
`.trim(),

  audit: `
gatewarden audit — view the audit log

USAGE
  gatewarden audit [--last <n>] [--type <type>] [--verify]

OPTIONS
  --last <n>      Show only the last N events
  --type <type>   Filter by event type (request|decision|issuance|use|denial|revocation)
  --verify        Verify hash chain integrity only (no output)

EXAMPLE
  gatewarden audit --last 20
  gatewarden audit --type issuance
  gatewarden audit --verify
`.trim(),
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    console.log(HELP);
    return;
  }

  if (argv[0] === '--version' || argv[0] === '-v') {
    console.log(getVersion());
    return;
  }

  const command = argv[0]!;
  const rest = argv.slice(1);

  // Command-level help.
  if (rest.includes('--help') || rest.includes('-h')) {
    const helpText = COMMAND_HELP[command];
    if (helpText !== undefined) {
      console.log(helpText);
    } else {
      console.log(HELP);
    }
    return;
  }

  // Parse global --state-dir from rest before command-specific parsing.
  let stateDir: string | undefined;
  const stateDirIdx = rest.indexOf('--state-dir');
  if (stateDirIdx !== -1 && stateDirIdx + 1 < rest.length) {
    stateDir = rest[stateDirIdx + 1];
  }

  const resolvedStateDir = resolveStateDir(stateDir);

  switch (command) {
    // ── Gateway commands ────────────────────────────────────────────────────

    case 'score': {
      const { positionals } = parseArgs({
        args: rest,
        options: { 'state-dir': { type: 'string' as const } },
        allowPositionals: true,
        strict: false,
      });
      const configPath = positionals[0];
      if (!configPath) {
        console.error('Error: score requires a <config-path> argument');
        process.exit(1);
      }
      await cmdScore({ configPath });
      break;
    }

    case 'serve': {
      const { positionals } = parseArgs({
        args: rest,
        options: { 'state-dir': { type: 'string' as const } },
        allowPositionals: true,
        strict: false,
      });
      const configPath = positionals[0];
      if (!configPath) {
        console.error('Error: serve requires a <config-path> argument');
        process.exit(1);
      }
      await cmdServe({ configPath });
      break;
    }

    case 'rescore': {
      const { positionals } = parseArgs({
        args: rest,
        options: { 'state-dir': { type: 'string' as const } },
        allowPositionals: true,
        strict: false,
      });
      const configPath = positionals[0];
      if (!configPath) {
        console.error('Error: rescore requires a <config-path> argument');
        process.exit(1);
      }
      await cmdRescore({ configPath });
      break;
    }

    // ── Govern lifecycle commands ───────────────────────────────────────────

    case 'request': {
      const { values } = parseArgs({
        args: rest,
        options: {
          request: { type: 'string' as const },
          'rules-file': { type: 'string' as const },
          'state-dir': { type: 'string' as const },
        },
        strict: false,
      }) as { values: Record<string, string | undefined> };
      const state = loadState(resolvedStateDir);
      await cmdRequest(state, {
        request: values['request'],
        rulesFile: values['rules-file'],
      });
      break;
    }

    case 'approve': {
      const { positionals } = parseArgs({
        args: rest,
        options: {
          'state-dir': { type: 'string' as const },
          'rules-file': { type: 'string' as const },
        },
        allowPositionals: true,
        strict: false,
      });
      const reqId = positionals[0];
      if (!reqId) {
        console.error('Error: approve requires a <reqId> argument');
        process.exit(1);
      }
      const state = loadState(resolvedStateDir);
      cmdApprove(state, { reqId });
      break;
    }

    case 'deny': {
      const { positionals } = parseArgs({
        args: rest,
        options: {
          'state-dir': { type: 'string' as const },
          'rules-file': { type: 'string' as const },
        },
        allowPositionals: true,
        strict: false,
      });
      const reqId = positionals[0];
      if (!reqId) {
        console.error('Error: deny requires a <reqId> argument');
        process.exit(1);
      }
      const state = loadState(resolvedStateDir);
      cmdDeny(state, { reqId });
      break;
    }

    case 'pending': {
      const state = loadState(resolvedStateDir);
      cmdPending(state);
      break;
    }

    case 'revoke': {
      const { positionals } = parseArgs({
        args: rest,
        options: { 'state-dir': { type: 'string' as const } },
        allowPositionals: true,
        strict: false,
      });
      const leaseId = positionals[0];
      if (!leaseId) {
        console.error('Error: revoke requires a <leaseId> argument');
        process.exit(1);
      }
      const state = loadState(resolvedStateDir);
      cmdRevoke(state, { leaseId });
      break;
    }

    case 'policy': {
      const sub = rest[0] ?? 'show';
      const policyRest = sub === 'show' || sub === 'load' ? rest.slice(1) : rest;
      const subcommand = (sub === 'show' || sub === 'load') ? sub : 'show';
      const { values } = parseArgs({
        args: policyRest,
        options: {
          'rules-file': { type: 'string' as const },
          'state-dir': { type: 'string' as const },
        },
        strict: false,
      }) as { values: Record<string, string | undefined> };
      const state = loadState(resolvedStateDir);
      cmdPolicy(state, {
        subcommand: subcommand as 'show' | 'load',
        rulesFile: values['rules-file'],
      });
      break;
    }

    case 'audit': {
      const { values } = parseArgs({
        args: rest,
        options: {
          last: { type: 'string' as const },
          type: { type: 'string' as const },
          verify: { type: 'boolean' as const },
          'state-dir': { type: 'string' as const },
        },
        strict: false,
      }) as { values: Record<string, string | boolean | undefined> };
      const state = loadState(resolvedStateDir);
      cmdAudit(state, {
        last: values['last'] !== undefined ? parseInt(values['last'] as string, 10) : undefined,
        type: values['type'] as Parameters<typeof cmdAudit>[1]['type'],
        verify: values['verify'] as boolean | undefined,
      });
      break;
    }

    default: {
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      process.exit(1);
    }
  }
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
