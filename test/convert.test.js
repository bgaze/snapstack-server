import test from 'node:test';
import assert from 'node:assert/strict';
import { convertImage, planConversion } from '../lib/convert.js';
import { imageDimensions } from '../lib/stack.js';
import { makeRealPng, makeGif } from './fixtures.js';

const POLICY = { format: 'webp', quality: 0.85, maxWidth: 1568, maxSlices: 50 };

test('planConversion keeps what needs no work, converts the rest', () => {
  // Not decodable → stored as-is, whatever the policy.
  assert.equal(planConversion({ mediaType: 'image/gif', width: 4000 }, POLICY), 'keep');
  assert.equal(planConversion({ mediaType: 'image/webp', width: 4000 }, POLICY), 'keep');
  // Already in the policy format and narrow enough → untouched.
  assert.equal(planConversion({ mediaType: 'image/png', width: 800 }, { ...POLICY, format: 'png' }), 'keep');
  assert.equal(planConversion({ mediaType: 'image/png', width: 4000 }, { ...POLICY, format: 'png', maxWidth: 0 }), 'keep');
  // Wrong format, too wide, or unknown width → converted.
  assert.equal(planConversion({ mediaType: 'image/png', width: 800 }, POLICY), 'convert');
  assert.equal(planConversion({ mediaType: 'image/png', width: 4000 }, { ...POLICY, format: 'png' }), 'convert');
  assert.equal(planConversion({ mediaType: 'image/jpeg', width: null }, { ...POLICY, format: 'jpg' }), 'convert');
});

test('PNG wider than maxWidth → WebP downscaled to maxWidth, ratio kept', async () => {
  const out = await convertImage(makeRealPng(3000, 400), 'image/png', POLICY);
  assert.equal(out.converted, true);
  assert.equal(out.mediaType, 'image/webp');
  assert.deepEqual(imageDimensions(out.bytes, out.mediaType), { width: 1568, height: 209 });
});

test('PNG narrower than maxWidth → encoded, size untouched', async () => {
  const out = await convertImage(makeRealPng(600, 300), 'image/png', POLICY);
  assert.equal(out.mediaType, 'image/webp');
  assert.deepEqual(imageDimensions(out.bytes, out.mediaType), { width: 600, height: 300 });
});

test('JPEG policy encodes JPEG, and a JPEG input decodes back to WebP', async () => {
  const jpg = await convertImage(makeRealPng(2000, 200), 'image/png', { ...POLICY, format: 'jpg' });
  assert.equal(jpg.mediaType, 'image/jpeg');
  assert.equal(imageDimensions(jpg.bytes, jpg.mediaType).width, 1568);
  const webp = await convertImage(jpg.bytes, 'image/jpeg', POLICY);
  assert.equal(webp.mediaType, 'image/webp');
  assert.equal(imageDimensions(webp.bytes, webp.mediaType).width, 1568);
});

test('PNG policy re-encodes a too-wide PNG as PNG', async () => {
  const out = await convertImage(makeRealPng(2000, 100), 'image/png', { ...POLICY, format: 'png' });
  assert.equal(out.mediaType, 'image/png');
  assert.equal(imageDimensions(out.bytes, out.mediaType).width, 1568);
});

test('a kept image is returned byte-for-byte', async () => {
  const gif = makeGif(10, 10);
  const out = await convertImage(gif, 'image/gif', POLICY);
  assert.equal(out.converted, false);
  assert.equal(out.bytes, gif);
});

test('undecodable bytes reject (the caller falls back to the original)', async () => {
  await assert.rejects(convertImage(Buffer.from('not a png'), 'image/png', POLICY));
});
