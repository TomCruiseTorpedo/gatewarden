# gatewarden

One in-path **MCP gateway** that, for a downstream MCP server, both **scores** its agent-usability and **governs** every tool call with capability leases — from one process, one config. It fuses two prior tools behind a single seam:

- **score** — agent-usability scorer (introspect → lint → `Scorecard`).
- **govern** — capability-lease broker + in-path enforcement proxy (signed, scoped, time-boxed leases; deny-by-default; hash-chained audit).

Point it at a downstream server and you get a usability scorecard **and** least-privilege, audited enforcement in one flow.

## Workspace layout

| package | role |
|---|---|
| `@gatewarden/score` | introspect + lint + score a downstream MCP server |
| `@gatewarden/govern` | leases, signing (PASETO v4.public), policy, audit, per-call enforcer |
| `@gatewarden/gateway` | the fusion: score-at-attach snapshot + in-path lease enforcement |

The two cores are vendored verbatim from their standalone repos — [mcp-fit](https://github.com/TomCruiseTorpedo/mcp-fit) (score) and [leasebroker](https://github.com/TomCruiseTorpedo/leasebroker) (govern); the gateway is the thin composition over them.

## Quick demo (keyless)

- `bun install`
- `bun run demo`

The demo fronts the reference filesystem MCP server, prints its agent-usability scorecard (deterministic — no API key needed), then proves enforcement in the same flow: an out-of-scope read of `private/secret.txt` is denied by the lease scope, while the in-scope read of `allowed.txt` succeeds.

## CLI

- `bun run build`
- `bun packages/gateway/dist/cli/index.js --help`

Gateway commands (`score`, `serve`, `rescore`) plus the full lease lifecycle (`request`, `approve`, `deny`, `pending`, `revoke`, `policy`, `audit`).

## Develop

- `bun install`
- `bun run test` — runs all package suites (vitest)
- `bun run typecheck` — `tsc --noEmit` across the workspace
- `bun run build` — compile all packages

## Design

- Spec: `specs/gatewarden/spec.md`
- Decisions: `docs/adrs.md`
- Plan + decomposition: `plan.md`, `BEADS.md`

## Status

v0.1.0 — built and certified from a fresh clone: 510 tests across the workspace (score 174, govern 221, gateway 115), typecheck and build green in all three packages, keyless demo green, CI green.

## License

Apache-2.0.
