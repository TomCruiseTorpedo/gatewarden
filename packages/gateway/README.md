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
