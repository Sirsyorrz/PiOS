# PiOS - Implementation Plan

Derived from `spec.md`. Phases are ordered by risk: validate protocol
assumptions first, UI last. Each phase ends with a concrete artifact that can
be demoed or thrown away.

Repo layout target (pnpm workspace):

```
packages/
  protocol/      shared types, JSONL framing, event schemas (zod)
  pi-host/       owns pi sessions (AgentSession or subprocess RPC)
  server/        pios-server: WS multiplex, HTTP files, pairing, push
  client-core/   connection supervisor, outbox, session store (platform-free)
apps/
  web/           PWA (React + Vite)
  mobile/        Expo RN app (added in Phase 7)
spikes/          throwaway validation scripts
```

---

## Phase 0 - Premise validation (spec 12)

Goal: prove the RPC contract before writing anything reusable.

1. `spikes/rpc-probe.ts`: spawn `pi --mode rpc`, hand-rolled LF-only JSONL
   splitter (no `readline`, spec 8 gotcha 1), send a `prompt`, dump events.
2. Record a full event trace to `spikes/traces/*.jsonl` as fixture data for
   later tests.
3. Kill the client mid-stream, reconnect, `get_entries --since <lastId>`,
   diff against the recorded trace. Verify no gaps, no dupes, `leafId` matches.
4. Probe the gotchas explicitly: trust fallback behaviour (`defaultProjectTrust`
   / `--approve`), `streamingBehavior` requirement while streaming,
   `message_update` delta assembly, `agent_settled` vs `agent_end` ordering.
5. Same spike against in-process `AgentSession` from
   `@earendil-works/pi-coding-agent`. Decide which is v0 host.

Exit: written notes in `docs/protocol-findings.md` answering the above, and
fixtures checked in.

---

## Phase 1 - `packages/protocol`

1. TypeScript types for every RPC request/response and event in scope
   (spec 8 table). Generate or hand-write, validated with zod.
2. `JsonlFramer`: byte-level LF splitting, max line guard, partial buffering.
   Unit tests including U+2028/U+2029 inside strings.
3. `MessageAssembler`: `message_start` + `contentIndex` deltas ->
   partial message; `message_end.message` overrides. `toolcall_delta` buffer
   keyed by `toolCallId`. Tested against Phase 0 fixtures.
4. PiOS-level wire protocol (client <-> server): envelope with `sessionId`,
   `commandId`, `messageId`; schema version field from day one.

Exit: `pnpm test` replays fixtures through the assembler and reproduces the
final transcript exactly.

---

## Phase 2 - `packages/pi-host`

1. `PiSession` interface: `prompt`, `steer`, `followUp`, `getEntries(since)`,
   `interrupt`, `dispose`, plus an event emitter.
2. Two implementations: `InProcessSession` (AgentSession) and
   `SubprocessSession` (stdio RPC). Same tests run against both.
3. Per-session ring buffer of events keyed by entry id for replay to late or
   reconnecting clients.
4. Crash policy (spec Q2): detect exit, mark session `crashed`, auto-restart
   and resume from `~/.pi/agent/sessions/*.jsonl`, emit `session_recovered`.
5. Session registry: create/list/dispose, cwd + trust state per session.

Exit: unit tests plus a manual driver that runs 2 concurrent sessions.

---

## Phase 3 - `packages/server` (v0 daemon)

1. HTTP + WS server (fastify or plain node:http + `ws`). Single WS multiplexes
   all sessions; subscribe/unsubscribe per session.
2. Pairing bootstrap (spec 3): `pios-server pair` prints URL + code, token
   delivered in URL **hash**, exchanged for a long-lived device token, stripped
   from history. Tokens stored hashed on disk.
3. Auth middleware on both HTTP and WS. Reject unauthenticated immediately.
4. Endpoint advertisement by **stable key** (`loopback:`, `lan:`, `tailscale-ip:`,
   `tailscale-magicdns:`), no unconditional loopback fallback.
5. Resume RPC: `get_entries(sessionId, since)` -> delta + `leafId`, served from
   ring buffer, falling back to session JSONL.
6. Idempotent delivery: dedupe inbound prompts by `commandId`.
7. File/image HTTP: `GET /file?session=..&path=..` with cwd containment checks,
   `POST /upload` for phone-to-agent images.
8. Packaging: `systemd --user` unit + install script; tmux fallback documented
   but not required if the unit lands.

