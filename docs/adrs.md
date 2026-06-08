# ADRs — gatewarden

> Load-bearing decisions for the MCP Gateway (fleet run #3). Status legend: ACCEPTED (committed), PROPOSED (pending). Operator-confirmed 2026-06-07 unless noted.

## ADR-0 — Reuse model: re-home both cores into a bun workspace — ACCEPTED (proven)

**Decision.** Vendor `mcp-fit` (run #1) and `leasebroker` (run #2) **verbatim** into a bun workspace as `packages/score` and `packages/govern`; build the gateway as a third package `packages/gateway` that depends on both. Do **not** import them as published/git dependencies.

**Why not import-as-dep.** Neither prior repo publishes an `exports` map, neither is on npm, and both are PRIVATE GitHub repos. A git/npm dependency would force repo-scoped auth on every fleet polecat and CI runner, couple versions, and *still* require export-surface work on both. Re-home avoids all of that and is version-locked.

**Why verbatim (not refactor-merge).** Run #3's stress axis is composition; the goal is to prove two existing contracts compose behind one seam without re-paying the divergence tax. Copying verbatim preserves both proven test suites (a green run *certifies* the copy) and confines all synthesis risk to the small new `packages/gateway`. Workspace isolation even lets each core keep its own TypeScript version.

**Proven.** After re-home: `@gatewarden/govern` 221 tests (9 files) + `@gatewarden/score` 348 tests (18 files) = **569 green**; `tsc --noEmit` = 0 in both; SDK unified to `^1.29`. Re-home certified before any fleet bead.

**Consequences.** `score` keeps `ajv`+`@anthropic-ai/sdk`; `govern` keeps `zod@4`+`@noble/ed25519`. The two `ServerMeta`/proxy notions are NOT merged in v1 — the gateway adapts between them at its own seam (ADR-A). A later "refactor-merge" pass (unify the two proxies) is deferred and explicitly out of scope.

## ADR-A — Composition seam: a small gateway contract that adapts both cores — ACCEPTED

**Decision.** `packages/gateway/src/contract/` defines the unified shapes and lands **Wave-0-alone** (contract-first, the run #1/#2 lesson): `GatewayConfig`, `DownstreamSpec`, `GatewaySnapshot`, `ToolActionMapping`, plus a pure `buildToolActionResolver(mapping)` that produces `govern`'s `ToolActionResolver`. It imports `Scorecard`/`ServerMeta` from `score` and `Action`/`Lease`/`PolicyRule`/`Enforcer`/`AuditSink`/`ToolActionResolver` from `govern`; it re-defines nothing those cores already own.

**Why.** The composition is the product. Pinning the seam first (one declarative config + one snapshot shape + one tool→Action mapping) is what stops the consumer beads (scoring, enforcement, CLI, demo) from inventing divergent glue. `GatewaySnapshot = { server: ServerMeta, scorecard: Scorecard, attachedAt }` is the bridge between score's world and govern's world.

## ADR-B — Scoring mode: on-demand deterministic snapshot + manual rescore — ACCEPTED

**Decision.** Score is computed at **attach** (and on explicit `rescore`), using `score`'s **deterministic lint path only** (`scoreLintOnly`) — keyless, no LLM, zero per-call latency. The snapshot is **immutable**; enforcement never re-scores in-path. LLM-eval scoring is opt-in, off by default.

**Why.** Mirrors `govern`'s load-bearing design invariant (immutable signed artifact vs mutable runtime state): here the **score snapshot is the immutable artifact**, the **enforcement state (spend/revocation) is the live state**. Deterministic scoring also makes the demo and CI keyless and fully reproducible — matching `score`'s own keyless red→green fixture lesson. Continuous in-path scoring was rejected: it adds latency to the hot path and blurs the snapshot/state boundary.

## ADR-C — Enforcement reuse: new GatewardenProxy over govern's LeaseEnforcer — ACCEPTED

**Decision.** The gateway writes a new `GatewardenProxy` (in `packages/gateway`) that reuses `govern`'s `LeaseEnforcer` (per-call `check(token, action)`), `Signer`, `PolicyEngine`, stores, and `AuditSink` as **logic**, and `score`'s `introspect` + `scoreLintOnly` for the attach-time snapshot. It connects **one** downstream `Client`, scores it once, then serves an enforcing MCP `Server` against that same client.

**Why.** `govern`'s `LeasebrokerProxy` already is an in-path enforcing proxy, but it constructs its own downstream client internally and has no score step — and `govern` is vendored verbatim (ADR-0), so we do not edit it. The gateway re-implements the thin proxy orchestration to (a) add score-at-attach, (b) share one downstream client between scorer and enforcer, (c) expose the snapshot. This is the *only* genuinely new runtime code — the synthesis itself.

## ADR-D — Routing scope: single downstream in v1 — ACCEPTED

**Decision.** v1 fronts exactly one downstream MCP server. A config naming more than one is rejected with an explicit "multi-server not supported in v1" error. The multi-server routing seam (per-server snapshot + policy) is documented for v2, not stubbed.

**Why.** Keeps the bead set scoped and matches both prior runs' single-target demos. Multi-server would widen the synthesis run past the capstone proof.

## ADR-E — Demo target: filesystem server, keyless red→green — ACCEPTED

**Decision.** The demo fronts `@modelcontextprotocol/server-filesystem` and shows, in one flow with no API key: a deterministic scorecard for the server, an over-privileged read of `private/` DENIED by lease scope, and an in-scope read that succeeds.

**Why.** Reuses `govern`'s proven fs path-scope fixture and `score`'s keyless determinism; one real downstream demonstrates both halves fused. (A spend-cap variant over a mock API server is a v1.1 nicety, not required for the capstone.)

## ADR-F — Config validation: zod@4 — ACCEPTED

**Decision.** `GatewayConfig` is validated with `zod@4` (already a `govern` dependency). `score` keeps `ajv` for its own JSON-Schema artifacts; the gateway does not adopt ajv.

**Why.** The gateway config is governance-adjacent (it carries `PolicyRule[]` and `Action` mappings that are govern's zod-typed shapes); using one validator at the gateway seam avoids a second schema dialect in new code.

## ADR-G — MCP SDK: pin `@modelcontextprotocol/sdk@^1.29` (v1) — ACCEPTED

**Decision.** The whole workspace pins `@modelcontextprotocol/sdk` to `^1.29.x` (v1). Enforcement relies on `extra.sessionId` from the v1 low-level `setRequestHandler` API. Do not adopt the v2 migration branch (`ctx`).

**Why.** `govern`'s session→lease binding is built on v1 `extra.sessionId`; `score` was on `^1.0` and bumped to `^1.29` during re-home with tests green. One SDK version hoists cleanly across the workspace.
