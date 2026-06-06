import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

// Format mapping. The stack is format-agnostic: it stores whatever image bytes
// the extension sends (WebP by default, PNG fallback) and reads the real media
// type back from the file extension.
const EXT_BY_MIME = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
};
const MIME_BY_EXT = {
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
};
const IMAGE_EXTS = new Set(Object.keys(MIME_BY_EXT));

// A capture is identified by its full filename. Validate before any name-driven
// read/delete: reject anything that isn't a bare filename (no path separators or
// traversal) with a known image extension, so it can never escape the folder.
export function isValidName(name) {
  if (typeof name !== 'string' || !name) return false;
  if (path.basename(name) !== name) return false; // blocks "/", "\", ".."
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return IMAGE_EXTS.has(ext);
}

export async function ensureDir() {
  await fs.mkdir(config.dir, { recursive: true });
}

function extFor(mediaType) {
  return EXT_BY_MIME[String(mediaType || '').toLowerCase()] ?? null;
}

const pad = (n) => String(n).padStart(2, '0');

// Human-readable, filesystem-safe local timestamp: "YYYY-MM-DD HH-MM-SS".
// No ":" (forbidden on Windows, displayed as "/" by macOS Finder).
function localStamp(d) {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// Stable per-capture number, assigned in capture order. The next number is
// max(existing) + 1, so it is never reused while captures remain, and naturally
// falls back to 1 once the stack is empty — no persistent counter to maintain.
async function nextNumber() {
  let max = 0;
  for (const e of await list()) {
    if (typeof e.number === 'number' && e.number > max) max = e.number;
  }
  return max + 1;
}

/**
 * Persist one capture: the image bytes + a twin .json metadata file.
 * Returns the written entry descriptor.
 */
export async function write(bytes, mediaType, meta = {}) {
  const ext = extFor(mediaType);
  if (!ext) throw new Error(`Unsupported media type: ${mediaType}`);

  const ts = Date.now();
  const stamp = localStamp(new Date(ts));

  // Assign the next stable number, then guard against a same-number collision
  // (two concurrent writes racing on nextNumber): bump until the name is free.
  let number = await nextNumber();
  let stem = `${pad(number)} ${stamp}`;
  while (await fileExists(path.join(config.dir, `${stem}.${ext}`))) {
    number += 1;
    stem = `${pad(number)} ${stamp}`;
  }

  const imagePath = path.join(config.dir, `${stem}.${ext}`);
  const jsonPath = path.join(config.dir, `${stem}.json`);
  const metadata = {
    number,
    name: `${stem}.${ext}`,
    path: imagePath, // absolute (config.dir is resolved), never a `~`
    url: meta.url ?? null,
    title: meta.title ?? null,
    capturedAt: new Date(ts).toISOString(),
    format: MIME_BY_EXT[ext],
    bytes: bytes.length,
    ...(meta.width ? { width: Number(meta.width) } : {}),
    ...(meta.height ? { height: Number(meta.height) } : {}),
  };

  await fs.writeFile(imagePath, bytes);
  await fs.writeFile(jsonPath, JSON.stringify(metadata, null, 2));
  return { number, stem, name: `${stem}.${ext}`, ext, mediaType: MIME_BY_EXT[ext], imagePath, jsonPath, metadata };
}

/** List pending captures, oldest first. Never throws on a missing folder. */
export async function list() {
  let names;
  try {
    names = await fs.readdir(config.dir);
  } catch {
    return [];
  }
  const images = names.filter((n) =>
    IMAGE_EXTS.has(n.slice(n.lastIndexOf('.') + 1).toLowerCase()),
  );

  const entries = [];
  for (const n of images) {
    const dot = n.lastIndexOf('.');
    const stem = n.slice(0, dot);
    const ext = n.slice(dot + 1).toLowerCase();
    const imagePath = path.join(config.dir, n);
    let mtimeMs;
    try {
      mtimeMs = (await fs.stat(imagePath)).mtimeMs;
    } catch {
      continue; // vanished between readdir and stat
    }
    // Leading "NN " prefix is the stable capture number. Legacy files without a
    // prefix get number === null (tolerated, sorted last, shown without a badge).
    const m = /^(\d+) /.exec(stem);
    const number = m ? Number.parseInt(m[1], 10) : null;
    entries.push({
      name: n,
      base: stem, // kept for readAll/MCP back-compat
      stem,
      ext,
      number,
      mediaType: MIME_BY_EXT[ext],
      imagePath,
      path: imagePath, // absolute (config.dir is resolved), never a `~`
      jsonPath: path.join(config.dir, `${stem}.json`),
      mtimeMs,
    });
  }

  // Order by stable capture number (assigned monotonically, so numeric order is
  // chronological). Legacy unnumbered files sort last, by write time.
  entries.sort((a, b) => {
    if (a.number != null && b.number != null) return a.number - b.number;
    if (a.number != null) return -1;
    if (b.number != null) return 1;
    return a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  });
  return entries;
}

/**
 * Detailed listing for the HTTP/dropdown surface: one entry per capture with
 * its metadata, oldest first. Reads the twin .json (best-effort); falls back to
 * the file size / extension when metadata is missing. `path` is absolute.
 */
export async function listDetailed() {
  const entries = await list();
  const out = [];
  for (const e of entries) {
    let meta = {};
    try {
      meta = JSON.parse(await fs.readFile(e.jsonPath, 'utf8'));
    } catch {
      meta = {};
    }
    let bytes = meta.bytes;
    if (typeof bytes !== 'number') {
      try {
        bytes = (await fs.stat(e.imagePath)).size;
      } catch {
        bytes = null;
      }
    }
    out.push({
      number: e.number,
      name: e.name,
      url: meta.url ?? null,
      title: meta.title ?? null,
      capturedAt: meta.capturedAt ?? null,
      format: meta.format ?? e.mediaType,
      bytes,
      path: e.path,
    });
  }
  return out;
}

/** Read one capture by filename. Returns { bytes, mediaType, meta } or null. */
export async function get(name) {
  if (!isValidName(name)) return null;
  const entry = (await list()).find((e) => e.name === name);
  if (!entry) return null;
  let bytes;
  try {
    bytes = await fs.readFile(entry.imagePath);
  } catch {
    return null;
  }
  let meta = {};
  try {
    meta = JSON.parse(await fs.readFile(entry.jsonPath, 'utf8'));
  } catch {
    meta = {};
  }
  return { bytes, mediaType: entry.mediaType, meta };
}

/** Delete one capture (image + twin .json) by filename. Returns true if it existed. */
export async function remove(name) {
  if (!isValidName(name)) return false;
  const entry = (await list()).find((e) => e.name === name);
  if (!entry) return false;
  await removeEntry(entry);
  return true;
}

export async function count() {
  return (await list()).length;
}

async function removeEntry(entry) {
  await fs.rm(entry.imagePath, { force: true });
  await fs.rm(entry.jsonPath, { force: true });
}

/**
 * Read pending captures in chronological order.
 * @param {{ keep?: boolean, limit?: number }} opts
 *   keep  : do not delete after reading.
 *   limit : only the N oldest captures.
 * Corrupt / unreadable images are skipped and reported in `errors`.
 * Only successfully-read captures are deleted (unless keep).
 */
export async function readAll({ keep = false, limit } = {}) {
  let entries = await list();
  if (typeof limit === 'number' && limit >= 0) {
    entries = entries.slice(0, limit);
  }

  const items = [];
  const errors = [];
  for (const e of entries) {
    try {
      const data = await fs.readFile(e.imagePath);
      let meta = {};
      try {
        meta = JSON.parse(await fs.readFile(e.jsonPath, 'utf8'));
      } catch {
        meta = {}; // missing/corrupt metadata is non-fatal
      }
      items.push({ ...e, data, meta });
    } catch (err) {
      errors.push({ base: e.base, error: err.message });
    }
  }

  if (!keep) {
    for (const it of items) {
      await removeEntry(it);
    }
  }
  return { items, errors };
}

/** Delete every pending capture. Returns how many images were removed. */
export async function clear() {
  const entries = await list();
  for (const e of entries) {
    await removeEntry(e);
  }
  return entries.length;
}
