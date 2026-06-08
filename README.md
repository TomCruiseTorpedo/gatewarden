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

The two cores are vendored from prior work and kept verbatim; the gateway is the thin composition over them.

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

Scaffold + design committed; the cores' suites are green (score 348, govern 221). The gateway package is being built bead-by-bead per `BEADS.md` (contract-first).

## License

Apache-2.0.
