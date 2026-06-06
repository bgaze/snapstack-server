#!/usr/bin/env bash
# Install the snapstack server as a macOS LaunchAgent (starts at login, restarts on crash).
set -euo pipefail

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "node not found in PATH. Install Node.js >= 18 first." >&2
  exit 1
fi

SERVER="$(cd "$(dirname "$0")/../server" && pwd)/snapstack-server.js"
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
    <string>$NODE_BIN</string>
    <string>$SERVER</string>
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
echo "  node   : $NODE_BIN"
echo "  server : $SERVER"
echo "  logs   : /tmp/snapstack.out.log  /tmp/snapstack.err.log"
echo "Uninstall: launchctl unload \"$PLIST\" && rm \"$PLIST\""
