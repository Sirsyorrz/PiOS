# Setting up PiOS

PiOS has three parts:

- `pios-server`, a daemon on your machine that runs `pi` sessions as you.
- A Cloudflare relay that the phone talks to. The daemon dials out to it, so
  nothing on your machine has to be reachable from the internet.
- The PWA, which the daemon serves through the relay and which you install to
  the home screen.

Linux with systemd is the supported host. macOS and Windows are not done yet.

## Requirements

- Node 22.18 or newer, and pnpm. The daemon runs its TypeScript sources
  directly, which needs Node's built-in type stripping.
- `pi` on `PATH`, logged in to at least one provider. The daemon starts
  `pi --mode rpc` for each session and uses your existing pi config,
  credentials and sessions.
- A Cloudflare account (the free plan is enough) for the relay.

## Install the daemon

```
pnpm install
PIOS_RELAY_URL=https://pios-relay.<you>.workers.dev packages/server/packaging/install.sh
```

The script:

- builds the PWA into `apps/web/dist`;
- writes a `~/.local/bin/pios-server` shim with the current `node`, `pi` and
  relay URL baked in, because `systemd --user` starts with a minimal `PATH`;
- installs and starts `pios-server.service` as a user unit.

Enable lingering so sessions keep running after you log out (this needs sudo):

```
sudo loginctl enable-linger $USER
```

To pick up a code change, rebuild the app and restart the daemon:

```
pnpm build:web && systemctl --user restart pios-server
```

## Set up the relay

Follow `packages/relay/README.md` once: deploy the Worker, set its enrollment
secret, then enroll this machine with `pios-server relay enroll`. Only the
machine holding the enrolled key can act as the daemon behind that relay.

## Pair a phone

```
pios-server pair
```

This prints a link that is valid for 10 minutes, plus a confirmation code. On
the phone:

1. Open the link in Safari. The pairing token is in the URL fragment, so it
   never reaches a server log.
2. Pair, then use Share > Add to Home Screen. Push notifications on iOS only
   work from the installed app.
3. In the installed app, turn on notifications in Settings.

Device management:

```
pios-server devices            # list paired devices
pios-server revoke <deviceId>  # or --all
```

A revoked device notices on its next connection, forgets the machine and
returns to the pairing screen.

## Configuration

All configuration is through environment variables. Put them in a drop-in such
as `~/.config/systemd/user/pios-server.service.d/override.conf`:

| Variable | Default | Meaning |
|---|---|---|
| `PIOS_RELAY_URL` | unset | The relay origin. Without it the app only works on this machine. |
| `PIOS_BIND` | `127.0.0.1` | Listen address. The relay connector dials loopback, so leave it. |
| `PIOS_PORT` | `4111` | Listen port. |
| `PIOS_DATA_DIR` | `~/.pios` | Device tokens (hashed), push keys, relay key, session index cache. |
| `PIOS_SESSION_DIR` | `~/.pi/agent/sessions` | pi's session store. This is the session list. |
| `PI_AGENT_DIR` | `~/.pi/agent` | pi's config: model scope and project trust. |
| `PIOS_HOST` | `subprocess` | `in-process` runs pi inside the daemon. One crash then takes every session down. |
| `PIOS_WEB_DIR` | `apps/web/dist` | Built PWA to serve. |
| `PIOS_PUSH_SUBJECT` | relay URL | VAPID subject for Web Push. |

## Troubleshooting

Logs:

```
journalctl --user -u pios-server -f
```

| Symptom | Likely cause |
|---|---|
| "Machine offline" banner | The daemon is not connected to the relay. Check the logs for `relay: online`. |
| `relay: this daemon is not enrolled` | Run `pios-server relay enroll`. |
| Sessions never start; `cannot run "pi"` in the logs | `pi` was not on `PATH` when `install.sh` ran. Rerun it from a shell where `pi` works. |
| App is back on the pairing screen | The device was revoked on the machine. Pair again. |
| No notifications on iPhone | The app must be installed to the home screen, and notifications enabled from Settings inside it. |
| An old variable such as `PIOS_PUBLIC_URL` in a drop-in | It is ignored. The relay replaced it; remove it. |

## Working on the app

Never point a development build at a real agent or a real repository. The
sandbox runs the real daemon against a stub pi, in temp directories only:

```
pnpm sandbox                         # live app + stub agent, prints a URL that pairs itself
pnpm sandbox list                    # scenarios
pnpm sandbox:shot --tap api          # phone-sized screenshots into .sandbox/shots
pnpm test                            # typecheck and every package's tests
pnpm test:browser                    # the PWA end to end in headless Chrome
```

Details, scenarios and the stub agent's magic words are in
`packages/sandbox/README.md`. `pnpm test:browser` needs Chrome or Chromium on
`PATH`, or `PIOS_CHROME` pointing at one.
