import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { readWatchSettings, readWatchState, writeWatchSettings } from './watch-settings.js';
import {
  formatCommand, isProtectedForService, macLocation, macRedirectCommand,
} from './watch-paths.js';

// `snapstack watch …` — the ONLY way to set the watched folder (never HTTP).
//   snapstack watch                       wizard in a terminal; status + usage otherwise
//   snapstack watch <dir> [--delete-original|--keep-original]
//   snapstack watch off
// The direct form never touches OS preferences: it prints the macOS redirect
// command instead (only the wizard may run it, after an explicit yes).

export const USAGE = `Usage:
  snapstack watch                     Guided setup (in a terminal)
  snapstack watch <folder> [--delete-original | --keep-original]
                                      Watch <folder>: each new screenshot goes to the stack
                                      (the original is kept unless --delete-original)
  snapstack watch off                 Stop watching
`;

const VERDICT_TIMEOUT_MS = 10_000;

/** Human explanation + remedy for a daemon error verdict. */
export function explainError(error, { platform = process.platform } = {}) {
  const code = error?.code;
  if ((code === 'EPERM' || code === 'EACCES') && platform === 'darwin') {
    return 'macOS does not let the background service read this folder (privacy protection) — pick another one, e.g. ~/Pictures/Screenshots';
  }
  if (code === 'EPERM' || code === 'EACCES') return 'the service is not allowed to read this folder — pick another one';
  if (code === 'ENOENT') return 'the folder does not exist (anymore)';
  if (code === 'ENOTDIR') return 'this is not a folder';
  if (code === 'ESTACKDIR') return 'this is the SnapStack stack folder itself — pick the folder your screenshots are saved to';
  return error?.message || 'unknown error';
}

/**
 * The "Watch folder" row of `snapstack status`, from the setting, the daemon
 * verdict and the live /health probe. A verdict only counts when it answers
 * the CURRENT setting (same activatedAt) and the server is up.
 * Returns { tone: 'off'|'ok'|'warn'|'error', label, info, hint }.
 */
export function watchSummary({ settings, state, health }) {
  if (!settings.enabled) return { tone: 'off', label: 'off', info: null, hint: "run 'snapstack watch'" };
  const dir = settings.dir;
  if (!health) return { tone: 'warn', label: 'paused', info: dir, hint: 'server down' };
  // No verdict for THIS activation: just written, or a server that predates
  // the feature (it never answers) — capability is proven by the answer, not
  // inferred from a version number.
  if (!state || state.activatedAt !== settings.activatedAt) {
    return { tone: 'warn', label: 'pending', info: dir, hint: "no answer from the server yet — if this lasts, run 'snapstack update'" };
  }
  if (state.status === 'error') return { tone: 'error', label: 'error', info: dir, hint: explainError(state.error) };
  const last = state.lastIngest ? ` · last: #${state.lastIngest.number} from ${state.lastIngest.source ?? state.lastIngest.name}` : '';
  return { tone: 'ok', label: 'watching', info: `${dir}${settings.deleteOriginal ? ' · originals deleted' : ''}${last}`, hint: null };
}

