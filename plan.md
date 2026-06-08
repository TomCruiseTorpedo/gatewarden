# Plan — gatewarden (HOW)

> Implementation plan for the MCP Gateway. Spec: `specs/gatewarden/spec.md`. Decisions: `docs/adrs.md`. Decomposition: `BEADS.md`. Stack: TypeScript strict + bun + vitest + zod@4, `@modelcontextprotocol/sdk@^1.29`.

## Architecture

A bun workspace (`packages/*`). Two cores are **vendored verbatim and already green** (ADR-0); only `packages/gateway` is built by the fleet.

| package | origin | role | status |
|---|---|---|---|
| `@gatewarden/score` | mcp-fit (run #1) | introspect + lint + score a downstream → `Scorecard` | vendored, 348 tests green |
| `@gatewarden/govern` | leasebroker (run #2) | leases, signing, policy, audit, per-call `Enforcer` | vendored, 221 tests green |
| `@gatewarden/gateway` | NEW | fuse both behind one in-path proxy | to build |

### The fused flow

Client → `[GatewardenProxy server side]` → `LeaseEnforcer.check` → `[downstream Client]` → downstream MCP server. At attach, the same downstream Client is first introspected and scored once (deterministic, keyless) into an immutable `GatewaySnapshot`; thereafter every mapped `tools/call` is gated by the enforcer (live state), and unmapped tools pass through (logged).

The gateway has **two** immutable-snapshot-vs-live-state splits — `govern`'s (Lease immutable; spend/revocation live) plus the new one (Scorecard snapshot immutable; enforcement state live). This is the direct extension of run #2's design lesson #7.

### The composition contract (`packages/gateway/src/contract/`, ADR-A)

- `DownstreamSpec` — `{ transport: 'stdio'|'http'|'sse', command?, args?, url? }`. v1 demo = stdio.
- `ToolActionMapping` — declarative: tool name → which arg carries the path/endpoint/amount, and which `Action.kind` it maps to. Drives `buildToolActionResolver()` → `govern`'s `ToolActionResolver`.
- `GatewayConfig` — `{ downstream: DownstreamSpec, policy: PolicyRule[], toolActions: ToolActionMapping[], scoring?: { eval?: boolean } }`, zod-validated; rejects >1 downstream (R9).
- `GatewaySnapshot` — `{ server: ServerMeta, scorecard: Scorecard, attachedAt: string }`, immutable.
- Re-exports only — never redefines core-owned types (`Action`, `Lease`, `PolicyRule`, `Enforcer`, `AuditSink`, `ToolActionResolver`, `Scorecard`, `ServerMeta`).

### Disjoint lanes (one owner each — no shared files across beads)

1. **contract** — `src/contract/` (types, zod schemas, `buildToolActionResolver`). The base.
2. **config** — `src/config/` (load + validate `GatewayConfig`; build the `govern` wiring: Signer, PolicyEngine, stores, Broker, LeaseEnforcer + the resolver).
3. **scoring** — `src/scoring/` (attach-time: connect downstream via `score` transports, `introspect`, `scoreLintOnly` → `GatewaySnapshot`; `rescore`).
4. **proxy** — `src/proxy/` (`GatewardenProxy`: one shared client, score-at-attach, enforce-each-call, expose snapshot).
5. **cli** — `src/cli/` (`gatewarden` bin: `score`/`serve`/`rescore` + surface govern's `request`/`approve`/`deny`/`pending`/`revoke`/`policy`/`audit`).
6. **fixtures+demo** — `fixtures/` + `scripts/demo.mjs` (fs server, keyless red→green).
7. **integration** — `src/index.ts` barrel + smoke test + README; first-class, independently verified.

## Wave graph (contract-first)

- **Wave 0 (alone):** `gateway-001` contract.
- **Wave 1 (parallel):** `gateway-002` config, `gateway-003` scoring. (Disjoint: govern-wiring vs score-wiring.)
- **Wave 2:** `gateway-004` proxy (needs 002 enforcer + 003 snapshot).
- **Wave 3 (parallel):** `gateway-005` cli, `gateway-006` fixtures+demo. (Both need 004.)
- **Wave 4:** `gateway-007` integration (needs all; independently verified, NOT self-report).

Rolling local integration base advances per wave via `refs/remotes/origin/integration` (no per-wave GitHub push — run #2 lesson #3). gt does per-bead execution (`--merge=local`); Sapling owns linearize + stack + land.

## Traceability (requirement → bead)

| Req | Bead(s) |
|---|---|
| R1 unified attach | 004 |
| R2 keyless snapshot | 003 |
| R3 snapshot immutability / rescore | 003, 004 |
| R4 deny-by-default enforcement | 002, 004 |
| R5 unmapped passthrough | 001 (resolver), 004 |
| R6 tool→Action mapping | 001 |
| R7 audit | 002, 004 |
| R8 CLI | 005 |
| R9 single-server | 001 (schema), 002 |
| R10 demo red→green | 006 |

## Verification gates (every bead)

- `tsc --noEmit` = 0; `bun run test` (vitest) green — never `bun test` (double-counts dist).
- Independent verify-each (read the worktree, run the gate) — never the polecat's self-report.
- AgentShield scan clean (gt-scaffolded `CLAUDE.md` "Skip verification" substring is a known false positive).
- Integration bead: one canonical barrel, consumers import it, demo R10 green keyless, fresh-clone certify before land.

## Out of scope (v1)

Multi-server routing; continuous in-path scoring; LLM-eval-by-default; Cedar policy backend; non-CLI veto; the score/govern proxy-merge refactor.
