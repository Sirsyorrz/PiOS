- fullscreen git rework: git as a full-screen view like the file editor
  instead of the floating control over the transcript (status, diff, log,
  branches and stashes in one place)
- absorb cc-usage into packages/server/src/usage.ts instead of shelling out
- terminal (needs a real PTY; one-shot bash does not grow into it)
- missing native commands: pi names it `/thinking`, not `/think`; `/copy`
  (last answer), `/session` (stats), `/reload`, `/export`
- @ fuzzy picker must be daemon-side: RPC mode no-ops addAutocompleteProvider
  and setEditorComponent, so pi-fzfp cannot serve the client. Upstream idea:
  an RPC command that runs registered providers and returns AutocompleteItems
- relay: the phase 7.8 exit check on a real phone over cellular

Verify on the phone (fixed, but only reproducible on iOS):
- floating composer with no keyboard after reopening the app
- resuming a cold session: model shown, and a first prompt that is visible
  while it streams
