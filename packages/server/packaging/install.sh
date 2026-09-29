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

cat > "${bin_dir}/pios-server" <<EOF
#!/usr/bin/env bash
export PATH="${tool_path}:\${PATH}"
${relay_line}
exec node "${repo_root}/packages/server/src/cli.ts" "\$@"
EOF
chmod +x "${bin_dir}/pios-server"

install -m 0644 "${repo_root}/packages/server/packaging/pios-server.service" \
  "${unit_dir}/pios-server.service"

systemctl --user daemon-reload
systemctl --user enable --now pios-server.service

# Without this the daemon stops when the last login session ends, which defeats
# the entire point of a daemon that owns long-running agents.
if ! loginctl show-user "${USER}" --property=Linger | grep -q "yes"; then
  echo
  echo "Enable lingering so sessions survive logout:"
  echo "  sudo loginctl enable-linger ${USER}"
fi

echo
if [[ -z "${PIOS_RELAY_URL:-}" ]]; then
  echo "Installed for local use only. To reach it from a phone, deploy the relay"
  echo "(packages/relay/README.md) and rerun with its URL:"
  echo "  PIOS_RELAY_URL=https://pios-relay.<you>.workers.dev ${BASH_SOURCE[0]}"
else
  echo "Installed with relay ${PIOS_RELAY_URL}. If this daemon is not enrolled yet:"
  echo "  pios-server relay enroll"
  echo "  systemctl --user restart pios-server"
  echo
  echo "Then pair a device with:"
  echo "  pios-server pair"
fi
