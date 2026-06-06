#!/usr/bin/env bash
# Install the snapstack server as a macOS LaunchAgent:
# starts at login, restarts on crash, and self-updates on each (re)start
# (via deploy/snapstack-start.sh). Idempotent — safe to re-run.
set -euo pipefail

command -v node >/dev/null 2>&1 || { echo "node not found in PATH. Install Node.js >= 18 first." >&2; exit 1; }
command -v git  >/dev/null 2>&1 || echo "warning: git not found — auto-update at launch will be skipped." >&2

DIR="$(cd "$(dirname "$0")/.." && pwd)"
LAUNCHER="$DIR/deploy/snapstack-start.sh"
chmod +x "$LAUNCHER"

LABEL="com.snapstack.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>$LAUNCHER</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/snapstack.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/snapstack.err.log</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "Installed and loaded: $PLIST"
echo "  launcher : $LAUNCHER"
echo "  logs     : /tmp/snapstack.out.log  /tmp/snapstack.err.log"
echo "Uninstall: launchctl unload \"$PLIST\" && rm \"$PLIST\""
