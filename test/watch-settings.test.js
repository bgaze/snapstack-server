import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makePng } from './fixtures.js';

const dir = await mkdtemp(path.join(os.tmpdir(), 'snapstack-watchset-'));
process.env.SNAPSTACK_DIR = dir;
const ws = await import('../lib/watch-settings.js');
const stack = await import('../lib/stack.js');

test.after(() => rm(dir, { recursive: true, force: true }));

test('no file → disabled defaults', async () => {
  assert.deepEqual(await ws.readWatchSettings(), ws.DEFAULT_SETTINGS);
  assert.equal(await ws.readWatchState(), null);
});

test('write/read round-trip, atomic (no temp file left)', async () => {
  const s = { enabled: true, dir: '/tmp/shots', deleteOriginal: true, activatedAt: 123 };
  assert.deepEqual(await ws.writeWatchSettings(s), s);
  assert.deepEqual(await ws.readWatchSettings(), s);
  assert.deepEqual((await readdir(dir)).filter((n) => n.endsWith('.tmp')), []);
});

test('an enabled watch needs an absolute dir and an activation time', async () => {
  await assert.rejects(ws.writeWatchSettings({ enabled: true, dir: 'relative/shots', activatedAt: 1 }));
  await assert.rejects(ws.writeWatchSettings({ enabled: true, dir: '/tmp/shots', activatedAt: null }));
});

test('the stack folder itself cannot be watched', async () => {
  await assert.rejects(ws.writeWatchSettings({ enabled: true, dir, activatedAt: 1 }), /stack folder/);
});

test('a corrupt or invalid setting collapses to disabled', async () => {
  await writeFile(ws.settingsPath(), '{ nope');
  assert.deepEqual(await ws.readWatchSettings(), ws.DEFAULT_SETTINGS);
  await writeFile(ws.settingsPath(), JSON.stringify({ enabled: true, dir: 'relative' }));
  assert.deepEqual(await ws.readWatchSettings(), ws.DEFAULT_SETTINGS);
});

test('the stack never lists nor clears the watch files', async () => {
  await ws.writeWatchSettings({ enabled: false });
  await ws.writeWatchState({ status: 'off' });
  await stack.write(makePng(10, 10), 'image/png');
  assert.equal(await stack.count(), 1);
  await stack.clear();
  const left = await readdir(dir);
  assert.ok(left.includes('watch.json') && left.includes('watch-state.json'), left.join(','));
});
