# @gatewarden/govern

The lease-governance engine behind [`@gatewarden/gateway`](https://www.npmjs.com/package/@gatewarden/gateway):
a local-first broker that issues **time-bounded, narrowly-scoped capability leases**
to AI agents, and an in-path enforcement proxy for MCP tool calls. Leases are
PASETO v4.public signed, policy is deny-by-default, and every event goes to a
hash-chained audit log.

This package is the **library** entry point (`main: dist/index.js`, no CLI). It is
vendored byte-identically from [`leasebroker`](https://www.npmjs.com/package/leasebroker),
which is the standalone product with the command line (`npx leasebroker --help`).
A drift guard in this repo's CI keeps the two copies of the engine identical.

## Install

```bash
npm install @gatewarden/govern
# or
bun add @gatewarden/govern
```

## What it exports

`Broker`, `LeaseEnforcer`, `LeasebrokerProxy`, `PasetoV4PublicSigner`,
`generateKeyPair`, `DeclarativePolicyEngine`, `loadRules`, the in-memory audit sink,
revocation list, pending store and spend ledger, `parseStoredAuditJsonl`, the
contract types, and the A2A lease extension. See `src/index.ts` for the full list.

## Where to go

- Governing and scoring an MCP server from one process: [`@gatewarden/gateway`](https://www.npmjs.com/package/@gatewarden/gateway).
- A lease broker you run yourself, with the CLI (`request`, `serve`, `approve`, `revoke`, `audit`): [`leasebroker`](https://www.npmjs.com/package/leasebroker).
- Design decisions and the shared-engine rules: `docs/adrs.md` in the [gatewarden repository](https://github.com/TomCruiseTorpedo/gatewarden).

## License

Apache-2.0.