/** Poll watch-state.json until the daemon answers `activatedAt` (or time out → null). */
export async function waitForVerdict(activatedAt, { timeoutMs = VERDICT_TIMEOUT_MS, intervalMs = 250 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const state = await readWatchState();
    if (state && state.activatedAt === activatedAt && (state.status === 'watching' || state.status === 'error')) return state;
    if (Date.now() >= end) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Liveness probe of the local daemon (/health) — null when down. */
export async function probeHealth(timeoutMs = 1000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`http://${config.host}:${config.port}/health`, { signal: ctrl.signal });
    const j = r.ok ? await r.json() : null;
    return j?.ok ? j : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Resolve and check a user-given folder. Returns { dir } or { error }. */
export async function checkFolder(input, { home } = {}) {
  let p = String(input).trim();
  if (home && (p === '~' || p.startsWith('~/'))) p = path.join(home, p.slice(1));
  const dir = path.resolve(p);
  try {
    const st = await fs.stat(dir);
    if (!st.isDirectory()) return { dir, error: 'this is not a folder' };
  } catch {
    return { dir, error: 'the folder does not exist' };
  }
  return { dir };
}

/**
 * Save an enabled setting and wait for the daemon's verdict.
 * Returns { settings, health, verdict } — verdict null when the daemon is down
 * or did not answer in time.
 */
export async function activate({ dir, deleteOriginal }, { probe = probeHealth, now = Date.now, timeoutMs } = {}) {
  const settings = await writeWatchSettings({ enabled: true, dir, deleteOriginal, activatedAt: now() });
  const health = await probe();
  const verdict = health ? await waitForVerdict(settings.activatedAt, { timeoutMs }) : null;
  return { settings, health, verdict };
}

function parseDirect(args) {
  let deleteOriginal = false;
  const rest = [];
  for (const a of args) {
    if (a === '--delete-original') deleteOriginal = true;
    else if (a === '--keep-original') deleteOriginal = false;
    else if (a.startsWith('--')) return { error: `unknown option: ${a}` };
    else rest.push(a);
  }
  if (rest.length !== 1) return { error: 'expected exactly one folder' };
  return { folder: rest[0], deleteOriginal };
}

/** Print where screenshots should land, without changing anything (direct mode). */
function macHint(dir, out) {
  if (process.platform !== 'darwin' || macLocation() === dir) return;
  out.log('');
  out.log('macOS still saves screenshots elsewhere. To send them to this folder, run:');
  out.log(`  ${formatCommand(macRedirectCommand(dir))}`);
  out.log('or: Cmd+Shift+5 → Options → Save to → Other Location…');
}

/** Report an activation outcome. Returns the exit code. */
export function reportActivation({ settings, health, verdict }, out = console) {
  if (!health) {
    out.log(`Saved: watching ${settings.dir} as soon as the server runs.`);
    out.log("The server is not running — start it with 'snapstack start' (or 'snapstack enable').");
    return 0;
  }
  if (!verdict) {
    out.error(`Saved, but the server did not confirm within ${VERDICT_TIMEOUT_MS / 1000}s.`);
    out.error("It may predate this feature — run 'snapstack update', then check 'snapstack status'.");
    return 1;
  }
  if (verdict.status === 'error') {
    out.error(`The server cannot watch ${settings.dir}: ${explainError(verdict.error)}.`);
    return 1;
  }
  out.log(`Watching ${settings.dir} — new screenshots go to the stack${settings.deleteOriginal ? ' (originals deleted)' : ''}.`);
  return 0;
}

/** `snapstack watch …` entry point. Returns the exit code. */
export async function runWatch(args, { out = console, isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY), probe = probeHealth } = {}) {
  if (args.length === 0) {
    if (isTTY) {
      const { runWizard } = await import('./watch-wizard.js');
      return runWizard();
    }
    const s = watchSummary({ settings: await readWatchSettings(), state: await readWatchState(), health: await probe() });
    out.log(`Watch folder: ${s.label}${s.info ? ` — ${s.info}` : ''}${s.hint ? ` (${s.hint})` : ''}`);
    out.log('');
    out.log(USAGE.trimEnd());
    return 0;
  }

  if (args[0] === 'off' && args.length === 1) {
    const prev = await readWatchSettings();
    await writeWatchSettings({ ...prev, enabled: false });
    out.log('Watch folder off — screenshots are no longer picked up.');
    return 0;
  }

  const parsed = parseDirect(args);
  if (parsed.error) {
    out.error(`snapstack watch: ${parsed.error}\n`);
    out.error(USAGE.trimEnd());
    return 1;
  }
  const { dir, error } = await checkFolder(parsed.folder);
  if (error) {
    out.error(`snapstack watch: ${dir}: ${error}.`);
    return 1;
  }
  if (isProtectedForService(dir)) {
    out.log('Note: macOS may keep the background service out of this folder — the server checks it now.');
  }
  let result;
  try {
    result = await activate({ dir, deleteOriginal: parsed.deleteOriginal }, { probe });
  } catch (e) {
    out.error(`snapstack watch: ${e.message}.`);
    return 1;
  }
  const code = reportActivation(result, out);
  if (code === 0) macHint(dir, out);
  return code;
}
