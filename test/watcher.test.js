import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, utimes, symlink, access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeRealPng } from './fixtures.js';

const stackDir = await mkdtemp(path.join(os.tmpdir(), 'snapstack-watcher-'));
process.env.SNAPSTACK_DIR = stackDir;
const { scanOnce } = await import('../lib/watcher.js');
const stack = await import('../lib/stack.js');

const POLICY = { format: 'webp', quality: 0.85, maxWidth: 1568, maxSlices: 50 };
const quiet = { log() {}, warn() {}, error() {} };
const roots = [];

test.after(async () => {
  for (const r of [stackDir, ...roots]) await rm(r, { recursive: true, force: true });
});

async function freshWatchDir() {
  const d = await mkdtemp(path.join(os.tmpdir(), 'snapstack-shots-'));
  roots.push(d);
  await stack.ensureDir();
  await stack.clear();
  return d;
}

// Write a file and pin its mtime (seconds-ago relative to `t`).
async function put(dir, name, bytes, mtimeMs) {
  const p = path.join(dir, name);
  await writeFile(p, bytes);
  await utimes(p, mtimeMs / 1000, mtimeMs / 1000);
  return p;
}

const exists = (p) => access(p).then(() => true, () => false);

test('first pass: pre-existing files are ignored, newer ones ingested once', async () => {
  const dir = await freshWatchDir();
  const t = Date.now();
  const settings = { enabled: true, dir, deleteOriginal: false, activatedAt: t };
  await put(dir, 'old.png', makeRealPng(40, 20), t - 60_000);
  await put(dir, 'Capture 1.png', makeRealPng(2000, 100), t + 1_000);

  const first = await scanOnce({ settings, state: null, policy: POLICY, now: t + 10_000, log: quiet });
  assert.equal(first.state.status, 'watching');
  assert.equal(first.state.activatedAt, t);
  assert.equal(first.state.seen.length, 2);
  const listed = await stack.listDetailed();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].title, 'Capture 1.png');
  assert.equal(listed[0].url, null);
  assert.equal(listed[0].format, 'image/webp');
  assert.equal(listed[0].width, 1568);
  assert.equal(first.state.lastIngest.number, listed[0].number);

  // Second pass, same state: nothing new.
  const second = await scanOnce({ settings, state: first.state, policy: POLICY, now: t + 20_000, log: quiet });
  assert.equal(await stack.count(), 1);
  // A file copied in later with an OLD mtime is still new after the first pass.
  await put(dir, 'copied.png', makeRealPng(30, 30), t - 120_000);
  await scanOnce({ settings, state: second.state, policy: POLICY, now: t + 30_000, log: quiet });
  assert.equal(await stack.count(), 2);
});

test('hidden files, non-images, sub-folders and symlinks are ignored', async () => {
  const dir = await freshWatchDir();
  const t = Date.now();
  const settings = { enabled: true, dir, deleteOriginal: false, activatedAt: t - 60_000 };
  const png = makeRealPng(20, 20);
  await put(dir, '.Capture in progress.png', png, t - 10_000);
  await put(dir, 'recording.mov', Buffer.from('mov'), t - 10_000);
  await put(dir, 'notes.txt', Buffer.from('txt'), t - 10_000);
  await mkdir(path.join(dir, 'sub.png'));
  const outside = await put(await freshWatchDir(), 'outside.png', png, t - 10_000);
  await symlink(outside, path.join(dir, 'link.png'));

  const { state } = await scanOnce({ settings, state: null, policy: POLICY, now: t, log: quiet });
  assert.equal(state.status, 'watching');
  assert.equal(await stack.count(), 0);
});

test('a file still being written is deferred, then taken', async () => {
  const dir = await freshWatchDir();
  const t = Date.now();
  const settings = { enabled: true, dir, deleteOriginal: false, activatedAt: t - 60_000 };
  await put(dir, 'fresh.png', makeRealPng(20, 20), t - 200);

  const first = await scanOnce({ settings, state: null, policy: POLICY, now: t, log: quiet });
  assert.equal(first.deferred, true);
  assert.equal(await stack.count(), 0);
  const second = await scanOnce({ settings, state: first.state, policy: POLICY, now: t + 5_000, log: quiet });
  assert.equal(second.deferred, false);
  assert.equal(await stack.count(), 1);
});

test('deleteOriginal removes the original after the stack write', async () => {
  const dir = await freshWatchDir();
  const t = Date.now();
  const settings = { enabled: true, dir, deleteOriginal: true, activatedAt: t - 60_000 };
  const p = await put(dir, 'shot.png', makeRealPng(20, 20), t - 10_000);

  const { state } = await scanOnce({ settings, state: null, policy: POLICY, now: t, log: quiet });
  assert.equal(await stack.count(), 1);
  assert.equal(await exists(p), false);
  assert.deepEqual(state.seen, []); // pruned: the original is gone
});

test('an undecodable image is stored as-is, never lost', async () => {
  const dir = await freshWatchDir();
  const t = Date.now();
  const settings = { enabled: true, dir, deleteOriginal: false, activatedAt: t - 60_000 };
  await put(dir, 'broken.png', Buffer.from('not really a png'), t - 10_000);

  await scanOnce({ settings, state: null, policy: POLICY, now: t, log: quiet });
  const [entry] = await stack.listDetailed();
  assert.equal(entry.format, 'image/png');
  assert.equal(await readFile(entry.path, 'utf8'), 'not really a png');
});

test('an unreadable folder yields an error verdict that keeps what was seen', async () => {
  const t = Date.now();
  const settings = { enabled: true, dir: path.join(stackDir, 'missing'), deleteOriginal: false, activatedAt: t };
  const prev = { activatedAt: t, dir: settings.dir, since: t, seen: ['a|1|1'] };
  const { state } = await scanOnce({ settings, state: prev, policy: POLICY, now: t, log: quiet });
  assert.equal(state.status, 'error');
  assert.equal(state.error.code, 'ENOENT');
  assert.deepEqual(state.seen, ['a|1|1']);
});

test('watching the stack folder itself is refused', async () => {
  const t = Date.now();
  const settings = { enabled: true, dir: stackDir, deleteOriginal: false, activatedAt: t };
  const { state } = await scanOnce({ settings, state: null, policy: POLICY, now: t, log: quiet });
  assert.equal(state.error.code, 'ESTACKDIR');
});
