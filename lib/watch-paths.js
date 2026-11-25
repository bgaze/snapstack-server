import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Where does this OS's screenshot tool save, and which folder should SnapStack
// watch? Pure functions over injected platform / home / env / exec / exists,
// so every OS branch is testable anywhere.

const MAC_DOMAIN = 'com.apple.screencapture';
// Windows known folder "Screenshots" (Win+PrtScn, Snipping Tool auto-save).
const WIN_SCREENSHOTS_GUID = '{B7BEDE81-DF94-4682-A7D8-57A52620B86F}';
const WIN_SHELL_FOLDERS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders';

/** Default exec: run a command, never throw. */
export function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

function expandHome(p, home) {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

/** The universal fallback: a "Screenshots" folder under the user's Pictures. */
export function picturesScreenshots(home = os.homedir()) {
  return path.join(home, 'Pictures', 'Screenshots');
}

/**
 * macOS folders a launchd agent MAY be kept out of (privacy protection):
 * Desktop, Documents, Downloads, iCloud Drive. It depends on the machine — a
 * node binary granted access earlier reads them — so this only drives the
 * proposed default and a note; the daemon's real verdict decides.
 */
export function isProtectedForService(dir, { platform = process.platform, home = os.homedir() } = {}) {
  if (platform !== 'darwin') return false;
  const abs = path.resolve(expandHome(dir, home));
  return ['Desktop', 'Documents', 'Downloads', path.join('Library', 'Mobile Documents')]
    .map((d) => path.join(home, d))
    .some((p) => abs === p || abs.startsWith(p + path.sep));
}

/** macOS: the screenshot `location` preference, or null when unset. */
export function macLocation({ home = os.homedir(), exec = run } = {}) {
  const r = exec('defaults', ['read', MAC_DOMAIN, 'location']);
  return r.code === 0 && r.stdout ? path.resolve(expandHome(r.stdout, home)) : null;
}

/**
 * The folder the OS screenshot tool writes to today, and the one to propose.
 * Returns { current, effective, proposed, protected }:
 * - current   : the configured destination (macOS `location`, Windows known
 *               folder, Linux Pictures/Screenshots), or null;
 * - effective : where screenshots actually land (macOS falls back to the
 *               Desktop when `location` is unset or points at a missing folder);
 * - proposed  : the folder SnapStack suggests watching;
 * - protected : true when `effective` is unreadable by the service (macOS).
 */
export function screenshotFolders({
  platform = process.platform, home = os.homedir(), env = process.env, exec = run, exists = existsSync,
} = {}) {
  if (platform === 'darwin') {
    const current = macLocation({ home, exec });
    const effective = current && exists(current) ? current : path.join(home, 'Desktop');
    const prot = isProtectedForService(effective, { platform, home });
    return { current, effective, proposed: prot ? picturesScreenshots(home) : effective, protected: prot };
  }
  if (platform === 'win32') {
    const r = exec('reg', ['query', WIN_SHELL_FOLDERS, '/v', WIN_SCREENSHOTS_GUID]);
    const m = /REG_(?:EXPAND_)?SZ\s+(.+)$/m.exec(r.code === 0 ? r.stdout : '');
    const current = m
      ? m[1].trim().replace(/%([^%]+)%/g, (all, name) => env[name] ?? env[name.toUpperCase()] ?? all)
      : null;
    const effective = current ?? picturesScreenshots(home);
    return { current, effective, proposed: effective, protected: false };
  }
  const r = exec('xdg-user-dir', ['PICTURES']);
  const pictures = r.code === 0 && r.stdout && r.stdout !== home ? r.stdout : path.join(home, 'Pictures');
  const effective = path.join(pictures, 'Screenshots');
  return { current: effective, effective, proposed: effective, protected: false };
}

// --- macOS redirect (wizard only, after an explicit yes) -------------------

/** The command that points macOS screenshots at `dir`. */
export function macRedirectCommand(dir) {
  return ['defaults', ['write', MAC_DOMAIN, 'location', dir]];
}

/** The command that restores the previous destination (`previous` null = unset). */
export function macUndoCommand(previous) {
  return previous
    ? ['defaults', ['write', MAC_DOMAIN, 'location', previous]]
    : ['defaults', ['delete', MAC_DOMAIN, 'location']];
}

/** Render a [cmd, args] pair as a copy-pasteable POSIX shell line. */
export function formatCommand([cmd, args]) {
  const q = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
  return [cmd, ...args].map(q).join(' ');
}

/** Apply the redirect, then read it back. True when macOS now reports `dir`. */
export function applyMacRedirect(dir, { home = os.homedir(), exec = run } = {}) {
  const [cmd, args] = macRedirectCommand(dir);
  if (exec(cmd, args).code !== 0) return false;
  return macLocation({ home, exec }) === path.resolve(dir);
}
