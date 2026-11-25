import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { readConfig } from './settings.js';
import * as stack from './stack.js';
import { convertImage } from './convert.js';
import {
  isStackDir, readWatchSettings, readWatchState, settingsPath, writeWatchState,
} from './watch-settings.js';

// Watched folder → stack. The OS screenshot tool (macOS Cmd+Shift+3/4/5,
// Windows Win+PrtScn / Snipping Tool, GNOME / KDE Spectacle) saves into a
// folder; each NEW image there is converted like an extension capture and
// written to the stack, where MCP clients read it.
//
// `scanOnce` is the whole decision logic — pure enough to test on temp dirs.
// `startWatcher` only decides WHEN to run it: at start, on fs.watch signals
// (non-recursive, treated as a mere hint), every 30 s as a safety net, and
// within ~1 s of a `snapstack watch` (polling watch.json — no restart, which
// would re-run the launcher's self-update).

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};
export const MAX_INPUT_BYTES = 50 * 1024 * 1024;
// A file modified more recently may still be being written. Screenshot tools
// write in one go (macOS even writes a hidden file, then renames it), so a
// short quiet period is enough — and every ms here delays the stack.
export const SETTLE_MS = 500;
const RESCAN_MS = 30_000;
const DEBOUNCE_MS = 300;

function mimeOf(name) {
  return MIME_BY_EXT[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] ?? null;
}

const keyOf = (f) => `${f.name}|${f.size}|${f.mtimeMs}`;

/** Store one screenshot in the stack; the original is deleted only after a successful write. */
async function ingest(file, settings, policy, log) {
  const bytes = await fsp.readFile(file.path);
  let out = { bytes, mediaType: file.mediaType };
  let converted = true;
  try {
    out = await convertImage(bytes, file.mediaType, policy);
  } catch (e) {
    converted = false;
    log.warn(`watch: could not convert ${file.name} (${e.message}) — stored as-is, original kept`);
  }
  const entry = await stack.write(out.bytes, out.mediaType, { title: file.name, url: null });
  log.log(`watch: ${file.name} → #${entry.number} ${entry.name}`);
  let removed = false;
  // An image that failed to convert may be damaged (or caught mid-write): its
  // original is never deleted, whatever the setting.
  if (settings.deleteOriginal && converted) {
    try {
      await fsp.rm(file.path);
      removed = true;
    } catch (e) {
      // Already in the stack: report, but never fail (a retry would duplicate it).
      log.warn(`watch: could not delete ${file.name} (${e.message})`);
    }
  }
  return { entry, removed };
}

/**
 * One pass over the watched folder. Returns { state, deferred }:
 * - state    : the new verdict to persist (watch-state.json shape);
 * - deferred : true when a file was too fresh to take (re-run shortly).
 * Rules: hidden files, symlinks, sub-folders, non-images and files over
 * MAX_INPUT_BYTES are ignored; on the first pass of an activation, files
 * older than the activation are marked seen without ingestion; afterwards any
 * unseen file is ingested, one at a time, oldest first.
 */
