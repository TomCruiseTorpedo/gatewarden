# Spec — gatewarden (MCP Gateway)

> Source of truth for WHAT and WHY. No tech choices here (those live in `docs/adrs.md`). Each requirement is testable; unhappy paths are first-class. Deny-by-default throughout.

## Problem & intent

An autonomous agent talks to MCP servers it did not write. Two questions go unanswered at the edge: **is this server good for an agent to use** (usability), and **is this agent allowed to make this call right now** (governance). Today those are separate tools. `gatewarden` is the single in-path proxy that answers both — point it at a downstream MCP server and you get a usability **scorecard** plus least-privilege, time-boxed, audited **enforcement**, from one process and one config.

It is the trilogy capstone: it composes `score` (the agent-usability scorer, run #1) and `govern` (the capability-lease broker, run #2) behind one seam. The interesting part is the **composition**, not either half.

## Scope (v1)

- **In:** one gateway fronting exactly **one** downstream MCP server; deterministic (keyless) score snapshot at attach + manual re-score; in-path lease enforcement on every mapped tool call; hash-chained audit; CLI.
- **Out (explicit non-goals, seams left):** multi-server routing; continuous in-path re-scoring; LLM-eval scoring on by default; Cedar policy backend; non-CLI veto surface.

## Definitions

- **Snapshot** — an immutable record `{ server, scorecard, attachedAt }` captured when the gateway attaches to a downstream. Read-only for the life of that attachment.
- **Enforcement state** — the *live* mutable state keyed by lease id (cumulative spend, revocations). Never part of a snapshot, never part of a lease.
- **Mapped tool** — a downstream tool the config maps to a capability `Action`. **Unmapped tool** — one with no mapping.

## Requirements

### R1 — Unified attach (score + govern in one flow)
- GIVEN a valid `GatewayConfig` naming one downstream MCP server
- WHEN the gateway attaches
- THEN it both (a) produces a score **snapshot** of the downstream AND (b) stands up an in-path enforcing proxy that clients connect to — in a single attach flow, with no second connection to the downstream.

### R2 — Deterministic, keyless score snapshot
- GIVEN the gateway is attaching
- WHEN it scores the downstream
- THEN the snapshot's scorecard is computed by the **deterministic lint path only** (no LLM, no API key, zero per-call latency); eval-only axes carry a `null` score (never a fabricated verdict); the badge-able headline is the deterministic aggregate.
- AND eval-based scoring is available only when explicitly requested (off by default).

### R3 — Snapshot immutability vs live state
- GIVEN a snapshot was taken at attach
- WHEN tool calls flow and enforcement state changes (spend accrues, a lease is revoked)
- THEN the snapshot is never mutated.
- AND WHEN `rescore` is invoked THEN a NEW snapshot is produced; the prior snapshot is not edited in place, and the re-score is recorded in the audit log.

### R4 — In-path enforcement, deny-by-default
- GIVEN a client session with no lease token bound
- WHEN it calls a mapped tool
- THEN the call is DENIED (reason: no lease bound to session) and audited.
- GIVEN a bound lease
- WHEN a mapped tool call resolves to an `Action` that is outside the lease scope, OR the lease is expired, OR revoked, OR (for spend) would breach the cap
- THEN the call is DENIED with a specific reason and audited; the downstream is never invoked for a denied call.
- GIVEN all checks pass
- THEN the call is forwarded to the downstream and a `use` event is audited.

### R5 — Unmapped tools pass through (explicit)
- GIVEN a tool with no `Action` mapping in the config
- WHEN it is called
- THEN it is forwarded to the downstream transparently (no enforcement), and this passthrough is observable (logged), not silent. (Matches `govern`'s resolver contract.)

### R6 — Declarative tool→Action mapping
- GIVEN a config that maps a downstream tool name to an `Action` template (which argument carries the path / endpoint / amount)
- WHEN a call to that tool arrives
- THEN the gateway resolves it to a concrete `Action` using the call's arguments, and enforces against that Action.
- AND a malformed mapping (missing the named argument at call time) DENIES (deny-by-default), it does not pass through.

### R7 — Tamper-evident audit
- GIVEN any attach, rescore, use, or denial
- WHEN it occurs
- THEN it is appended to `govern`'s hash-chained, append-only audit log; existing events are never modified or deleted.

### R8 — CLI
- `gatewarden score <config>` prints the deterministic snapshot for the downstream (keyless, no serve).
- `gatewarden serve <config>` runs the gateway (attach + enforce) for clients to connect to.
- `gatewarden rescore <config>` produces and prints a fresh snapshot.
- The `govern` veto/lifecycle commands (`request`, `approve`, `deny`, `pending`, `revoke`, `policy`, `audit`) are reachable through the gatewarden CLI surface.

### R9 — Single-server invariant
- GIVEN a v1 config
- THEN it describes exactly one downstream; a multi-server config is rejected with a clear "not supported in v1" error (the routing seam is documented, not silently mis-handled).

### R10 — Demo: red→green, keyless, one flow
- GIVEN the gateway fronting `@modelcontextprotocol/server-filesystem`
- WHEN the demo runs (no API key)
- THEN it prints a deterministic scorecard for the filesystem server
- AND an over-privileged read of a `private/` path is DENIED by the lease scope
- AND an in-scope read of an allowed path succeeds
- — all in one flow, fully reproducible, no network/LLM.

## Acceptance (v1 done = all true)
- All R1–R10 covered by tests; `bun run test` green across the whole workspace (score + govern + gateway).
- `tsc --noEmit` = 0 workspace-wide.
- `gatewarden` CLI runs via the built bin.
- Demo shows R10 red→green keyless.
- AgentShield scan clean (known gt-CLAUDE.md false positive excepted).
- The two vendored cores' test suites remain green and unmodified (re-home preserved them).
