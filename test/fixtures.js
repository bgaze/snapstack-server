// Minimal, hand-crafted image byte buffers — just enough valid header for the
// pure-JS dimension parsers in stack.js to read width/height. Not decodable
// images, by design: the parsers only read header bytes, never pixels.

/** PNG: 8-byte signature + IHDR with width@16, height@20 (big-endian). */
export function makePng(width, height) {
  const b = Buffer.alloc(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // signature
  b.writeUInt32BE(13, 8); // IHDR length
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** GIF89a: "GIF8" magic + logical screen descriptor width@6, height@8 (LE). */
export function makeGif(width, height) {
  const b = Buffer.alloc(10);
  b.write('GIF89a', 0, 'ascii');
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

/** JPEG: SOI (FFD8) + a SOF0 (FFC0) frame header carrying height then width. */
export function makeJpeg(width, height) {
  const b = Buffer.alloc(12);
  b.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0); // SOI + SOF0 marker, len, precision
  b.writeUInt16BE(height, 7);
  b.writeUInt16BE(width, 9);
  return b;
}

/** WebP (VP8X extended): RIFF/WEBP container, 24-bit (w-1)/(h-1) at offset 24 (LE). */
export function makeWebp(width, height) {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(22, 4); // file size - 8
  b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii');
  b.writeUInt32LE(10, 16); // chunk size
  const w = width - 1;
  const h = height - 1;
  b[24] = w & 0xff; b[25] = (w >> 8) & 0xff; b[26] = (w >> 16) & 0xff;
  b[27] = h & 0xff; b[28] = (h >> 8) & 0xff; b[29] = (h >> 16) & 0xff;
  return b;
}
