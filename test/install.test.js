import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  appDir,
  nodeBinDir,
  launcherSh,
  launcherPs1,
  launcherVbs,
  plist,
  systemdUnit,
} from '../lib/install.js';

// The auto-start unit needs to run with a minimal PATH, so node/npm must be
// resolved to an absolute dir at install time and the run step must work offline.
// These cover the pure content generators; the side-effecting install/uninstall
// (launchctl/systemctl/scheduled-task) are exercised by hand per OS.

const home = '/home/u';

test('appDir picks the stable per-OS install location', () => {
  assert.equal(appDir('darwin', {}, home), '/home/u/Library/Application Support/snapstack');
  assert.equal(appDir('linux', {}, home), '/home/u/.local/share/snapstack');
  assert.equal(appDir('linux', { XDG_DATA_HOME: '/xdg' }, home), '/xdg/snapstack');
  assert.equal(appDir('win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, home), path.join('C:\\Users\\u\\AppData\\Local', 'snapstack'));
});

test('nodeBinDir is the absolute dir holding the node executable', () => {
  assert.equal(nodeBinDir('/usr/local/bin/node'), '/usr/local/bin');
});

test('POSIX launcher updates best-effort then runs the local install (offline-safe)', () => {
  const sh = launcherSh({ dir: '/home/u/.local/share/snapstack', binDir: '/usr/local/bin' });
  assert.match(sh, /^#!\/bin\/sh/);
  assert.match(sh, /export PATH="\/usr\/local\/bin:\$PATH"/); // absolute node/npm dir
  assert.match(sh, /npm install --prefix "\$PREFIX" snapstack-server@latest .*\|\| true/); // best-effort
  assert.match(sh, /exec "\$PREFIX\/node_modules\/\.bin\/snapstack-server"/); // run local, offline-safe
});

test('Windows launcher mirrors the POSIX contract', () => {
  const ps = launcherPs1({ dir: 'C:\\app\\snapstack', binDir: 'C:\\nodejs' });
  assert.match(ps, /\$env:Path = "C:\\nodejs;\$env:Path"/);
  assert.match(ps, /npm install --prefix \$prefix snapstack-server@latest/);
  // node.exe called directly (not .cmd) so no cmd.exe CREATE_NEW_CONSOLE popup
  assert.match(ps, /C:\\nodejs\\node\.exe.*snapstack-server\\snapstack-server\.js/);
});

test('VBScript shim runs PowerShell hidden via WshShell.Run style 0', () => {
  const vbs = launcherVbs({ launcher: 'C:\\app\\snapstack\\snapstack-launch.ps1' });
  assert.match(vbs, /WScript\.Shell/);
  assert.match(vbs, /WindowStyle Hidden/);
  assert.match(vbs, /snapstack-launch\.ps1/);
  assert.match(vbs, /, 0, True/); // SW_HIDE, bWaitOnReturn
});

test('launchd plist points at /bin/sh + the generated launcher', () => {
  const p = plist({ launcher: '/home/u/Library/Application Support/snapstack/snapstack-launch.sh' });
  assert.match(p, /<string>com\.snapstack\.server<\/string>/);
  assert.match(p, /<string>\/bin\/sh<\/string>/);
  assert.match(p, /snapstack-launch\.sh<\/string>/);
  assert.match(p, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(p, /<key>KeepAlive<\/key>\s*<true\/>/);
});

test('systemd unit runs the launcher and restarts on failure', () => {
  const u = systemdUnit({ launcher: '/home/u/.local/share/snapstack/snapstack-launch.sh' });
  assert.match(u, /ExecStart=\/usr\/bin\/env sh \/home\/u\/\.local\/share\/snapstack\/snapstack-launch\.sh/);
  assert.match(u, /Restart=on-failure/);
  assert.match(u, /WantedBy=default\.target/);
});
