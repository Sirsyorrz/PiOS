# Protocol findings

Results of the Phase 0 spikes against pi 0.84.2 on Linux. Every claim below was
produced by a script in `spikes/`, not by reading docs.

Reproduce:

```
pnpm spike:rpc       # framing, trace capture, resume, mid-stream kill
pnpm spike:gotchas   # trust, streamingBehavior, delta assembly, settle order
pnpm spike:inproc    # same probe against in-process AgentSession
```

Fixtures live in `spikes/traces/` and are checked in.

## Verdict

The premise holds. Entry ids are a durable cursor, delta assembly is exact, and
`agent_settled` is a real terminal signal. Nothing in the RPC contract blocks
the design.

## 1. Framing

Hand-rolled LF-only splitter (`spikes/jsonl.ts`) parsed every line of every
trace with zero parse errors. It strips a trailing `\r`, buffers partials, and
carries a max-line guard. `readline` was never used and must never be: it also
splits on U+2028/U+2029, which are legal inside JSON strings.

## 2. Event trace

A single `read`-tool prompt produced, in order:

```
agent_start turn_start message_start message_update* message_end
tool_execution_start tool_execution_end turn_start message_start
message_update* message_end turn_end agent_end agent_settled
```

Captured in `spikes/traces/prompt-basic.jsonl` (38 events) and
`spikes/traces/streaming.jsonl` (167 events, includes steering).

Note `tool_execution_update` did not appear for a fast `read`. It is optional;
clients must not depend on receiving one.

## 3. Resume by entry id

Confirmed against a session driven to completion, the process killed, and a
fresh `pi --mode rpc` started on the same `--session-id`:

- `get_entries --since <id>` returned exactly the entries after the cursor.
  No gaps, no duplicates, ids identical to the recorded trace.
- `leafId` was unchanged across the restart, so one round trip is enough to
  detect a moved branch.
- An unknown cursor fails loudly: `success: false`,
  `error: "Entry not found: <id>"`. **This is the full-refetch trigger.**
  Treat a failed `since` as "cursor invalid, refetch everything", not as a
  transport error.
- A full refetch after restart returned all 6 entries: the session JSONL
  survives process exit, so resume does not depend on the daemon's ring buffer.

## 4. Crash mid-stream

`SIGKILL` on the first `text_delta`, then restart on the same session id:

- The resumed session contained the user prompt but **not** the in-flight
  assistant message. Partial assistant turns are not persisted.
- Consequence for Phase 2: after a crash-restart the last durable entry is the
  user prompt, so the correct recovery is to re-issue the prompt, not to try to
  splice a half-streamed message. The daemon's ring buffer holds the partial
  for display; the session file is the truth for replay.

## 5. Gotchas, probed

**Trust.** A project-local prompt template in `.pi/prompts/` (not
`.pi/agent/prompts/`, which is the user-level path) was visible in RPC mode
with no flag and with `--approve`, and invisible with `--no-approve`. So the
"headless always behaves like `never`" claim in the spec is too strong for a
machine whose trust state is already established; what is decisive is the
per-run flag. PiOS must therefore carry an explicit trust flag per session and
surface the resulting state, rather than assuming either default.

**streamingBehavior.** Sending a bare `prompt` while the agent streams fails
with:

```
Agent is already processing. Specify streamingBehavior ('steer' or 'followUp')
to queue the message.
```

With `streamingBehavior: "steer"` it succeeds and two `queue_update` events
follow (enqueue, then drain). The outbox must record the behavior alongside the
message, because whether the agent is busy at delivery time is not knowable at
compose time.

**Delta assembly.** Accumulating `text_delta`/`thinking_delta` by
`contentIndex` from `message_start` reproduced `message_end.message` content
**exactly** (byte-identical). `message_start` fires once per assistant message,
so the accumulator must reset on it.

`toolcall_delta` carries **no `toolCallId`**. The only fields on
`toolcall_start` / `toolcall_delta` are `type` and `contentIndex`; the id first
appears on `toolcall_end.toolCall`. Argument buffers are therefore keyed by
`contentIndex`, and a streaming tool-call card has no id to correlate against
`tool_execution_start` until the call completes. The `partial` field present in
the `AssistantMessageEvent` type upstream is stripped in RPC mode, which is why
the client has to hold this state at all.

`message_start` and `message_end` both fire for user and toolResult messages
with identical content, so a transcript must record non-assistant messages on
exactly one of the two or it doubles them.

**agent_end vs agent_settled.** `agent_settled` was always last, after the
final `agent_end`, in every trace. Push fires on `agent_settled` only.

## 6. Host choice: in-process AgentSession

`createAgentSession()` from `@earendil-works/pi-coding-agent` produced the
identical event union (`AgentSessionEvent`) with identical shapes, in 214ms and
with no subprocess, no stdio, and no JSON round trip.

Differences that matter:

| | subprocess RPC | in-process AgentSession |
|---|---|---|
| Startup | process spawn per session | ~200ms, in-process |
| Events | JSONL over stdout | direct `subscribe()` callback |
| `since` cursor | `get_entries` implements it | `sessionManager.getEntries()` returns everything; host slices by id |
| Crash blast radius | one session | the whole daemon |
| Version coupling | CLI on PATH | pinned npm dependency |

**Decision: in-process is the v0 host.** It is faster, avoids serialising every
delta twice, and gives direct access to `sessionManager` for cursor slicing.
The cost is that an unhandled throw takes the daemon down, which the Phase 2
crash policy has to cover anyway for the subprocess case.

`SubprocessSession` still gets built in Phase 2, for two reasons: it is the
reference implementation the docs describe, and it is the isolation escape
hatch if in-process turns out to be too fragile. Both implementations run the
same test suite.

## 7. Carry-over into later phases

- `get_entries --since` with an unknown id returns `success: false`. Phase 4's
  session store must map that to a full refetch (Phase 4 step 4).
- `tool_execution_update` is optional. Phase 5 tool cards render from
  `start` + `end`, treating `update` as a bonus.
- **pi emits no timings anywhere.** No event carries a duration, and only
  `turn_start` carries a timestamp. Worse, `tool_execution_start` is emitted
  *before* `prepareToolCall`, which is where a confirmation dialog is raised,
  so wall time between `start` and `end` includes however long the human took
  to approve. The daemon measures it instead, subtracting dialog-open spans,
  and adds `startedAt` / `durationMs` to those two events. Session JSONL keeps
  neither, so a resync loses the timings rather than showing a wrong one.
- `message_start` resets the content accumulator. Phase 1's `MessageAssembler`
  keys partials per message, not per session.
- The in-process host must implement `since` slicing itself; that logic belongs
  in `packages/pi-host`, not in the server.

## API corrections found while spiking

Two paths in the design notes were wrong and are corrected here:

- Project prompt templates: `.pi/prompts/`, not `.pi/agent/prompts/`.
- `SessionManager.create(cwd, sessionDir)` takes positional arguments, not an
  options object.
