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

mkdir -p "${bin_dir}" "${unit_dir}"

cat > "${bin_dir}/pios-server" <<EOF
#!/usr/bin/env bash
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
echo "Installed. Pair a device with:"
echo "  pios-server pair"
