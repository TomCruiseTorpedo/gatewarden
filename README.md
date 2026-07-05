# gatewarden

One in-path **gateway** that, for a downstream MCP server — or a remote **A2A agent** — both **scores** what it exposes and **governs** every call with capability leases — from one process, one config. It fuses two prior tools behind a single seam:

- **score** — agent-usability scorer (introspect → lint → `Scorecard`; A2A Agent Card lint, signature verify + sign).
- **govern** — capability-lease broker + in-path enforcement proxy (signed, scoped, time-boxed leases; deny-by-default; hash-chained audit; A2A lease extension).

Point it at a downstream server and you get a usability scorecard **and** least-privilege, audited enforcement in one flow. Point it at a remote A2A agent and you get the same posture one protocol layer up — and it can serve its own governed tool surface *as* an A2A agent.

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

`@gatewarden/govern` also ships a standalone CLI (`packages/govern/dist/cli/index.js`) for the lease lifecycle without the gateway layer.

Full scoring (the behavioural eval axes) needs `ANTHROPIC_API_KEY`; the keyless demo and the deterministic lint axes do not.

## A2A: score + govern remote agents

The same posture, one protocol layer up ([A2A](https://a2a-protocol.org/) v1.0; ADR-H/ADR-I):

- `a2a-attach <cardUrl>` — read-only attach to a remote agent: fetch its RAW
  Agent Card, score it (7 deterministic card axes + signature report), write
  `card-compat.json`. `--verify-keys <jwks.json>` / `--verify-jku` add the
  cryptographic verification tiers.
- `a2a-card <config> --interface-url <url>` — generate this gateway's own
  Agent Card from its governed MCP tool surface (skills 1:1 with tools; the
  lease extension declared `required: true`). Dogfood-gated: never emits a
  card its own vendored scorer finds errors in. `--signing-key` emits it signed.
- `a2a-serve <config> --interface-url <url>` — serve the governed surface as a
  **live A2A agent**: well-known card + JSON-RPC endpoint. Every inbound
  message runs the lease ingress ladder (extension declared → lease verified →
  veto → allow) before any downstream tool call; deny paths never touch the
  downstream. `--signing-key` serves a SIGNED card and mounts
  `/.well-known/jwks.json`.
- `a2a-keygen --out <dir>` — mint the card-signing key pair (private JWK
  written mode 0600 + publishable `jwks.json`).

Outbound delegation is governed too: `GovernedA2aDownstream` gates every send
as an `http.call` on the remote agent's endpoint (leases scope *which agents
may be delegated to*), carries the lease per the
[leasebroker A2A extension profile](https://github.com/TomCruiseTorpedo/leasebroker/blob/main/docs/a2a-lease-extension-v1.md),
and optionally enforces `spend` extracted from DataParts.

## Develop

- `bun install`
- `bun run test` — runs all package suites (vitest)
- `bun run typecheck` — `tsc --noEmit` across the workspace
- `bun run build` — compile all packages
- `bun run --filter '@gatewarden/score' check:score-sync` — verify the vendored score engine hasn't drifted from its mcp-fit upstream (CI enforces this)

## Design

- Spec: `specs/gatewarden/spec.md`
- Decisions: `docs/adrs.md`
- Plan + decomposition: `plan.md`, `BEADS.md`

## Status

**On `main`:** the full MCP gateway plus the A2A lane — 622 tests across the
workspace (score 237, govern 240, gateway 145), typecheck and build green in
all three packages, keyless demo green, CI green.

**On npm:** `@gatewarden/score` / `@gatewarden/govern` / `@gatewarden/gateway`
at **0.1.0**, which predates the A2A lane (attach, card generation/signing,
the A2A server face, and the a2a-* commands are `main`-only until the next
release). The private root workspace stays `0.0.0`.

## License

Apache-2.0.
