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

// Best-effort intrinsic dimensions read straight from the image header bytes —
// no native dependency. Returns { width, height } or null when the format/header
// is unrecognised or truncated. Never throws.
function imageDimensions(b, mediaType) {
  try {
    const type = String(mediaType || '').toLowerCase();
    if (type === 'image/png') return pngSize(b);
    if (type === 'image/jpeg' || type === 'image/jpg') return jpegSize(b);
    if (type === 'image/webp') return webpSize(b);
    if (type === 'image/gif') return gifSize(b);
  } catch {
    /* unreadable header → null */
  }
  return null;
}

function pngSize(b) {
  // 8-byte signature, then IHDR chunk: width @16, height @20 (big-endian).
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function gifSize(b) {
  // "GIF8" magic, then logical screen descriptor: width @6, height @8 (LE).
  if (b.length < 10 || b.toString('ascii', 0, 4) !== 'GIF8') return null;
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

function jpegSize(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let off = 2;
  while (off + 9 < b.length) {
    if (b[off] !== 0xff) { off += 1; continue; }
    const marker = b[off + 1];
    // SOFn markers carry the frame size; skip DHT(c4)/JPG(c8)/DAC(cc) and others.
    const isSof = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: b.readUInt16BE(off + 5), width: b.readUInt16BE(off + 7) };
    const len = b.readUInt16BE(off + 2);
    if (len < 2) return null;
    off += 2 + len;
  }
  return null;
}

function webpSize(b) {
  if (b.length < 30 || b.toString('ascii', 0, 4) !== 'RIFF'
    || b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const fourcc = b.toString('ascii', 12, 16);
  if (fourcc === 'VP8 ') {
    // Lossy: 3-byte frame tag, start code 9d 01 2a, then 14-bit w/h (LE).
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (fourcc === 'VP8L') {
    // Lossless: signature 0x2f, then packed 14-bit (w-1) and 14-bit (h-1), LE.
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (fourcc === 'VP8X') {
    // Extended: 24-bit (canvas w-1) and 24-bit (canvas h-1), LE, at offset 24.
    const w = (b[24] | (b[25] << 8) | (b[26] << 16)) + 1;
    const h = (b[27] | (b[28] << 8) | (b[29] << 16)) + 1;
    return { width: w, height: h };
  }
  return null;
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
  // Dimensions parsed from the bytes themselves (works for both the raw-bytes
  // and the dataUrl paths); fall back to any caller-provided values.
  const dims = imageDimensions(bytes, mediaType) || {};
  const width = dims.width ?? (meta.width != null ? Number(meta.width) : null);
  const height = dims.height ?? (meta.height != null ? Number(meta.height) : null);
  const metadata = {
    number,
    name: `${stem}.${ext}`,
    path: imagePath, // absolute (config.dir is resolved), never a `~`
    url: meta.url ?? null,
    title: meta.title ?? null,
    capturedAt: new Date(ts).toISOString(),
    format: MIME_BY_EXT[ext],
    bytes: bytes.length,
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
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
      width: meta.width ?? null,
      height: meta.height ?? null,
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
 * Delete pending captures. With no numbers, clears the whole stack; with
 * numbers, deletes only those captures (others keep their number — no
 * renumbering). Returns { deleted, missing, remaining }.
 */
export async function clear(numbers) {
  const entries = await list();
  let targets = entries;
  let missing = [];
  if (Array.isArray(numbers) && numbers.length) {
    const want = new Set(numbers);
    targets = entries.filter((e) => e.number != null && want.has(e.number));
    const present = new Set(targets.map((e) => e.number));
    missing = [...new Set(numbers)].filter((n) => !present.has(n));
  }
  for (const e of targets) {
    await removeEntry(e);
  }
  return { deleted: targets.length, missing, remaining: await count() };
}
