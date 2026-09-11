- git integration: remote operations (fetch/pull/push), branch switching
- surface errors (e.g. rate limits)
- pios sessions in background, do we need to keep them open/running?
- terminal
- text editor
- @ fuzzy file picker
- add missing native commands
- reference pi-remote, what can we learn/improve, can we relay, rather than tailscale?
  - relay shape to copy (pi-remote): one durable object per paired host, agent
    dials out, phone dials in, object forwards by socket role and never reads
    payloads. Pair code short-lived and single-use, tokens hashed, check route
    before connect so a revoked client forgets instead of retrying.
  - e2e envelope (HKDF + AES-GCM + chunked parts) only earns its place once a
    relay exists. Not needed while the daemon is reached directly.
- session list: docked column / overlay drawer, one component (plan phase 7.2)
- add easy way for agents to setup/run/test the webapp
