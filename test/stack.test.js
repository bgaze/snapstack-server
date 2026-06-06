import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makePng, makeGif, makeJpeg, makeWebp } from './fixtures.js';

// Point the stack at a throwaway dir BEFORE importing the module (config.js
// resolves SNAPSTACK_DIR at import time), so tests never touch the real stack.
const dir = await mkdtemp(path.join(os.tmpdir(), 'snapstack-stack-'));
process.env.SNAPSTACK_DIR = dir;
const stack = await import('../lib/stack.js');

test.after(() => rm(dir, { recursive: true, force: true }));

// Reset the stack between tests so numbering assertions are deterministic.
async function reset() {
  await stack.ensureDir();
  await stack.clear();
}

test('isValidName accepts plain image filenames', () => {
  assert.ok(stack.isValidName('01 2026-01-01 10-00-00.webp'));
  for (const ext of ['png', 'webp', 'jpg', 'jpeg', 'gif', 'PNG']) {
    assert.ok(stack.isValidName(`foo.${ext}`), ext);
  }
});

test('isValidName rejects traversal, separators, bad/no extension, non-strings', () => {
  // NB: a bare backslash is a legal filename char on POSIX (only a separator on
  // Windows), so it is intentionally not in this cross-platform reject list.
  for (const bad of [
    '../foo.png', 'a/b.png', '..', '.', '', 'foo', 'foo.txt',
    '/etc/passwd', 'foo.png/../bar', null, undefined, 123, {},
  ]) {
    assert.equal(stack.isValidName(bad), false, JSON.stringify(bad));
  }
});

test('write parses dimensions from each image format header', async () => {
  await reset();
  const cases = [
    ['image/png', makePng(120, 80), 120, 80],
    ['image/gif', makeGif(64, 32), 64, 32],
    ['image/jpeg', makeJpeg(200, 150), 200, 150],
    ['image/webp', makeWebp(300, 250), 300, 250],
  ];
  for (const [type, bytes, w, h] of cases) {
    const e = await stack.write(bytes, type, { url: 'http://x', title: 't' });
    assert.equal(e.metadata.width, w, type);
    assert.equal(e.metadata.height, h, type);
  }
  await reset();
});

test('write rejects an unsupported media type', async () => {
  await reset();
  await assert.rejects(() => stack.write(makePng(1, 1), 'image/bmp', {}));
});

test('numbers are assigned in order and restart at 1 when empty', async () => {
  await reset();
  const a = await stack.write(makePng(1, 1), 'image/png', {});
  const b = await stack.write(makePng(1, 1), 'image/png', {});
  const c = await stack.write(makePng(1, 1), 'image/png', {});
  assert.deepEqual([a.number, b.number, c.number], [1, 2, 3]);

  const listed = await stack.listDetailed();
  assert.deepEqual(listed.map((e) => e.number), [1, 2, 3]);

  await stack.clear();
  assert.equal(await stack.count(), 0);
  const d = await stack.write(makePng(1, 1), 'image/png', {});
  assert.equal(d.number, 1); // restarts, no persistent counter
  await reset();
});

test('clear([n]) deletes only those, reports missing, survivors keep numbers', async () => {
  await reset();
  await stack.write(makePng(1, 1), 'image/png', {}); // 1
  await stack.write(makePng(1, 1), 'image/png', {}); // 2
  await stack.write(makePng(1, 1), 'image/png', {}); // 3

  const res = await stack.clear([2, 9]);
  assert.equal(res.deleted, 1);
  assert.deepEqual(res.missing, [9]);
  assert.equal(res.remaining, 2);

  const left = (await stack.listDetailed()).map((e) => e.number);
  assert.deepEqual(left, [1, 3]); // no renumbering
  await reset();
});

test('get/remove honor the name guard and round-trip bytes', async () => {
  await reset();
  const e = await stack.write(makePng(10, 10), 'image/png', { url: 'http://u' });
  const got = await stack.get(e.name);
  assert.ok(got);
  assert.equal(got.mediaType, 'image/png');
  assert.equal(got.meta.url, 'http://u');

  assert.equal(await stack.get('../escape.png'), null);
  assert.equal(await stack.remove('../escape.png'), false);
  assert.equal(await stack.remove(e.name), true);
  assert.equal(await stack.count(), 0);
});
