#!/usr/bin/env bash
# Install the snapstack server as a systemd --user service:
# starts at login, restarts on failure, and self-updates on each (re)start
# (via deploy/snapstack-start.sh). Idempotent — safe to re-run.
set -euo pipefail

command -v node >/dev/null 2>&1 || { echo "node not found in PATH. Install Node.js >= 18 first." >&2; exit 1; }
command -v git  >/dev/null 2>&1 || echo "warning: git not found — auto-update at launch will be skipped." >&2

DIR="$(cd "$(dirname "$0")/.." && pwd)"
LAUNCHER="$DIR/deploy/snapstack-start.sh"
chmod +x "$LAUNCHER"

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/snapstack.service"

mkdir -p "$UNIT_DIR"
cat > "$UNIT" <<EOF
[Unit]
Description=snapstack capture + MCP server (local)
After=network.target

[Service]
ExecStart=/usr/bin/env sh $LAUNCHER
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now snapstack.service

echo "Installed: $UNIT"
echo "  launcher : $LAUNCHER"
echo "Status : systemctl --user status snapstack"
echo "Logs   : journalctl --user -u snapstack -f"
echo "Uninstall: systemctl --user disable --now snapstack.service && rm \"$UNIT\" && systemctl --user daemon-reload"
