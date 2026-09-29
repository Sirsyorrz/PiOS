# @pios/relay

A Cloudflare Worker that lets a phone reach `pios-server` without a VPN. The
daemon dials out to the relay, and the phone talks to the relay over HTTPS.
The relay serves the PWA and carries every route by forwarding it to the
daemon.

The relay sees plaintext and authorizes nothing on the phone side. Device
tokens are checked by the daemon. The relay only decides who may be the
daemon: whoever holds the Ed25519 key it enrolled. It also caps what any one
address can hold open (handshakes, sockets, requests, 32 MiB bodies), since
all of it is reachable without credentials.

`PIOS_RELAY_URL` must be `https://`; plain `http://` is accepted only for a
loopback `wrangler dev`.

## One-time Cloudflare setup

1. Create a Cloudflare account (the free plan is enough) and log in:

   ```
   pnpm -F @pios/relay exec wrangler login
   ```

2. If the account has never used Workers, open the Workers dashboard once and
   pick a `workers.dev` subdomain. The relay then lives at
   `https://pios-relay.<subdomain>.workers.dev`.

3. Deploy:

   ```
   pnpm -F @pios/relay run deploy
   ```

   The Durable Object is SQLite-backed, which the free plan supports. The
   migration in `wrangler.toml` creates it on first deploy.

4. Set the enrollment secret (32+ characters). Wrangler prompts for the value,
   so it never lands in shell history:

   ```
   openssl rand -base64 32        # copy the output
   pnpm -F @pios/relay exec wrangler secret put ENROLL_SECRET
   ```

## Connect the daemon

```
PIOS_RELAY_URL=https://pios-relay.<subdomain>.workers.dev packages/server/packaging/install.sh
pios-server relay enroll          # paste the same secret
systemctl --user restart pios-server
journalctl --user -u pios-server -f   # expect "relay: online at ..."
pios-server pair                  # open the printed link on the phone
```

Then use Share > Add to Home Screen on the phone, and turn on notifications in
Settings.

## Rotating, and what the secret does

The secret is used once. Enrolling binds the daemon's key
(`~/.pios/relay-key.json`, mode 0600), and after that the daemon gets in by
signing a fresh nonce. The same secret cannot enroll a second key.

To move to a new machine or a new key, set a new secret with
`wrangler secret put ENROLL_SECRET` and run `pios-server relay enroll` there.
Rotation alone does not lock out the current key; enrolling a new key does.

If a key you enrolled gets replaced, the old daemon logs `REFUSED` and sends a
"relay host key replaced" push. If you did not cause it, rotate the secret and
enroll again right away, and revoke devices with `pios-server revoke --all`.

`pios-server relay key` prints this daemon's public key fingerprint.

## Development

```
pnpm -F @pios/relay test          # codec + enrollment unit tests, Worker typecheck
pnpm -F @pios/server test         # includes relay.test.ts: wrangler dev + a real daemon
pnpm -F @pios/relay dev           # local relay on :8787
```
