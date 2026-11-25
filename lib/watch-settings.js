import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { config } from './config.js';

// Watched-folder feature: two small files in the stack dir, each with ONE writer.
//
// - watch.json       — the SETTING, written by the CLI only (`snapstack watch`).
//                      Never reachable over HTTP: no page or extension can make
//                      the server read another folder.
// - watch-state.json — the daemon's VERDICT, written by the daemon only: is the
//                      folder actually readable by the service (launchd/systemd/
//                      task rights differ from the terminal's), what was the
//                      last ingested capture, which files were already seen.
//                      It echoes the `activatedAt` of the setting it answers, so
//                      the CLI never mistakes a stale verdict for a fresh one.
//
// Both are non-image files: the stack's list/clear/remove never touch them
// (they only remove an image and its same-stem .json twin). Kept apart from
// config.json, which POST /config rewrites whole.

export const DEFAULT_SETTINGS = {
  enabled: false,
  dir: null, // absolute path of the watched folder
  deleteOriginal: false, // delete the original once it is safely in the stack
  activatedAt: null, // epoch ms of the last `snapstack watch <dir>`
};

const SettingsSchema = z
  .object({
    enabled: z.boolean(),
    dir: z.string().min(1).nullable(),
    deleteOriginal: z.boolean(),
    activatedAt: z.number().nonnegative().nullable(),
  })
  .refine((s) => !s.enabled || (s.dir && path.isAbsolute(s.dir) && s.activatedAt != null), {
    message: 'an enabled watch needs an absolute dir and an activation time',
  });

export function settingsPath() {
  return path.join(config.dir, 'watch.json');
}

export function statePath() {
  return path.join(config.dir, 'watch-state.json');
}

/** True when `dir` is the stack folder itself (watching it would re-ingest every capture). */
export function isStackDir(dir) {
  return path.resolve(dir) === path.resolve(config.dir);
}

// Write-then-rename: the other side polls these files and must never read a
// half-written one.
async function writeAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Unique per write: two overlapping writes of the same file never share a temp.
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
  await fs.rename(tmp, file);
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Effective setting. Best-effort: absent / corrupt / invalid → disabled. */
export async function readWatchSettings() {
  const stored = await readJson(settingsPath());
  const result = SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...(stored && typeof stored === 'object' ? stored : {}) });
  return result.success ? result.data : { ...DEFAULT_SETTINGS };
}

/** Validate and persist the setting (CLI side). Throws on invalid input. */
export async function writeWatchSettings(input) {
  const data = SettingsSchema.parse({ ...DEFAULT_SETTINGS, ...input });
  if (data.enabled && isStackDir(data.dir)) {
    throw new Error('the watched folder cannot be the SnapStack stack folder itself');
  }
  await writeAtomic(settingsPath(), data);
  return data;
}

/** The daemon's last verdict, or null when it never wrote one. */
export async function readWatchState() {
  const state = await readJson(statePath());
  return state && typeof state === 'object' ? state : null;
}

/** Persist the daemon's verdict (daemon side). */
export async function writeWatchState(state) {
  await writeAtomic(statePath(), state);
}
