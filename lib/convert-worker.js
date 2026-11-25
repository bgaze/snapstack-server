import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

// One-shot conversion worker: decode → (downscale) → encode, then exit.
// Spawned by convert.js for EACH capture and terminated right after, because
// the WASM linear memory grows to the largest image seen and never shrinks
// (measured: ~630 MB RSS for a 5K PNG). Killing the worker gives it back.
//
// WASM, no native addon: the codecs are @jsquash/* (Squoosh builds). Their
// default loaders fetch the .wasm next to the JS, which Node can't do on a
// file: URL — so each module is read from disk, compiled, and handed to init().

// wasm-bindgen glue (PNG decode/encode, resize) constructs `new ImageData()`,
// a browser global Node lacks. mozjpeg ships its own shim; this one matches it.
if (!globalThis.ImageData) {
  globalThis.ImageData = class ImageData {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
      this.colorSpace = 'srgb';
    }
  };
}

const require = createRequire(import.meta.url);

async function compile(pkg, rel) {
  const dir = path.dirname(require.resolve(`${pkg}/package.json`));
  return WebAssembly.compile(await readFile(path.join(dir, rel)));
}

let png; // memoized: PNG → PNG decodes and encodes with the same module
async function pngCodec() {
  if (png) return png;
  const dec = await import('@jsquash/png/decode.js');
  const enc = await import('@jsquash/png/encode.js');
  // decode.js and encode.js share one wasm-bindgen module: one init serves both.
  await dec.init(await compile('@jsquash/png', 'codec/pkg/squoosh_png_bg.wasm'));
  png = { decode: dec.decode, encode: enc.default };
  return png;
}

async function decode(bytes, mediaType) {
  if (mediaType === 'image/png') return (await pngCodec()).decode(bytes);
  if (mediaType === 'image/jpeg') {
    const dec = await import('@jsquash/jpeg/decode.js');
    await dec.init(await compile('@jsquash/jpeg', 'codec/dec/mozjpeg_dec.wasm'));
    return dec.default(bytes);
  }
  throw new Error(`cannot decode ${mediaType}`);
}

async function downscale(image, maxWidth) {
  if (!(maxWidth > 0) || image.width <= maxWidth) return image;
  const mod = await import('@jsquash/resize');
  await mod.initResize(await compile('@jsquash/resize', 'lib/resize/pkg/squoosh_resize_bg.wasm'));
  const height = Math.max(1, Math.round((image.height * maxWidth) / image.width));
  return mod.default(image, { width: maxWidth, height });
}

async function encode(image, policy) {
  const quality = Math.round(policy.quality * 100);
  if (policy.format === 'webp') {
    const enc = await import('@jsquash/webp/encode.js');
    // Node ≥ 18 always has WASM SIMD, so encode.js picks its SIMD build: match it.
    await enc.init(await compile('@jsquash/webp', 'codec/enc/webp_enc_simd.wasm'));
    return { buffer: await enc.default(image, { quality }), mediaType: 'image/webp' };
  }
  if (policy.format === 'jpg') {
    const enc = await import('@jsquash/jpeg/encode.js');
    await enc.init(await compile('@jsquash/jpeg', 'codec/enc/mozjpeg_enc.wasm'));
    return { buffer: await enc.default(image, { quality }), mediaType: 'image/jpeg' };
  }
  return { buffer: await (await pngCodec()).encode(image), mediaType: 'image/png' };
}

try {
  const { bytes, mediaType, policy } = workerData;
  const image = await downscale(await decode(bytes, mediaType), policy.maxWidth);
  const { buffer, mediaType: outType } = await encode(image, policy);
  parentPort.postMessage({ ok: true, bytes: new Uint8Array(buffer), mediaType: outType }, [buffer]);
} catch (e) {
  parentPort.postMessage({ ok: false, error: String(e?.message || e) });
}
