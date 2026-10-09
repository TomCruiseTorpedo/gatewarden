# @gatewarden/gateway

One in-path **MCP gateway** that scores a downstream MCP server's agent-usability
and governs every tool call with capability leases — from a single process, one config.

Fuses `@gatewarden/score` (deterministic + LLM usability scorer) and
`@gatewarden/govern` (PASETO-signed leases, deny-by-default policy, hash-chained audit).

## Install

```sh
bun add @gatewarden/gateway
```

## Quickstart

### 1. Write a config file

```json
{
  "downstream": {
    "kind": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
  },
  "policy": [],
  "toolActions": [
    { "toolName": "read_file",  "kind": "fs.read",  "pathArg": "path" },
    { "toolName": "write_file", "kind": "fs.write", "pathArg": "path" }
  ]
}
```

### 2. Score the downstream (keyless, no API key needed)

```sh
gatewarden score ./gateway.config.json
```

Prints a `GatewaySnapshot` — server identity, deterministic scorecard, timestamp.

### 3. Start the enforcing proxy

```sh
gatewarden serve ./gateway.config.json
```

Starts an MCP server on stdio. Clients must supply a signed lease token in
`_meta['x-lease-token']` at the `initialize` handshake. Unmapped tools pass
through; mapped tools are enforced by the lease.

`serve` and `a2a-serve` take their signing key, revocations, spend ledger and
audit log from the state directory (`--state-dir`, `GATEWARDEN_STATE_DIR`, or
`.gatewarden/`), the same one `gatewarden request` and `gatewarden revoke` use.
A lease minted by `request` therefore verifies in the running gateway, and a
lease revoked from another process is refused on the very next call. A first run
creates the key in that directory; keep it private. Spend is charged against
`spend.json` under a lock file as it happens, so several gateways on one state
directory (stdio `serve` runs once per client) share one cap instead of each
spending the full amount; if the lock cannot be taken in time the charge is
refused. On shutdown the gateway merges only its own audit events back, so it
never undoes a `revoke` or drops events written meanwhile. It refuses to start on an audit log that fails
stored hash-chain verification (`gatewarden audit --verify`). Programmatic use
(below) wires its own key per `wireGovern(config)` call unless you pass it
persisted state.

Commands that change state (`request`, `approve`, `deny`, `revoke`, `policy load`)
run as one transaction under `state.lock` in the state directory, so concurrent
commands queue instead of overwriting each other. Without that, each command saved
the snapshot it had loaded over the others' changes: with 12 `revoke` and 12
`request` run at once, about half the revocations and audit events were lost.
Reads (`audit`, `pending`, `policy show`) do not wait; every write replaces its file
atomically, so a reader sees a whole old file or a whole new one. If a command
reports that another command is using the state directory, retry; if nothing is
running, the lock is left over and can be removed. Keep the state directory on a
local filesystem: the lock needs an atomic exclusive file create.

`a2a-serve` fronts the same governed tools as an A2A agent over HTTP
(`gatewarden a2a-serve ./gateway.config.json --interface-url <public url>`). By
default it follows the A2A lease profile's context binding: the first message on
a `contextId` that presents a valid token binds the context, and later messages
on it may omit the token. The face authenticates no caller, so a bound
`contextId` then acts as a bearer: anyone who sends it, tokenless, gets that
lease's authority. It listens on `127.0.0.1` unless you pass `--host`. Pass
`--require-token-per-message` to remove that: nothing is bound, and every message
must carry its own token, which is verified (signature, expiry, revocation,
scope) each time. The startup banner states which posture is active.

### 4. Use programmatically

```ts
import { loadConfig, wireGovern, GatewardenProxy } from '@gatewarden/gateway';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const config  = await loadConfig('./gateway.config.json');
const bundle  = wireGovern(config);
const proxy   = new GatewardenProxy(bundle);

const downstream = new StdioClientTransport({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] });
const upstream   = new StdioServerTransport();

const snapshot = await proxy.attach(upstream, downstream);
console.log('Score:', snapshot.scorecard.lintScore);
```

## Public API

| Export | Description |
|---|---|
| `GatewardenProxy` | Fused scoring + enforcement proxy. `attach(client, downstream)` → `GatewaySnapshot`. |
| `loadConfig(path)` | Load + validate a `GatewayConfig` from a JSON or JS file. |
| `ConfigLoadError` | Typed error thrown by `loadConfig` (codes: `FILE_NOT_FOUND`, `PARSE_ERROR`, `VALIDATION_ERROR`). |
| `wireGovern(config)` | Build the full govern runtime (`GovernBundle`) from a validated config. |
| `attachSnapshot(client, opts?)` | Score a downstream MCP client → immutable `GatewaySnapshot`. |
| `rescore(client, opts?)` | Fresh score — always returns a new snapshot (never mutates). |
| `buildToolActionResolver(mappings)` | Build a `ToolActionResolver` from `ToolActionMapping[]`. |
| `GatewayConfigSchema` | Zod schema for the config file format. |
| `ToolActionMappingSchema` | Zod schema for a single tool-action mapping. |
| `DownstreamSpecSchema` | Zod schema for a downstream transport spec. |

All contract types (`GatewayConfig`, `GatewaySnapshot`, `ToolActionMapping`, etc.) are
re-exported as TypeScript types.

## CLI

```
gatewarden score   <config>   # Score + print snapshot (no serve)
gatewarden serve   <config>   # Start enforcing proxy on stdio
gatewarden rescore <config>   # Fresh score + print

gatewarden request            # Submit a lease request
gatewarden approve <reqId>    # Approve a pending request
gatewarden deny    <reqId>    # Deny a pending request
gatewarden pending            # List pending requests
gatewarden revoke  <leaseId>  # Revoke an active lease
gatewarden policy  show       # View policy rules
gatewarden audit              # View audit log
```

## Design

- [Spec](../../specs/gatewarden/spec.md)
- [ADRs](../../docs/adrs.md)

## License

Apache-2.0