Exit: `curl` + `websocat` session can start a session, prompt, disconnect,
reconnect, and resync.

---

## Phase 4 - `packages/client-core`

Platform-free, tested in Node.

1. **Connection supervisor** (spec 5): single retry owner, exponential backoff
   capped 16s, infinite retries, 30s stable resets the ladder, offline releases
   the lease with no timers, auth/config failure blocks until inputs change,
   `connected` only after socket open + initial config RPC succeeds.
2. Separate `transportHealth` from `syncStatus`. Never infer health from cache.
3. **Thread outbox** (spec 6): persisted schema-versioned queue, entries carry
   `messageId` + `commandId`, inline base64 images, own 16s-capped backoff,
   drains on reconnect. Pluggable storage adapter (localStorage / MMKV / fs).
4. **Session store**: entry-id cursor per session, delta application,
   `leafId` divergence detection -> full refetch.
5. Foreground/background policy hook: background >= 10s -> reconnect and reset
   ladder; < 10s -> probe.

Exit: fake-transport tests covering drop mid-stream, offline, auth failure,
outbox survival across restart, `leafId` divergence.

---

## Phase 5 - `apps/web` PWA (v0 UI)

1. Pairing screen (token from URL hash), machine list, endpoint picker.
2. Session list sidebar + create session (directory picker via daemon listing).
3. Chat view: streaming text, thinking blocks, tool-call cards correlated on
   `toolCallId`, diff rendering.
4. Composer: draft, edit, attach, send via outbox. Pending-queue rendering from
   `queue_update`. `streamingBehavior` selector (steer / follow-up) when the
   agent is busy.
5. Status banners: `compaction_start/end`, `auto_retry_start/end`,
   `extension_error` (surface, never swallow), trust state with a
   "trust this directory" action.

Exit: full v0 scope usable from a phone browser.

---

## Phase 6 - Push + settle notifications

1. `agent_settled` -> push. Web push for PWA first; APNs later for native.
2. Device registration table in the daemon, per-device token.
3. Notification content: session name, last tool, elapsed.

---

## Phase 7 - `apps/mobile` (Expo)

1. Expo app reusing `client-core` verbatim; RN storage adapter for the outbox.
2. `AppState` wiring to the Phase 4 background policy.
3. EAS Build cloud pipeline, no local Xcode. TestFlight distribution.
4. APNs push.
5. Live Activity as a status surface driven by push only (not a liveness
   mechanism).

---

## Phase 8 - v1 features

1. Inline image rendering via the file HTTP endpoint.
2. Phone-to-agent images (base64 `ImageContent` on prompt/steer/follow_up).
3. Extension UI dialogs: `select` / `confirm` / `input` / `editor` as native
   sheets, reply `extension_ui_response` with matching `id`. Render or ignore
   `notify` / `setStatus` / `setWidget` / `setTitle`. Document `custom()` as a
   hard gap.
4. Activity-lease reporting: 25s report, 45s TTL, carrying
   `visible` / `focused` / `appState` and warm scopes.
5. `@path` file picker backed by daemon directory listing.

---

## Phase 9 - Later

- Raw terminal tab: daemon-owned PTY, separate shell channel (RPC `bash` is not
  a terminal). Renderer decision deferred; xterm.js in a WebView is the cheap
  first cut.
- macOS / Windows daemon (path-handling pass + launchd unit).
- Forking and branch browsing (`fork`, `clone`, `get_fork_messages`, `get_tree`).
- Model switching, thinking level, compaction UI.

---

## Cross-cutting

- **Testing:** fixture-replay tests for the protocol layer; fake-transport
  tests for client-core; one end-to-end smoke test spawning a real daemon.
- **Schema versioning:** every persisted structure (outbox, session cache,
  device tokens) carries a version and a migration path.
- **Security:** daemon executes arbitrary code as the user. Auth required on
  every route, path containment on file serving, tokens hashed at rest,
  Ed25519 / Secure Enclave key generation only if SSH is ever added.
- **Non-goals guardrail:** no permission system, no pi reimplementation, no
  network management.

## Open questions to resolve during the phases

| Q | Resolve in |
|---|---|
| Two clients on one session simultaneously | Phase 2/3 (ring buffer is per-session, so likely yes) |
| pi process crash recovery | Phase 2 step 4 |
| Offline transcript caching on device | Phase 4 session store |
| Two agents writing one file | Document in Phase 3, no code |
| Terminal renderer cost | Phase 9 |
