# PiOS — Spec

An iOS client for [pi coding agent](https://pi.dev) running on a remote machine.

**Status:** design draft. Nothing built yet. Open questions marked ❓.

---

## 1. Problem

Running `pi` on a Linux box from a phone today means SSH'ing in with a terminal
app. That's workable but bad in three specific ways:

1. **Keystroke-at-a-time input.** Typing a paragraph-length prompt into a raw
   PTY over a mobile keyboard is miserable. There's no draft, no edit, no
   review-before-send.
2. **Connection-coupled sessions.** If `pi` is a child of the SSH session, a
   dropped connection SIGHUPs the agent mid-task.
3. **No rich rendering.** Images the agent reads are invisible. Tool calls,
   diffs, and extension dialogs are ANSI soup.

PiOS fixes all three by talking to pi's **RPC mode** rather than scraping a
terminal.

---

## 2. Core insight

`pi --mode rpc` is a headless JSON protocol over stdin/stdout. It exposes
everything the TUI has: streaming assistant text, tool execution events,
session state, forking, and — critically — a translated **Extension UI
Protocol**. This means PiOS is not an SSH terminal that happens to run pi. It's
a **native client for pi's RPC protocol**, with a raw terminal as a secondary
feature.

Two protocol features do most of the heavy lifting:

- **`get_entries` with a `since` cursor.** The session is an append-only tree
  with stable entry ids. An entry id is a durable cursor that survives client
  restarts. Reconnect = "give me everything after id X". The response includes
  `leafId` so one round trip tells you whether the branch moved.
- **The Extension UI Protocol.** Extension dialogs (`select`, `confirm`,
  `input`, `editor`) become request/response pairs the client renders natively.
  Fire-and-forget methods (`notify`, `setStatus`, `setWidget`, `setTitle`,
  `set_editor_text`) can be rendered or ignored.

Together these mean backgrounding is a *sync* problem, not a *liveness*
problem, and extension UI is a *rendering* problem, not an *execution* problem.

---

## 3. Architecture

```
┌─────────────────┐         ┌──────────────────────────────────┐
│  iOS app / PWA  │◄──WS───►│  pios-server (on user's machine) │
│                 │         │                                  │
│  - chat UI      │  HTTP   │  - owns N pi sessions            │
│  - session list │◄───────►│  - multiplexes over one socket   │
│  - image render │  (files)│  - buffers events for replay     │
│  - terminal tab │         │  - serves files/images           │
└─────────────────┘         │  - fires push on agent_settled   │
                            └──────────────┬───────────────────┘
                                           │ AgentSession (in-process)
                                           │ or `pi --mode rpc` subprocess
                                           ▼
                                      pi agent loop
```

### Why a daemon and not raw SSH from the phone

- RPC is stdio, one process per session. Multi-session needs *something*
  server-side to own N children and multiplex them. That something is the
  daemon.
- Session lifetime decouples from connection lifetime. The agent keeps running
  when the phone sleeps, is in a drawer, or is out of signal.
- A browser can't SSH. The daemon is what makes the PWA possible.
- Image serving, file upload, and push notifications become ordinary HTTP.
- Windows support becomes a path-handling pass rather than a PTY rewrite.

### Implementation language

Node/TypeScript is the path of least resistance: pi's docs recommend using
`AgentSession` from `@earendil-works/pi-coding-agent` directly rather than
spawning subprocesses. That skips the stdio layer entirely for the agent
sessions. Subprocess RPC remains the fallback / reference behaviour.

### Bootstrap — pairing, not SSH

**Decision: no native SSH in v0.** T3's mobile app never SSHes; its
`SshConnectionTarget` is *desktop*-managed, and the phone only speaks
HTTP/WebSocket via direct pairing, relay, or Tailscale
([`docs/internals/remote.md`][t3-remote]).

Flow: user runs an install command on their machine → server prints a pairing
URL/code → phone pairs → WebSocket from then on. T3 puts the token in the URL
**hash**, exchanges it directly with the backend, and strips it from history
(`packages/shared/src/remote.ts`).

This removes the last reason to write a native module, which makes Expo clean.
SSH becomes a later convenience, not a dependency.

### Endpoints

A server may be reachable several ways (loopback / LAN / private / tunnel).
Treat advertised endpoints as **hints, not proof** — the connection attempt
decides. Two rules worth copying:

- No unconditional loopback fallback.
- Persist endpoints by **stable key**, not raw URL. LAN addresses change with
  networks; T3 uses `tailscale-ip:` / `tailscale-magicdns:` keys for this.

---

## 4. Backgrounding

**Position:** the agent loop must survive independent of the phone. Whether
iOS holds the socket open is polish, not correctness.

Server-side durability, in preference order:

1. Daemon owns the `pi` sessions and is itself a systemd user unit / launchd
   agent. Survives everything.
2. `tmux new-session -d -s pios-<id>` as a simpler v0.
3. Worst case, sessions auto-save to `~/.pi/agent/sessions/` as JSONL, so state
   survives even a daemon crash.

Client-side reconnect: on foreground, send `get_entries` with the last seen
entry id, apply the delta, compare `leafId`. Done.

**This question is settled by prior art.** T3 Code — the best-in-class app in
this category — does not attempt background socket survival at all.
[`apps/mobile/src/connection/app-state-wakeups.ts`][t3-wakeups] is 15 lines:

```ts
export const MOBILE_BACKGROUND_RECONNECT_AFTER_MS = 10_000;
// backgrounded >= 10s → "application-active-reconnect"
// backgrounded  < 10s → "application-active-probe"
```

Under 10 seconds they probe the existing session on foreground. Over it, they
replace the lease outright — [`docs/internals/connection-runtime.md`][t3-conn]
says `application-active-reconnect` interrupts establishment and resets the
retry ladder "because the OS may have silently killed the socket underneath the
attempt."

Ten seconds. Design for reconnect, not for liveness.

❓ Termius appears to hold interactive SSH sessions alive longer than this.
Mechanism unconfirmed — Live Activities are rendered out-of-process and do not
themselves grant background execution. Possibly relevant to the terminal tab.
Not worth chasing for v0.

**Live Activity** is still worth building — as a *status surface*
("Session 2: running tests, 4m") driven by push, not as a liveness mechanism.

---

## 5. Connection supervisor

Rules adapted from [`packages/client-runtime/src/connection/supervisor.ts`][t3-sup]
and the connection-runtime doc. These are non-obvious and cheap to copy.

- **One retry owner.** React components never create connections, transports,
  retry loops, or RPC clients.
- **Backoff** exponential, capped at 16s, retries forever. 30s of stable
  connection resets the ladder.
- **Ignore plain foreground activation during an in-flight attempt** —
  restarting only delays it. Only a meaningful background suspension
  (≥10s) interrupts.
- **Offline** releases the session and waits for a signal — no retry attempts
  consumed, no timer running.
- **Auth/config failures block permanently** until an input changes. Don't
  retry what can't succeed.
- **Never infer health from cached data.** An environment is `connected` only
  after the socket opens *and* an initial config RPC succeeds.
- **Transport health and sync status are separate.** A healthy socket with a
  failed subscription is "connected, sync error" — not a fake reconnect.

---

## 6. Thread outbox

Prompts are queued durably, not fired at a live socket. Modelled on
[`apps/mobile/src/state/thread-outbox-model.ts`][t3-outbox] and
[`use-thread-outbox-drain.ts`][t3-drain].

- Persisted, schema-versioned queue of composed messages
- Each entry carries `messageId` + `commandId` for **idempotent** delivery
- Image attachments inline in the queued entry
- Own retry backoff (also capped at 16s)
- Survives app restart; drains on reconnect

This is what makes compose-and-send actually work on a phone: write a prompt on
the tube, it sends when signal returns. Without it, "nicer typing UX" is just an
input box.

---

## 7. Scope

### v0 — the thing that must work

- Connect to a machine, pick a directory, start a pi session
- Compose-then-send prompts via the durable **outbox** (§6)
- Render streaming assistant text, tool calls, diffs
- Sessions survive backgrounding; resync on foreground via `get_entries --since`
- Multi-session sidebar
- Push notification on `agent_settled`

### v1

- Inline image rendering (agent reads a `.png` → fetch → display)
- Send images from phone to agent
- Activity-lease reporting so the server knows what to keep warm
- Extension UI dialogs rendered natively
- `@path` file picker via SFTP/daemon listing

### Later

- Raw terminal tab (see §9 — non-trivial, deliberately deferred)
- macOS / Windows daemon support
- Session forking / branch browsing (protocol supports it: `fork`, `clone`,
  `get_fork_messages`, `get_tree`)
- Model switching, thinking-level control, compaction UI

### Explicit non-goals

- Reimplementing pi. PiOS is a view onto pi, not a fork.
- A permission/approval system. Pi has none by design; users who want gating
  install an extension (auto-approval toggle etc.) and PiOS renders its dialogs.
- Managing the user's network security. LAN, Tailscale, key or password — the
  user sets it up however they like; PiOS just needs to reach the box.
- Being a plugin or provider inside another harness GUI. PiOS is a standalone
  app, purpose-built for pi. T3 Code is reference architecture, not a host.

---

## 8. Protocol notes

### Sending prompts

`prompt`, `steer`, and `follow_up` all accept an optional `images` array of
base64 `ImageContent` blocks — phone→agent image upload is native to the
protocol.

While the agent is streaming, `prompt` **must** specify `streamingBehavior`
(`"steer"` or `"followUp"`) or it errors. `queue_update` events report pending
queue contents, so the UI can show queued messages.

### Events worth wiring

| Event | Use |
|---|---|
| `message_update` | Stream assistant text/thinking into the bubble |
| `tool_execution_start/update/end` | Tool call cards; correlate on `toolCallId` |
| `agent_settled` | **Push notification trigger** |
| `queue_update` | Render pending steering/follow-up |
| `compaction_start/end` | Context-compaction indicator |
| `auto_retry_start/end` | "Retrying, provider overloaded" banner |
| `extension_error` | Surface, don't swallow |

Use `agent_settled`, not `agent_end` — `agent_end` may be followed by retry,
compaction, or queued continuations.

### Extension UI

Render `select`/`confirm`/`input`/`editor` as native sheets; reply with
`extension_ui_response` and the matching `id`. Dialogs may carry a `timeout`
which the agent auto-resolves — the client does not need to track it.

Degraded in RPC mode (already stubbed, won't leak TUI at you): `custom()`
returns undefined; `setWorkingMessage`, `setFooter`, `setHeader`,
`setEditorComponent`, `setToolsExpanded` are no-ops; `getTheme`/`setTheme`
unavailable. `setWidget` accepts string arrays only — component factories are
ignored.

`custom()` is the only genuine gap. Extensions that use it are invisible in
RPC mode regardless of what PiOS does.

### Gotchas

1. **Framing.** Strict LF-only JSONL. Node `readline` is explicitly
   non-compliant (it also splits on U+2028/U+2029, valid inside JSON strings).
   Hand-roll the splitter.
2. **Trust.** RPC mode shows no trust prompt and falls back to
   `defaultProjectTrust`, which defaults to `ask` — and in non-interactive mode
   `ask` behaves like `never`. Project-local extensions, settings, and packages
   silently don't load. This will read as a mystery bug. **Surface trust state
   in the UI** and offer to trust the directory (or pass `--approve`).
3. **Streaming assembly.** `message_update` deltas carry no cumulative
   snapshot. Assemble partials from `message_start` + `contentIndex`; treat
   `message_end.message` as authoritative. Buffer `toolcall_delta` for args.
4. **Bash ≠ terminal.** The RPC `bash` command adds output to conversation
   context and only reaches the LLM on the *next* prompt. The terminal tab
   needs a separate real shell channel.

---

## 9. Client platform

- **Avoid Xcode where possible.** React Native / Expo + EAS Build (cloud) means
  never opening Xcode locally. T3's mobile app is React Native, shipping on both
  stores — this is a proven path.
- With pairing instead of SSH bootstrap, **v0 needs no native modules at all.**
- **Terminal tab: defer.** T3 abandoned xterm.js — web runs a WebAssembly build
  of `libghostty-vt`, Android links the native library
  ([`docs/architecture/terminal-renderers.md`][t3-term]). PTYs stay server-owned;
  renderer choice never crosses the wire. That's a serious investment and a good
  reason to keep the terminal out of v0. If built early, xterm.js in a WebView
  is the cheap version.
- **PWA first** is a good move — it validates the daemon protocol, chat UI,
  session sidebar, and image rendering with fast iteration. It *cannot*
  validate backgrounding (browsers don't hold sockets either), but since the
  daemon owns the sessions, that's fine.
- **Distribution:** sideload → TestFlight → App Store if it's good. App Store
  review has opinions about remote code execution and background modes; worth
  checking before depending on either.

---

## 10. Keys / auth

- Prefer generating an Ed25519 key in the Secure Enclave and having the user
  paste the public key into `authorized_keys` — better onboarding than
  importing an existing private key.
- Daemon needs its own auth (a token minted during SSH bootstrap). SSH's auth
  model does not come along for free once you're speaking WebSocket, and the
  daemon can execute arbitrary code as the user.

---

## 11. Open questions

- ❓ Can two clients attach to one session simultaneously (phone + laptop)?
- ❓ How does the daemon handle a `pi` process crash — auto-restart and resume
  from session file?
- ❓ Does the phone cache transcripts for offline reading, or always read
  through the daemon?
- ❓ Multi-session in one repo: allowed (pi's model) but what happens when two
  agents write the same file? Probably just document it.
- ❓ Terminal tab: daemon-mediated PTY (T3's model) is the answer if built.
  Renderer is the open cost.

---

## 12. First thing to build

A ~100-line Node script that spawns `pi --mode rpc`, sends a prompt, prints the
event stream, then reconnects with `get_entries --since` and verifies the
delta is correct. That validates the entire premise of this document before any
UI exists.

---

## References

- pi RPC docs: https://pi.dev/docs/latest/rpc
- pi repo: https://github.com/earendil-works/pi
- ACP discussion (relevant prior art on headless extension behaviour):
  https://github.com/earendil-works/pi/discussions/4444
- Termius — closed source, reference for SSH UX

### T3 Code (`pingdotgg/t3code`, MIT, @ `30be311`)

Closest prior art: RN mobile app + Node WebSocket server wrapping agent CLIs
over JSON-RPC stdio. Same shape as PiOS, different agent. Worth reading before
building.

[t3-wakeups]: https://github.com/pingdotgg/t3code/blob/main/apps/mobile/src/connection/app-state-wakeups.ts
[t3-conn]: https://github.com/pingdotgg/t3code/blob/main/docs/internals/connection-runtime.md
[t3-sup]: https://github.com/pingdotgg/t3code/blob/main/packages/client-runtime/src/connection/supervisor.ts
[t3-outbox]: https://github.com/pingdotgg/t3code/blob/main/apps/mobile/src/state/thread-outbox-model.ts
[t3-drain]: https://github.com/pingdotgg/t3code/blob/main/apps/mobile/src/state/use-thread-outbox-drain.ts
[t3-remote]: https://github.com/pingdotgg/t3code/blob/main/docs/internals/remote.md
[t3-term]: https://github.com/pingdotgg/t3code/blob/main/docs/architecture/terminal-renderers.md
[t3-bg]: https://github.com/pingdotgg/t3code/blob/main/apps/mobile/src/connection/background-activity.ts

Also relevant: `apps/mobile/src/features/agent-awareness/` (push notifications
when an agent finishes or asks a question) and
[`background-activity.ts`][t3-bg] — a 25s activity report with a 45s TTL lease
carrying `visible`/`focused`/`appState` and "background scopes" the client wants
kept warm. Server keeps work alive on the lease; the phone need not be attached.
