# snapstack launcher (Windows).
# Called by the logon scheduled task instead of `node` directly, so each start
# self-updates: pull the latest code, make sure deps are present, then run.
# Every update step is best-effort — offline, a non-git install, or a merge
# conflict never blocks the server from starting (capture intake must stay up).
$ErrorActionPreference = 'SilentlyContinue'

# This script lives in deploy/ — the repo root is its parent.
Set-Location (Split-Path -Parent $PSScriptRoot)

git pull --ff-only *> $null
npm install --omit=dev --silent *> $null

node snapstack-server.js