export async function scanOnce({ settings, state, policy, now = Date.now(), log = console }) {
  // `baselined` is set only by a SUCCESSFUL scan: until the folder has been
  // read once for this activation, every pass is a first pass, so files that
  // predate the activation are never ingested (nor deleted) — even when the
  // folder only becomes readable later (access granted, folder created…).
  const sameActivation = Boolean(state) && state.activatedAt === settings.activatedAt && state.dir === settings.dir;
  const firstPass = !sameActivation || !state.baselined;
  const base = {
    activatedAt: settings.activatedAt,
    dir: settings.dir,
    since: firstPass ? now : state.since ?? now,
    // A fact about the stack, not about this activation: kept across them, so
    // `snapstack status` still shows the last capture after a reconfiguration.
    lastIngest: state?.lastIngest ?? null,
    version: config.version,
  };
  const seen = new Set(firstPass ? [] : state.seen ?? []);

  if (isStackDir(settings.dir)) {
    return {
      state: { ...base, status: 'error', error: { code: 'ESTACKDIR', message: 'the watched folder is the stack folder' }, baselined: false, seen: [] },
      deferred: false,
    };
  }

  let dirents;
  try {
    dirents = await fsp.readdir(settings.dir, { withFileTypes: true });
  } catch (e) {
    // Keep `seen` and the baseline: a folder briefly unreadable must not
    // re-ingest everything later; a never-read one stays un-baselined.
    return {
      state: { ...base, status: 'error', error: { code: e.code ?? 'EUNKNOWN', message: e.message }, baselined: !firstPass, seen: [...seen] },
      deferred: false,
    };
  }

  const files = [];
  for (const d of dirents) {
    if (!d.isFile() || d.name.startsWith('.')) continue; // symlinks/dirs → not isFile()
    const mediaType = mimeOf(d.name);
    if (!mediaType) continue;
    const p = path.join(settings.dir, d.name);
    try {
      const st = await fsp.lstat(p);
      files.push({ name: d.name, path: p, mediaType, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      /* vanished between readdir and lstat */
    }
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : 1));

  const present = new Set(files.map(keyOf));
  let deferred = false;
  let lastIngest = base.lastIngest;
  for (const f of files) {
    const key = keyOf(f);
    if (seen.has(key)) continue;
    if (firstPass && f.mtimeMs < settings.activatedAt) { seen.add(key); continue; }
    if (f.size > MAX_INPUT_BYTES) {
      log.warn(`watch: ${f.name} skipped (over ${MAX_INPUT_BYTES / 1024 / 1024} MB)`);
      seen.add(key);
      continue;
    }
    if (now - f.mtimeMs < SETTLE_MS) { deferred = true; continue; }
    try {
      const { entry, removed } = await ingest(f, settings, policy, log);
      if (!removed) seen.add(key); // a deleted original needs no memory
      lastIngest = { number: entry.number, name: entry.name, source: f.name, at: Date.now() };
    } catch (e) {
      // Read or stack-write failure: leave it unseen, the next pass retries.
      log.warn(`watch: could not ingest ${f.name} (${e.message})`);
    }
  }

  return {
    state: { ...base, lastIngest, status: 'watching', error: null, baselined: true, seen: [...seen].filter((k) => present.has(k)) },
    deferred,
  };
}

/** Run the watcher inside the daemon. Returns { stop }. Never throws. */
export function startWatcher({ log = console } = {}) {
  let running = false;
  let again = false;
  let fsw = null;
  let fswDir = null;
  let debounce = null;
  let retry = null;
  let lastWritten = null;

  const closeFsWatch = () => {
    fsw?.close();
    fsw = null;
    fswDir = null;
  };

  const schedule = (ms) => {
    clearTimeout(debounce);
    debounce = setTimeout(pass, ms);
  };

  const ensureFsWatch = (dir) => {
    if (fswDir === dir) return;
    closeFsWatch();
    try {
      fsw = fs.watch(dir, { persistent: false }, () => schedule(DEBOUNCE_MS));
      fsw.on('error', closeFsWatch); // folder gone / unreadable: the 30 s pass reports it
      fswDir = dir;
    } catch {
      /* unreadable: scanOnce reports the error */
    }
  };

  const persist = async (state) => {
    const json = JSON.stringify(state);
    if (json === lastWritten) return;
    await writeWatchState(state);
    lastWritten = json;
  };

  async function passOnce() {
    const settings = await readWatchSettings();
    if (!settings.enabled) {
      closeFsWatch();
      const prev = await readWatchState();
      await persist({
        activatedAt: settings.activatedAt, dir: settings.dir, status: 'off', error: null,
        lastIngest: prev?.lastIngest ?? null, version: config.version, baselined: false, seen: [],
      });
      return;
    }
    const { state, deferred } = await scanOnce({
      settings,
      state: await readWatchState(),
      policy: await readConfig(),
      log,
    });
    if (state.status === 'watching') ensureFsWatch(settings.dir);
    else closeFsWatch();
    await persist(state);
    if (deferred) {
      clearTimeout(retry);
      retry = setTimeout(pass, SETTLE_MS + 100);
    }
  }

  async function pass() {
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        await passOnce();
      } while (again);
    } catch (e) {
      log.error(`watch: pass failed (${e.message})`);
    } finally {
      running = false;
    }
  }

  fs.watchFile(settingsPath(), { interval: 1000, persistent: false }, () => pass());
  const interval = setInterval(pass, RESCAN_MS);
  interval.unref();
  pass();

  return {
    stop() {
      fs.unwatchFile(settingsPath());
      clearInterval(interval);
      clearTimeout(debounce);
      clearTimeout(retry);
      closeFsWatch();
    },
  };
}
