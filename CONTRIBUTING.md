# Contributing

## Before you open a PR

```sh
pnpm test           # typecheck + unit suites
pnpm test:browser   # sandbox browser tests, for UI changes
```

Both must pass. Every behavioural change ships with a test; every bug fix ships
with a regression test. Protocol changes ship with a fixture-replay test.

## PR structure

Keep it brief. Two sections:

**Summary** - what changed and why, in a few lines.

**Test Plan** - the automated tests you added or ran, plus the manual steps you
took. Include screenshots or a short recording for anything visible in the UI
(`pnpm sandbox:shot` produces phone-sized screenshots).

If you used an LLM or a coding agent, please include a human-written foreword
saying what you asked for and what you checked yourself.
