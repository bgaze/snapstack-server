import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Fixed dir set before import: settings.js persists config.json under config.dir.
const dir = await mkdtemp(path.join(os.tmpdir(), 'snapstack-settings-'));
process.env.SNAPSTACK_DIR = dir;
const { DEFAULT_POLICY, readConfig, writeConfig } = await import('../lib/settings.js');

test.after(() => rm(dir, { recursive: true, force: true }));

test('readConfig returns the defaults when no file exists', async () => {
  assert.deepEqual(await readConfig(), DEFAULT_POLICY);
});

test('writeConfig validates, persists, and readConfig reads it back', async () => {
  const saved = await writeConfig({ format: 'png', quality: 0.6, maxEdge: 2000, maxSlices: 20 });
  assert.deepEqual(saved, { format: 'png', quality: 0.6, maxEdge: 2000, maxSlices: 20 });
  assert.deepEqual(await readConfig(), saved);
  const onDisk = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.deepEqual(onDisk, saved);
});

test('writeConfig rejects invalid or incomplete policies', async () => {
  await assert.rejects(() => writeConfig({ format: 'gif', quality: 0.5, maxEdge: 100, maxSlices: 10 }));
  await assert.rejects(() => writeConfig({ format: 'webp', quality: 2, maxEdge: 100, maxSlices: 10 }));
  await assert.rejects(() => writeConfig({ format: 'webp', quality: 0.5, maxEdge: -1, maxSlices: 10 }));
  await assert.rejects(() => writeConfig({ format: 'webp', quality: 0.5, maxEdge: 100, maxSlices: 0 }));
  await assert.rejects(() => writeConfig({ format: 'webp' })); // missing keys
});

test('readConfig overlays a partial file onto the defaults', async () => {
  await writeFile(path.join(dir, 'config.json'), JSON.stringify({ maxEdge: 800 }));
  assert.deepEqual(await readConfig(), { ...DEFAULT_POLICY, maxEdge: 800 });
});

test('readConfig falls back to the defaults on a corrupt file', async () => {
  await writeFile(path.join(dir, 'config.json'), 'not json {');
  assert.deepEqual(await readConfig(), DEFAULT_POLICY);
});
