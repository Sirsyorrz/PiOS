- surface errors (e.g. rate limits), plus summarization_retry_* / setWidget /
  set_editor_text, which are parsed but never rendered
- /name slash command on set_session_name
- compaction UI: compact + set_auto_compaction
- absorb cc-usage into packages/server/src/usage.ts instead of shelling out
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
- session model follow-ups
  - push for a turn finished in the TUI: the store watcher sees the file
    change, but notifications still come only from a live process
  - the list is ordered by mtime; a long unattended run outranks the
    conversation you were just in

- when editing a file while agent is running, every time the agent updates transcript, the text editor refreshes
- the git status pill sometimes doesnt show in header?
