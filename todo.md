- surface errors (e.g. rate limits), plus summarization_retry_* / setWidget /
  set_editor_text, which are parsed but never rendered
- /name slash command on set_session_name
- compaction UI: compact + set_auto_compaction
- absorb cc-usage into packages/server/src/usage.ts instead of shelling out
- pios sessions in background, do we need to keep them open/running?
- one-shot bash over rpc: single command, streamed via bash_execution_update,
  abort_bash to cancel, excludeFromContext toggle per command. Serialised per
  session (abort_bash has no id). Not the terminal.
- terminal (needs a real PTY; one-shot bash does not grow into it)
- chat header: too many controls in one flex row. Split into smaller pieces
  with room to expand (overflow menu or a second row), then move the file
  button into it properly
- add missing native commands
- @ fuzzy picker must be daemon-side: RPC mode no-ops addAutocompleteProvider
  and setEditorComponent, so pi-fzfp cannot serve the client. Upstream idea:
  an RPC command that runs registered providers and returns AutocompleteItems
- reference pi-remote
  - relay shape to copy (pi-remote): one durable object per paired host, agent
    dials out, phone dials in, object forwards by socket role and never reads
    payloads. Pair code short-lived and single-use, tokens hashed, check route
    before connect so a revoked client forgets instead of retrying.
  - e2e envelope (HKDF + AES-GCM + chunked parts) only earns its place once a
    relay exists. Not needed while the daemon is reached directly.
- session list: docked column / overlay drawer, one component (plan phase 7.2)
- fix floating input with no keyboard on app reopen bug
