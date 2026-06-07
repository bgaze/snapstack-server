import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { config } from './config.js';

// Capture policy: the cross-browser-common settings the SERVER owns and the
// extension fetches before each capture, so one edit applies to every browser.
// DISTINCT from the infra config in config.js (dir/port/host — env-only). It is
// persisted as <dir>/config.json: a non-image file, so the stack's list/clear/
// remove never touch it (isValidName gates on image extensions) — it survives a
// stack clear. The store dir is the (fixed, default) stack dir; the screenshots
// folder is intentionally NOT user-managed.
//
// DEFAULT_POLICY MUST stay identical to the extension's DEFAULTS (background.js)
// and its MAX_SLICES constant: a first run (no file) and the extension's offline
// fallback (server unreachable / pre-/config server) must behave the same.
export const DEFAULT_POLICY = {
  format: 'webp', // 'webp' | 'png'
  quality: 0.85, // lossy quality for webp/png, 0..1
  maxEdge: 1568, // downscale the longest edge to this many px (0 = no downscale)
  maxSlices: 50, // full-page capture: hard cap on stitched slices
};

// Strict schema: a POST body must carry the full, valid policy (no partial
// merge — explicit, flat model). Unknown keys are stripped by zod on parse.
const PolicySchema = z.object({
  format: z.enum(['webp', 'png']),
  quality: z.number().min(0).max(1),
  maxEdge: z.number().int().min(0),
  maxSlices: z.number().int().min(1),
});

function configPath() {
  return path.join(config.dir, 'config.json');
}

// Effective policy = DEFAULT_POLICY overlaid with whatever is persisted.
// Best-effort: a missing / corrupt / partial file falls back to defaults and
// never throws. A stored value that fails validation collapses to the defaults.
export async function readConfig() {
  let stored = {};
  try {
    const parsed = JSON.parse(await fs.readFile(configPath(), 'utf8'));
    if (parsed && typeof parsed === 'object') stored = parsed;
  } catch {
    /* absent or unreadable → defaults */
  }
  const result = PolicySchema.safeParse({ ...DEFAULT_POLICY, ...stored });
  return result.success ? result.data : { ...DEFAULT_POLICY };
}

// Validate the full policy and persist it. Returns the effective (parsed)
// policy. Throws an error tagged `code: 'INVALID_CONFIG'` (carrying zod issues)
// on invalid input, so the route can map it to a 400.
export async function writeConfig(input) {
  const result = PolicySchema.safeParse(input);
  if (!result.success) {
    const err = new Error('invalid config');
    err.code = 'INVALID_CONFIG';
    err.issues = result.error.issues;
    throw err;
  }
  await fs.mkdir(config.dir, { recursive: true });
  await fs.writeFile(configPath(), `${JSON.stringify(result.data, null, 2)}\n`);
  return result.data;
}
