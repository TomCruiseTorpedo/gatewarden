# ADRs — gatewarden

> Load-bearing decisions for the MCP Gateway (fleet run #3). Status legend: ACCEPTED (committed), PROPOSED (pending). Operator-confirmed 2026-06-07 unless noted.

## ADR-0 — Reuse model: re-home both cores into a bun workspace — ACCEPTED (proven)

**Decision.** Vendor `mcp-fit` (run #1) and `leasebroker` (run #2) **verbatim** into a bun workspace as `packages/score` and `packages/govern`; build the gateway as a third package `packages/gateway` that depends on both. Do **not** import them as published/git dependencies.

**Why not import-as-dep.** Neither prior repo publishes an `exports` map, neither is on npm, and both were PRIVATE GitHub repos at decision time (both have since been made public). A git/npm dependency would force repo-scoped auth on every fleet polecat and CI runner, couple versions, and *still* require export-surface work on both. Re-home avoids all of that and is version-locked.

**Why verbatim (not refactor-merge).** Run #3's stress axis is composition; the goal is to prove two existing contracts compose behind one seam without re-paying the divergence tax. Copying verbatim preserves both proven test suites (a green run *certifies* the copy) and confines all synthesis risk to the small new `packages/gateway`. Workspace isolation even lets each core keep its own TypeScript version.

**Proven.** After re-home: `@gatewarden/govern` 221 tests (9 files) + `@gatewarden/score` 174 tests (9 files) = **395 green**; `tsc --noEmit` = 0 in both; SDK unified to `^1.29`. Re-home certified before any fleet bead. (An earlier count reported score at 348 — a stale `dist/` build was double-counting the suite; the integration pass excluded test files from emit and corrected the count.)

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

## ADR-H — A2A downstream lane: score-at-attach + govern-every-send, one SDK seam — ACCEPTED

**Decision.** A2A support lands as a PARALLEL lane (`packages/gateway/src/a2a/`), leaving the MCP `DownstreamSpec`/config union untouched: `attachA2aSnapshot` fetches the RAW card (never through the SDK's auto-translating resolver — the scorecard must reflect the served document), scores it via the vendored card scorer (structural signature tier), and freezes an `A2aGatewaySnapshot`; `GovernedA2aDownstream` gates every outbound send BEFORE any wire traffic — baseline action = `http.call` to the agent's interface URL (leases scope WHICH agents may be delegated to via the existing endpoint allow-list; no new capability kinds), optional `spend` extracted from DataParts (present-but-malformed denies outright), the lease riding per the govern lane's W3 profile (metadata + extensions + `A2A-Extensions` service parameter). `generateAgentCard` maps the governed MCP tool surface to skills mechanically (name→id/name, description synthesized when absent, tags from the mapping kind, `inputSchema` drops out — A2A skills carry no parameter schema).

**SDK.** `@a2a-js/sdk@1.0.0-beta.0` pinned EXACTLY, imported only under `src/a2a/` — the single re-pin point at 1.0 GA. Never `@latest` (0.3.x implements spec v0.3).

**Deferred.** The full upstream A2A server face (task store, non-declinable `ListTasks` + pagination/authz, version negotiation, lease-binding ingress, card re-signing keys) — a new ingress subsystem, not an adapter; it gets its own workstream, and the config-union merge waits for it.

**Why.** Composes the trilogy one protocol layer up: score what a remote agent DECLARES (card), govern what a delegation may DO (lease), through the same gateway posture. The parallel-lane shape keeps the shipped MCP surface and config schema stable while the beta SDK churns.

## ADR-I — A2A upstream server face: implement one AgentExecutor over the SDK server — ACCEPTED

**Context.** The W4 (ADR-H) deferral cited C7: the upstream A2A face is "a new ingress subsystem, not an adapter" — task store, non-declinable `ListTasks` with pagination + authz, `A2A-Version` negotiation, §5.4 error mapping. That verdict predated inspecting `@a2a-js/sdk@1.0.0-beta.0`'s `./server` module, which ships exactly that subsystem: `DefaultRequestHandler` (task store + ListTasks + version negotiation + error mapping), `InMemoryTaskStore`, `JsonRpcTransportHandler`, and the `AgentExecutor` extension point.

**Decision.** The face is ONE `GatewardenAgentExecutor implements AgentExecutor` (`src/a2a/server-face.ts`) plus a thin `buildA2aServerFace` that assembles it with the SDK's `DefaultRequestHandler` + `JsonRpcTransportHandler` and the generated card. The executor runs the W3 ingress ladder verbatim — `requestedExtensions` (from `ServerCallContext`, the `A2A-Extensions` header) gates stage 1, the message-metadata lease token + `enforcer.check` on the resolved Action gate stages 2-4 — then forwards permitted calls to the shared downstream MCP client and publishes the result task. Deny paths (`rejected` / `auth-required`, the W3 pins) publish a terminal task and never touch the downstream. v1 invocation convention: a DataPart `{ tool, arguments }` (A2A skills carry no parameter schema — C5 — so the call shape travels as structured data). JSON-RPC binding only; streaming / push / extended-card declined (the generated card advertises none).

**Alternatives considered.** Hand-roll the task store + ListTasks + version negotiation (the original C7 assumption) — rejected: the SDK does it, and reimplementing a security-sensitive pagination/authz surface is strictly worse. Wrap `GatewardenProxy` (the MCP-serving proxy) — rejected: that serves the MCP protocol to clients; this serves A2A. They share the downstream client, not the server side.

**Consequences.** The face is a bounded module, not a subsystem — C7's cost estimate was SDK-version-stale. HTTP endpoint wiring (mounting `transport.handle()` on a route) is the remaining integration step, left to the deployer; `DefaultRequestHandler`'s own `getAuthenticatedExtendedAgentCard` / push-notification hooks stay unused in v1. Card re-signing (a signed served card) still needs a gateway signing key — deferred with the HTTP wiring. The executor is the only server-side `@a2a-js/sdk` consumer, keeping the beta pin behind the `src/a2a/` seam.

## ADR-I addendum — HTTP mount (2026-07-05)

The ADR-I "remaining integration step" is done: `serveA2aFace` (src/a2a/http.ts) mounts the face on plain node:http — `GET /.well-known/agent-card.json` (§8.1) + `POST /a2a/v1` (JSON-RPC via the SDK's active v1 handler). `A2A-Extensions`/`A2A-Version` request headers → ServerCallContext; activated extensions echoed on the response. A pre-dispatch gate rejects extension-unaware `SendMessage` calls with `-32008` before the handler runs (the executor's stage-1 rejection remains as defence in depth); streaming responses are declined (card advertises streaming:false). `gatewarden a2a-serve <config> --interface-url <url>` wires it end-to-end. Full-stack test (src/a2a/http.test.ts) proves the whole trilogy over live HTTP: a REAL PASETO lease from the broker → carried per the W3 profile → ingress ladder → governed downstream call → COMPLETED task; out-of-scope path and garbage token both reach REJECTED with zero downstream traffic.

**SDK method-name gotcha (bench note):** the active v1 `JsonRpcTransportHandler` dispatches PascalCase RPC names (`SendMessage`/`GetTask`/`ListTasks`/`CancelTask`) with proto-JSON params (`role:"ROLE_USER"`, parts as bare `{data}`), NOT the dotted `message/send` of the legacy handler. The SendMessage result is enveloped as `{ task }` | `{ message }`; task state serializes to `"TASK_STATE_*"` strings. Card re-signing (a signed served card) is the only piece still deferred — needs a gateway signing key.
