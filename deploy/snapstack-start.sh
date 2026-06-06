#!/usr/bin/env sh
# snapstack launcher (macOS / Linux).
# Called by the auto-start units instead of `node` directly, so each (re)start
# self-updates: pull the latest code, make sure deps are present, then run.
# Every update step is best-effort — offline, a non-git install, or a merge
# conflict never blocks the server from starting (capture intake must stay up).
set -u

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR" || exit 1

git pull --ff-only >/dev/null 2>&1 || true
npm install --omit=dev --silent >/dev/null 2>&1 || true

exec node snapstack-server.js
