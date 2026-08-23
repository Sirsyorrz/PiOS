#!/usr/bin/env bash
# Manual end-to-end smoke test against a real daemon and real pi.
#
#   ./test/smoke.sh
#
# Starts a daemon on a scratch data dir, pairs with curl, then drives one
# session over the socket: prompt, disconnect, reconnect, resync by entry id.
# Uses websocat when present and a bundled node client otherwise.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
port="${PIOS_PORT:-4211}"
trap 'kill %1 2>/dev/null || true; rm -rf "${work}"' EXIT

echo "== starting daemon on port ${port} (data: ${work}) =="
PIOS_PORT="${port}" PIOS_DATA_DIR="${work}/data" node "${here}/../src/cli.ts" serve &
sleep 1.5

base="http://127.0.0.1:${port}"
curl -sf "${base}/health" | tee /dev/stderr >/dev/null
echo

echo "== pairing =="
pair_output="$(PIOS_PORT="${port}" PIOS_DATA_DIR="${work}/data" node "${here}/../src/cli.ts" pair)"
echo "${pair_output}"
pairing_token="$(sed -n 's/.*#pt=\(.*\)$/\1/p' <<<"${pair_output}" | tr -d '[:space:]')"

device_token="$(curl -sf -X POST "${base}/pair" \
  -d "{\"pairingToken\":\"${pairing_token}\",\"label\":\"smoke\"}" |
  sed -n 's/.*"deviceToken":"\([^"]*\)".*/\1/p')"
test -n "${device_token}"
echo "device token acquired"

echo "== unauthenticated request is refused =="
code="$(curl -s -o /dev/null -w '%{http_code}' "${base}/sessions")"
test "${code}" = "401" || { echo "expected 401, got ${code}"; exit 1; }

echo "== driving a session over the socket =="
PIOS_TOKEN="${device_token}" PIOS_URL="ws://127.0.0.1:${port}/ws" \
  node "${here}/ws-smoke.ts" "$(pwd)"

echo "== sessions after the run =="
curl -sf "${base}/sessions" -H "Authorization: Bearer ${device_token}"
echo
echo "OK"
