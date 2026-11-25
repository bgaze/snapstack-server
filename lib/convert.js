import { Worker } from 'node:worker_threads';
import { imageDimensions } from './stack.js';

// Bring a screenshot picked up from a watched folder to the same shape the
// extension produces: downscale when WIDER than the policy's maxWidth, then
// encode to the policy's format/quality (lib/settings.js). The heavy lifting
// runs in a throwaway worker (convert-worker.js) so WASM memory is released.

const DECODABLE = new Set(['image/png', 'image/jpeg']);
const MIME_BY_FORMAT = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg' };

/**
 * Decide what to do with an input image under a capture policy.
 * - 'keep'    : store the bytes untouched (not decodable — GIF, WebP — or
 *               already in the policy's format and no wider than maxWidth).
 * - 'convert' : decode → downscale if needed → encode to the policy format.
 * `width` may be null (unreadable header): then the worker decides on the
 * decoded size, so a decodable input is always converted.
 */
export function planConversion({ mediaType, width }, policy) {
  if (!DECODABLE.has(mediaType)) return 'keep';
  const tooWide = policy.maxWidth > 0 && (width == null || width > policy.maxWidth);
  const sameFormat = MIME_BY_FORMAT[policy.format] === mediaType;
  return !tooWide && sameFormat ? 'keep' : 'convert';
}

/** Run one conversion in a fresh worker; always terminates it. */
function runWorker(bytes, mediaType, policy, timeoutMs) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./convert-worker.js', import.meta.url), {
      workerData: { bytes, mediaType, policy },
    });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error(`conversion timed out after ${timeoutMs} ms`)), timeoutMs);
    worker.once('message', (m) => {
      if (m?.ok) finish(resolve, { bytes: Buffer.from(m.bytes.buffer, m.bytes.byteOffset, m.bytes.byteLength), mediaType: m.mediaType });
      else finish(reject, new Error(m?.error || 'conversion failed'));
    });
    worker.once('error', (e) => finish(reject, e));
    worker.once('exit', (code) => finish(reject, new Error(`conversion worker exited (${code})`)));
  });
}

/**
 * Convert `bytes` (a screenshot of `mediaType`) under `policy`.
 * Resolves { bytes, mediaType, converted }. Rejects on a conversion failure —
 * the caller decides the fallback (the watcher stores the original as-is).
 */
export async function convertImage(bytes, mediaType, policy, { timeoutMs = 60_000 } = {}) {
  const width = imageDimensions(bytes, mediaType)?.width ?? null;
  if (planConversion({ mediaType, width }, policy) === 'keep') {
    return { bytes, mediaType, converted: false };
  }
  const out = await runWorker(bytes, mediaType, policy, timeoutMs);
  return { ...out, converted: true };
}
