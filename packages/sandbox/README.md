# @pios/sandbox

A live PiOS stack with a fake agent, for working on the UI.

The daemon, the protocol, auth and the git routes are the real ones. Only pi
is stubbed, so nothing costs tokens, nothing is non-deterministic, and nothing
touches `~/.pios`, `~/.pi`, or any repository of yours: every byte lands in a
temp directory that is deleted on exit.

## Run it

```
pnpm sandbox                         # scenario "chat" + dev server, prints a URL
pnpm sandbox --scenario git-dirty
pnpm sandbox list                    # what scenarios exist
```

The printed URL pairs the app in one step. HMR works: edit
`apps/web/src/**` and the page updates against the same backend.

## Screenshot it

```
pnpm sandbox:shot                              # every scenario -> .sandbox/shots
pnpm sandbox:shot --scenario chat --tap api    # open a session first
pnpm sandbox:shot --tap api --tap main         # --tap repeats: several taps deep
pnpm sandbox:shot --scenario chat --text       # also print the rendered text
pnpm sandbox:shot --headed                     # watch it happen
```

Shots are taken in a 390x844 phone viewport through Chrome DevTools. Set
`PIOS_CHROME` if your browser is not on `PATH` under a usual name.

## Add a scenario

Scenarios are data, in `src/scenarios/`. Declare the end state you need
instead of scripting a conversation to reach it:

```ts
export default scenario("my-bug", {
  description: "What this reproduces",
  sessions: [
    {
      id: "sbx-my-bug",
      name: "api",
      repo: { base: { "src/a.ts": "..." }, modified: { "src/a.ts": "..." } },
      entries: [user("do the thing"), ...tool("t1", "bash", { command: "ls" }, "a\nb")],
    },
  ],
});
```

Register it in `src/scenarios/index.ts`. Entry builders are in
`src/transcript.ts`; repo fixtures in `src/repo.ts`.

## Drive it from a test

```ts
const sandbox = await startSandbox({ scenario: "git-dirty" });
// sandbox.baseUrl, sandbox.deviceToken, sandbox.server, sandbox.sessions
await sandbox.close();
```

## Talking to the stub agent

The stub echoes prompts and reacts to magic words: `ASK_DIALOG`, `SLOW_TOOL`,
`CRASH_NOW`, `CRASH_MIDSTREAM`, `RATE_LIMIT` (retries run out),
`RATE_LIMIT_ONCE` (one retry, then an answer). See `packages/pi-host/test/fake-pi.ts`.
