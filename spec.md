# PiOS - Spec

An iOS client for [pi coding agent](https://pi.dev) running on a remote machine.

**Status:** design draft. Nothing built yet. Open questions marked with "Q:".

---

## 1. Problem

Running `pi` on a Linux box from a phone means SSH'ing in with a terminal app.
That is workable but bad in three ways:

1. **Keystroke-at-a-time input.** No draft, no edit, no review before send.
2. **Connection-coupled sessions.** If `pi` is a child of the SSH session, a
   dropped connection SIGHUPs the agent mid-task.
3. **No rich rendering.** Images are invisible. Tool calls, diffs, and
   extension dialogs are ANSI soup.

PiOS talks to pi's **RPC mode** instead of scraping a terminal.

---

## 2. Core insight

`pi --mode rpc` is a headless JSON protocol over stdin/stdout. It exposes
everything the TUI has: streaming assistant text, tool events, session state,
forking, and a translated **Extension UI Protocol**. PiOS is a native client
for that protocol, with a raw terminal as a secondary feature.

Two protocol features do most of the work:

- **`get_entries` with a `since` cursor.** The session is an append-only tree
  with stable entry ids, so an entry id is a durable cursor that survives
  client restarts. Reconnect means "give me everything after id X". The
  response includes `leafId`, so one round trip tells you if the branch moved.
- **The Extension UI Protocol.** Dialogs (`select`, `confirm`, `input`,
  `editor`) become request/response pairs rendered natively. Fire-and-forget
  methods (`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`)
  can be rendered or ignored.

So backgrounding is a *sync* problem, not a *liveness* problem, and extension
UI is a *rendering* problem, not an *execution* problem.

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

- RPC is stdio, one process per session. Multi-session needs something
  server-side to own N children and multiplex them.
- Session lifetime decouples from connection lifetime.
- A browser cannot SSH. The daemon is what makes the PWA possible.
- Image serving, file upload, and push become ordinary HTTP.
- Windows support becomes a path-handling pass, not a PTY rewrite.

### Implementation language

Node/TypeScript. Pi's docs recommend using `AgentSession` from
`@earendil-works/pi-coding-agent` directly rather than spawning subprocesses,
which skips the stdio layer. Subprocess RPC stays as fallback and reference.

### Bootstrap: pairing, not SSH

**Decision: no native SSH in v0.** T3's mobile app never SSHes; its
`SshConnectionTarget` is desktop-managed, and the phone only speaks
HTTP/WebSocket via direct pairing, relay, or Tailscale
([`docs/internals/remote.md`][t3-remote]).

Flow: user runs an install command on their machine, server prints a pairing
URL/code, phone pairs, WebSocket from then on. T3 puts the token in the URL
**hash**, exchanges it with the backend, and strips it from history
(`packages/shared/src/remote.ts`).

No native modules needed, so Expo stays clean. SSH becomes a later
convenience, not a dependency.

### Endpoints

A server may be reachable several ways (loopback, LAN, private, tunnel). Treat
advertised endpoints as hints, not proof; the connection attempt decides.

- No unconditional loopback fallback.
- Persist endpoints by **stable key**, not raw URL. LAN addresses change with
  networks; T3 uses `tailscale-ip:` / `tailscale-magicdns:` keys.

---

## 4. Backgrounding

**Position:** the agent loop must survive independent of the phone. Whether
iOS holds the socket open is polish, not correctness.

Server-side durability, in preference order:

1. Daemon owns the `pi` sessions and is a systemd user unit / launchd agent.
2. `tmux new-session -d -s pios-<id>` as a simpler v0.
3. Sessions auto-save to `~/.pi/agent/sessions/` as JSONL, so state survives a
   daemon crash.

Client reconnect: on foreground, send `get_entries` with the last seen entry
id, apply the delta, compare `leafId`.

Prior art settles this. T3 Code does not attempt background socket survival at
all. [`apps/mobile/src/connection/app-state-wakeups.ts`][t3-wakeups] is 15
lines:

```ts
export const MOBILE_BACKGROUND_RECONNECT_AFTER_MS = 10_000;
// backgrounded >= 10s -> "application-active-reconnect"
// backgrounded  < 10s -> "application-active-probe"
```

Under 10 seconds they probe the existing session. Over it, they replace the
lease outright: [`docs/internals/connection-runtime.md`][t3-conn] says
`application-active-reconnect` interrupts establishment and resets the retry
ladder "because the OS may have silently killed the socket underneath the
attempt."

Design for reconnect, not for liveness.

Q: Termius appears to hold interactive SSH sessions alive longer than this.
Mechanism unconfirmed. Live Activities are rendered out-of-process and do not
grant background execution. Possibly relevant to the terminal tab, not worth
chasing for v0.

**Live Activity** is still worth building as a status surface
("Session 2: running tests, 4m") driven by push, not as a liveness mechanism.

---

## 5. Connection supervisor

Rules adapted from [`packages/client-runtime/src/connection/supervisor.ts`][t3-sup]
and the connection-runtime doc.

- **One retry owner.** React components never create connections, transports,
  retry loops, or RPC clients.
- **Backoff** exponential, capped at 16s, retries forever. 30s of stable
  connection resets the ladder.
- **Ignore plain foreground activation during an in-flight attempt.** Only a
  background suspension of 10s or more interrupts.
- **Offline** releases the session and waits for a signal: no retries
  consumed, no timer running.
- **Auth/config failures block permanently** until an input changes.
- **Never infer health from cached data.** An environment is `connected` only
  after the socket opens and an initial config RPC succeeds.
- **Transport health and sync status are separate.** A healthy socket with a
  failed subscription is "connected, sync error", not a fake reconnect.

---

## 6. Thread outbox

Prompts are queued durably, not fired at a live socket. Modelled on
[`apps/mobile/src/state/thread-outbox-model.ts`][t3-outbox] and
[`use-thread-outbox-drain.ts`][t3-drain].

- Persisted, schema-versioned queue of composed messages
- Each entry carries `messageId` + `commandId` for idempotent delivery
- Image attachments inline in the queued entry
- Own retry backoff, also capped at 16s
- Survives app restart, drains on reconnect

This is what makes compose-and-send work on a phone: write a prompt on the
tube, it sends when signal returns. Without it, "nicer typing UX" is just an
input box.

---

## 7. Scope

### v0

- Connect to a machine, pick a directory, start a pi session
- Compose-then-send prompts via the durable outbox (section 6)
- Render streaming assistant text, tool calls, diffs
- Sessions survive backgrounding; resync on foreground via `get_entries --since`
- Multi-session sidebar
- Push notification on `agent_settled`

### v1

- Inline image rendering (agent reads a `.png`, fetch, display)
- Send images from phone to agent
- Activity-lease reporting so the server knows what to keep warm
- Extension UI dialogs rendered natively
- `@path` file picker via SFTP/daemon listing

### Later

- Raw terminal tab (see section 9, deliberately deferred)
- macOS / Windows daemon support
- Session forking and branch browsing (`fork`, `clone`, `get_fork_messages`,
  `get_tree`)
- Model switching, thinking-level control, compaction UI

### Non-goals

- Reimplementing pi. PiOS is a view onto pi, not a fork.
- A permission/approval system. Pi has none by design; users who want gating
  install an extension and PiOS renders its dialogs.
- Managing the user's network security.
- Being a plugin inside another harness GUI. T3 Code is reference
  architecture, not a host.

---

## 8. Protocol notes

### Sending prompts

`prompt`, `steer`, and `follow_up` accept an optional `images` array of base64
`ImageContent` blocks, so phone-to-agent image upload is native.

While the agent is streaming, `prompt` **must** specify `streamingBehavior`
(`"steer"` or `"followUp"`) or it errors. `queue_update` events report pending
queue contents.

### Events worth wiring

| Event | Use |
|---|---|
| `message_update` | Stream assistant text/thinking into the bubble |
| `tool_execution_start/update/end` | Tool call cards; correlate on `toolCallId` |
| `agent_settled` | Push notification trigger |
| `queue_update` | Render pending steering/follow-up |
| `compaction_start/end` | Context-compaction indicator |
| `auto_retry_start/end` | "Retrying, provider overloaded" banner |
| `extension_error` | Surface, do not swallow |

Use `agent_settled`, not `agent_end`; `agent_end` may be followed by retry,
compaction, or queued continuations.

### Extension UI

Render `select`/`confirm`/`input`/`editor` as native sheets; reply with
`extension_ui_response` and the matching `id`.

A dialog carries a `timeout` only when the extension asked for one, and pi
arms no timer otherwise, so an unanswered dialog blocks the agent forever.
The daemon therefore caps every dialog itself and cancels on expiry: a session
must never be wedgeable by an extension the client cannot render. A pending
dialog is session state, not connection state, so it survives reconnects and is
delivered to whichever clients are attached; the first answer wins and a
duplicate id is a no-op.

The other half of the protocol is presentation, not questions: `setStatus` and
`setWidget` replace by key, `setTitle` and `set_editor_text` replace outright,
`notify` is a one-shot message. Those four are last-value-wins session state,
held by the daemon and snapshotted on subscribe, because a client that
reconnects needs the current status line rather than the history of how it got
there. `notify` is deliberately not state: replaying it would announce
something that already happened. Both the daemon and the client fold requests
with the same reducer, so neither can drift.

The daemon tolerates non-JSON noise on the RPC stream. Extensions share pi's
stdout and write terminal control bytes without a newline, so a bell would
otherwise arrive glued to the front of the next record and destroy it.

Degraded in RPC mode (already stubbed): `custom()` returns undefined;
`setWorkingMessage`, `setFooter`, `setHeader`, `setEditorComponent`,
`setToolsExpanded` are no-ops; `getTheme`/`setTheme` unavailable. `setWidget`
accepts string arrays only.

`custom()` is the only genuine gap. Extensions using it are invisible in RPC
mode regardless of what PiOS does.

### Gotchas

1. **Framing.** Strict LF-only JSONL. Node `readline` is explicitly
   non-compliant (it splits on U+2028/U+2029, valid inside JSON strings).
   Hand-roll the splitter.
2. **Trust.** RPC mode shows no trust prompt and falls back to
   `defaultProjectTrust`, which defaults to `ask`, and in non-interactive mode
   `ask` behaves like `never`. Project-local extensions, settings, and packages
   silently do not load. Surface trust state in the UI and offer to trust the
   directory (or pass `--approve`).
3. **Streaming assembly.** `message_update` deltas carry no cumulative
   snapshot. Assemble partials from `message_start` + `contentIndex`; treat
   `message_end.message` as authoritative. Buffer `toolcall_delta` for args.
4. **Bash is not a terminal.** The RPC `bash` command adds output to
   conversation context and only reaches the LLM on the next prompt. The
   terminal tab needs a separate shell channel.

---

## 9. Client platform

- **Avoid Xcode, avoid the cloud.** React Native / Expo. T3's mobile app is
  React Native, shipping on both stores. Cloud EAS Build is deliberately not a
  dependency: device iteration happens through Expo Go / a dev client over LAN,
  and native builds run locally on a Mac through the `xcodebuild` CLI
  (`eas build --local`, `npx expo run:ios`, `xcrun simctl`), never the GUI.
- With pairing instead of SSH bootstrap, v0 needs no native modules, so the
  dev-client path holds until APNs, Live Activity, or Secure Enclave keys land.
- **Terminal tab: defer.** T3 abandoned xterm.js: web runs a WebAssembly build
  of `libghostty-vt`, Android links the native library
  ([`docs/architecture/terminal-renderers.md`][t3-term]). PTYs stay
  server-owned; renderer choice never crosses the wire. If built early,
  xterm.js in a WebView is the cheap version.
- **Layout: one list, two presentations.** Wide viewports keep the session
  list docked beside the chat; narrow ones show it as an overlay over the
  chat. Crossing the breakpoint changes presentation only: the open session,
  its scroll position, and the composer draft stay mounted, so a rotation or
  a resize is never a navigation event. Chat text gets a reading-width cap
  independent of the window, because a docked list plus a full-bleed
  transcript is unreadable on a desktop.
- **PWA first** validates the daemon protocol, chat UI, session sidebar, and
  image rendering with fast iteration. It cannot validate backgrounding, but
  since the daemon owns the sessions, that is fine.
- **Distribution:** sideload, TestFlight, App Store if it is good. App Store
  review has opinions about remote code execution and background modes; check
  before depending on either.

---

## 10. Keys / auth

- Prefer generating an Ed25519 key in the Secure Enclave and having the user
  paste the public key into `authorized_keys`, rather than importing an
  existing private key.
- Daemon needs its own auth (a token minted during bootstrap). SSH's auth
  model does not come along for free over WebSocket, and the daemon can
  execute arbitrary code as the user.

---

## 11. Open questions

- Q: Can two clients attach to one session simultaneously (phone + laptop)?
- Q: How does the daemon handle a `pi` process crash: auto-restart and resume
  from session file?
- Q: Does the phone cache transcripts for offline reading, or always read
  through the daemon?
- Q: Multi-session in one repo is allowed by pi's model, but what happens when
  two agents write the same file? Probably just document it.
- Q: Terminal tab: daemon-mediated PTY (T3's model) is the answer if built.
  Renderer is the open cost.

---

## 12. First thing to build

A ~100-line Node script that spawns `pi --mode rpc`, sends a prompt, prints the
event stream, then reconnects with `get_entries --since` and verifies the delta
is correct. That validates the premise of this document before any UI exists.

---

## References

- pi RPC docs: https://pi.dev/docs/latest/rpc
- pi repo: https://github.com/earendil-works/pi
- ACP discussion (prior art on headless extension behaviour):
  https://github.com/earendil-works/pi/discussions/4444
- Termius: closed source, reference for SSH UX

### T3 Code (`pingdotgg/t3code`, MIT, @ `30be311`)

Closest prior art: RN mobile app + Node WebSocket server wrapping agent CLIs
over JSON-RPC stdio. Same shape as PiOS, different agent.

[t3-wakeups]: https://github.com/pingdotgg/t3code/blob/main/apps/mobile/src/connection/app-state-wakeups.ts
[t3-conn]: https://github.com/pingdotgg/t3code/blob/main/docs/internals/connection-runtime.md
[t3-sup]: https://github.com/pingdotgg/t3code/blob/main/packages/client-runtime/src/connection/supervisor.ts
[t3-outbox]: https://github.com/pingdotgg/t3code/blob/main/apps/mobile/src/state/thread-outbox-model.ts
[t3-drain]: https://github.com/pingdotgg/t3code/blob/main/apps/mobile/src/state/use-thread-outbox-drain.ts
[t3-remote]: https://github.com/pingdotgg/t3code/blob/main/docs/internals/remote.md
[t3-term]: https://github.com/pingdotgg/t3code/blob/main/docs/architecture/terminal-renderers.md
[t3-bg]: https://github.com/pingdotgg/t3code/blob/main/apps/mobile/src/connection/background-activity.ts

Also relevant: `apps/mobile/src/features/agent-awareness/` (push when an agent
finishes or asks a question) and [`background-activity.ts`][t3-bg]: a 25s
activity report with a 45s TTL lease carrying `visible`/`focused`/`appState`
and background scopes the client wants kept warm.
