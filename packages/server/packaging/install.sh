#!/usr/bin/env bash
# Installs pios-server as a systemd --user unit.
#
# User scope, not system scope: the daemon runs the agent as you, with your
# files and your credentials. Nothing here needs root.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
bin_dir="${HOME}/.local/bin"
unit_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"

command -v node >/dev/null || { echo "node is required" >&2; exit 1; }
command -v pi >/dev/null || echo "warning: pi is not on PATH; sessions will fail to start" >&2

# systemd --user starts with a minimal PATH (/usr/local/bin:/usr/bin), and the
# daemon spawns `pi`. Version managers like nvm put both node and pi somewhere
# else entirely, so the paths are resolved now and baked into the shim.
tool_path="$(dirname "$(command -v node)")"
if command -v pi >/dev/null; then
  tool_path="${tool_path}:$(dirname "$(command -v pi)")"
fi

mkdir -p "${bin_dir}" "${unit_dir}"

# The node is the tailnet's MagicDNS name; `tailscale serve` terminates https
# for it with a cert tailscale issues, which is what iOS needs.
tailscale_url() {
  command -v tailscale >/dev/null || return 1
  local name
  name="$(tailscale status --json 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try { process.stdout.write((JSON.parse(s).Self?.DNSName ?? "").replace(/\.$/, "")); } catch {}
    });')"
  [[ -n "${name}" ]] && echo "https://${name}"
}

if [[ -n "${PIOS_RELAY_URL:-}" && -n "${PIOS_PUBLIC_URL:-}" ]]; then
  echo "set PIOS_RELAY_URL or PIOS_PUBLIC_URL, not both" >&2
  exit 1
fi

# Env vars skip the prompt so scripted installs stay non-interactive.
if [[ -z "${PIOS_RELAY_URL:-}" && -z "${PIOS_PUBLIC_URL:-}" && -t 0 ]]; then
  echo "How should your phone reach this machine?"
  echo "  1) Cloudflare relay   (works from any network, needs the Worker deployed)"
  echo "  2) Tailscale serve    (phone must be on your tailnet, no Cloudflare)"
  route_choice=""
  until [[ "${route_choice}" == 1 || "${route_choice}" == 2 ]]; do
    read -r -p "Choice [1-2]: " route_choice
  done
  if [[ "${route_choice}" == 1 ]]; then
    until [[ -n "${PIOS_RELAY_URL:-}" ]]; do
      read -r -p "Relay URL (https://pios-relay.<you>.workers.dev): " PIOS_RELAY_URL
    done
  else
    detected="$(tailscale_url || true)"
    if [[ -n "${detected}" ]]; then
      read -r -p "Tailscale URL [${detected}]: " PIOS_PUBLIC_URL
      PIOS_PUBLIC_URL="${PIOS_PUBLIC_URL:-${detected}}"
    fi
    until [[ -n "${PIOS_PUBLIC_URL:-}" ]]; do
      read -r -p "Tailscale URL (https://<host>.<tailnet>.ts.net): " PIOS_PUBLIC_URL
    done
  fi
fi

setup_tailscale_serve=0
if [[ -n "${PIOS_PUBLIC_URL:-}" && "${PIOS_PUBLIC_URL}" == *.ts.net* ]] && command -v tailscale >/dev/null; then
  setup_tailscale_serve=1
fi

# The daemon serves the PWA from apps/web/dist on its own origin. Service
# workers, Web Push, and installing to the iOS home screen all need one secure
# origin, and a separate dev server is neither built nor secure.
if command -v pnpm >/dev/null; then
  (cd "${repo_root}" && pnpm -F @pios/web build)
else
  echo "warning: pnpm not found; run 'pnpm -F @pios/web build' to serve the app" >&2
fi

# Baked into the shim so the daemon and the CLI (`pair`, `relay enroll`) agree
# on the relay without a second place to configure it. The environment still
# wins, so a one-off override needs no reinstall.
relay_line=""
if [[ -n "${PIOS_RELAY_URL:-}" ]]; then
  relay_line="export PIOS_RELAY_URL=\"\${PIOS_RELAY_URL:-${PIOS_RELAY_URL}}\""
fi
public_line=""
if [[ -n "${PIOS_PUBLIC_URL:-}" ]]; then
  public_line="export PIOS_PUBLIC_URL=\"\${PIOS_PUBLIC_URL:-${PIOS_PUBLIC_URL}}\""
fi

cat > "${bin_dir}/pios-server" <<EOF
#!/usr/bin/env bash
export PATH="${tool_path}:\${PATH}"
${relay_line}
${public_line}
exec node "${repo_root}/packages/server/src/cli.ts" "\$@"
EOF
chmod +x "${bin_dir}/pios-server"

install -m 0644 "${repo_root}/packages/server/packaging/pios-server.service" \
  "${unit_dir}/pios-server.service"

systemctl --user daemon-reload
systemctl --user enable pios-server.service
# `enable --now` leaves an already-running daemon on the old code and shim.
systemctl --user restart pios-server.service

# Without this the daemon stops when the last login session ends, which defeats
# the entire point of a daemon that owns long-running agents.
if ! loginctl show-user "${USER}" --property=Linger | grep -q "yes"; then
  echo
  echo "Enable lingering so sessions survive logout:"
  echo "  sudo loginctl enable-linger ${USER}"
fi

if [[ "${setup_tailscale_serve}" == 1 ]]; then
  # Needs operator rights on most installs; failing here must not undo the install.
  if ! tailscale serve --bg 4111 >/dev/null 2>&1; then
    echo
    echo "Could not run 'tailscale serve' (try: sudo tailscale set --operator=${USER}). Then:"
    echo "  tailscale serve --bg 4111"
  fi
fi

echo
if [[ -n "${PIOS_RELAY_URL:-}" ]]; then
  echo "Relay: ${PIOS_RELAY_URL}. If this daemon is not enrolled yet:"
  echo "  pios-server relay enroll"
  echo "  systemctl --user restart pios-server"
  echo
fi
if [[ -n "${PIOS_PUBLIC_URL:-}" ]]; then
  echo "Public URL: ${PIOS_PUBLIC_URL} (proxied to 127.0.0.1:4111)"
  echo
fi
if [[ -z "${PIOS_RELAY_URL:-}" && -z "${PIOS_PUBLIC_URL:-}" ]]; then
  echo "Installed for local use only. To reach it from a phone, rerun with either:"
  echo "  PIOS_RELAY_URL=https://pios-relay.<you>.workers.dev ${BASH_SOURCE[0]}"
  echo "  PIOS_PUBLIC_URL=https://<host>.<tailnet>.ts.net ${BASH_SOURCE[0]}"
else
  echo "Pair a device with:"
  echo "  pios-server pair"
fi
