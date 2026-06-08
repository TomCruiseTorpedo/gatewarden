# BEADS — gatewarden

> Contract-first decomposition for `packages/gateway` only (the two cores are vendored + green, ADR-0). 7 beads: 1 contract + 5 build + 1 integration. Each bead = one owner, disjoint paths, acceptance criteria, dep edges. Stack: TS strict + bun + vitest + zod@4 + SDK ^1.29. Spec `specs/gatewarden/spec.md`, plan `plan.md`, decisions `docs/adrs.md`.

> Fleet conventions (run #2 banked): `gt rig add <name> <url> --prefix <name>` then `gt rig settings set <name> role_agents.polecat pi` (NO `--polecat-agent`). `bd create` has NO `--skills` → fold into `-l labels`; `--deps` sets edges. Verify with `bun run test` NOT `bun test`. Contract bead lands Wave-0-ALONE.

---

## gateway-001 — contract (Wave 0, ALONE)
**Owns:** `packages/gateway/src/contract/` (`types.ts`, `schemas.ts`, `resolver.ts`, `index.ts`) + their tests.
**Deps:** none (base of the stack).
**Build:**
- Types: `DownstreamSpec`, `ToolActionMapping`, `GatewayConfig`, `GatewaySnapshot` (per plan §contract). Import `Scorecard`/`ServerMeta` from `@gatewarden/score`, `Action`/`Lease`/`PolicyRule`/`Enforcer`/`AuditSink`/`ToolActionResolver` from `@gatewarden/govern`. Re-export those; redefine none.
- `schemas.ts`: zod@4 schema for `GatewayConfig`; rejects >1 downstream (R9) and malformed mappings.
- `resolver.ts`: pure `buildToolActionResolver(mappings): ToolActionResolver` — given the declarative mapping, return a function mapping `(toolName, args) → Action | undefined` (undefined = unmapped → passthrough, R5; missing named arg on a mapped tool → still returns an Action that the enforcer will deny, deny-by-default R6).
**Acceptance:** types compile; zod schema accepts a valid single-downstream config and rejects multi-downstream + malformed mapping; `buildToolActionResolver` unit-tested for fs.read/fs.write/http.call/spend mapping + unmapped passthrough; `tsc`=0; vitest green; barrel re-exports the contract. Types-only + one pure fn — NO proxy/IO logic.
**Labels:** `contract`, `wave-0`, `appsec`.

## gateway-002 — config + govern wiring (Wave 1)
**Owns:** `packages/gateway/src/config/` (`loader.ts`, `wire.ts`, index) + tests.
**Deps:** `gateway-001`.
**Build:**
- `loader.ts`: load a `GatewayConfig` from a JSON/JS file, validate via the contract's zod schema (clear errors; reject multi-downstream R9).
- `wire.ts`: from a validated config, construct the `govern` runtime — `PasetoV4PublicSigner`, `DeclarativePolicyEngine` (from `config.policy`), `InMemoryAuditSink`/`RevocationList`/`SpendLedger`/`PendingStore`, `Broker`, `LeaseEnforcer`, and the `ToolActionResolver` (via `buildToolActionResolver`). Returns a wired bundle the proxy consumes.
**Acceptance:** loads a valid config + builds a working `LeaseEnforcer` that DENIES out-of-scope and ALLOWS in-scope (R4) in a unit test using a real signed lease from the wired Broker/Signer; rejects multi-downstream (R9); audit sink receives events (R7); `tsc`=0; vitest green.
**Labels:** `config`, `wave-1`, `appsec`.

## gateway-003 — scoring (attach snapshot + rescore) (Wave 1)
**Owns:** `packages/gateway/src/scoring/` (`attach.ts`, index) + tests.
**Deps:** `gateway-001`.
**Build:**
- `attach.ts`: given a connected (or connectable) downstream `Client`, run `@gatewarden/score`'s `introspect()` then `scoreLintOnly(server, lintResult)` → assemble an immutable `GatewaySnapshot` `{ server, scorecard, attachedAt }`. Keyless/deterministic by default (R2); `eval` path opt-in but NOT required for v1. `rescore()` returns a NEW snapshot, never mutates the prior (R3).
**Acceptance:** against a stub/in-process MCP server (or score's own fixtures), produces a deterministic snapshot with eval-only axes `null` (R2); two `rescore` calls return distinct frozen objects (R3); no API key used; `tsc`=0; vitest green.
**Labels:** `scoring`, `wave-1`.

## gateway-004 — GatewardenProxy (the fusion) (Wave 2)
**Owns:** `packages/gateway/src/proxy/` (`gateway.ts`, index) + tests.
**Deps:** `gateway-002`, `gateway-003`.
**Build:**
- `GatewardenProxy` (ADR-C): construct from a wired bundle (002) + scoring (003). On `connect`/`attach`: connect ONE downstream `Client`; introspect+score it once → store snapshot (003); stand up an enforcing MCP `Server` (model on `govern`'s proxy.ts: capture `_meta['x-lease-token']`→`sessionId` at initialize; on `tools/call` resolve→`Action`, `enforcer.check`, deny+audit or forward+audit `use`; unmapped→passthrough R5). Expose `getSnapshot()` and `rescore()`.
- Share the single downstream client between scorer and enforcer (no second connection, R1).
**Acceptance:** end-to-end in-process test (client ↔ GatewardenProxy ↔ in-memory downstream): attach yields a snapshot AND enforcement is live in one flow (R1); no-token call DENIED (R4); out-of-scope DENIED, in-scope forwarded (R4); unmapped tool passthrough logged (R5); snapshot unchanged after calls, `rescore` makes a new one (R3); audit chain intact (R7); `tsc`=0; vitest green.
**Labels:** `proxy`, `wave-2`, `appsec`.

## gateway-005 — CLI (Wave 3)
**Owns:** `packages/gateway/src/cli/` + `bin` + `package.json` `bin` field for `gatewarden`.
**Deps:** `gateway-004`.
**Build:** `gatewarden` bin: `score <config>` (print keyless snapshot, no serve), `serve <config>` (run gateway), `rescore <config>` (fresh snapshot). Surface `govern`'s lifecycle commands (`request`/`approve`/`deny`/`pending`/`revoke`/`policy`/`audit`) through the gatewarden CLI (delegate to govern's command impls).
**Acceptance:** `node dist/cli/index.js --help` lists the commands; `score` against the fs server prints a deterministic scorecard (R8, R2); veto commands reachable; `tsc`=0; vitest (CLI arg-parse unit tests) green; built bin is executable.
**Labels:** `cli`, `wave-3`.

## gateway-006 — fixtures + demo (Wave 3)
**Owns:** `packages/gateway/fixtures/` + `scripts/demo.mjs` + `package.json` `demo` script.
**Deps:** `gateway-004`.
**Build:** fixture config fronting `@modelcontextprotocol/server-filesystem` with a sandbox dir containing an allowed file + a `private/` file; a tool→Action mapping for `read_file`/`write_file`; a policy + lease allowing the allowed path only. `scripts/demo.mjs`: attach → print scorecard → attempt `private/` read (DENIED) → in-scope read (OK), all keyless (R10).
**Acceptance:** `bun run demo` prints a scorecard AND shows `private/` DENIED + allowed read OK in one flow, no API key, deterministic (R10); `tsc`=0.
**Labels:** `demo`, `fixtures`, `wave-3`.

## gateway-007 — integration (Wave 4, first-class, independently verified)
**Owns:** `packages/gateway/src/index.ts` (public API barrel), `packages/gateway/README.md`, a smoke test.
**Deps:** `gateway-001..006`.
**Build:** one canonical barrel re-exporting the gateway public API (`GatewardenProxy`, contract types, `buildToolActionResolver`, config loader, scoring). README with quickstart. Smoke test importing only the barrel.
**Acceptance (verified independently, NOT self-report):** exactly one barrel, consumers import it; `bun run test` green across the WHOLE workspace (score 348 + govern 221 + gateway); `tsc`=0 workspace-wide; `bun run demo` R10 green keyless; AgentShield clean; fresh-clone build+test+demo certified before land.
**Labels:** `integration`, `wave-4`, `appsec`.

---

## Dep summary
`001` → (`002`, `003`) → `004` → (`005`, `006`) → `007`.
`bd dep cycles` must be empty; `bd ready` after creation = ONLY `001`.
