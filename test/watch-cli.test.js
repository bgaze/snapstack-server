import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const stackDir = await mkdtemp(path.join(os.tmpdir(), 'snapstack-watchcli-'));
const shots = await mkdtemp(path.join(os.tmpdir(), 'snapstack-watchcli-shots-'));
process.env.SNAPSTACK_DIR = stackDir;
const cli = await import('../lib/watch-cli.js');
const ws = await import('../lib/watch-settings.js');

test.after(async () => {
  await rm(stackDir, { recursive: true, force: true });
  await rm(shots, { recursive: true, force: true });
});

// Collects what the command prints.
function sink() {
  const lines = [];
  return { lines, log: (s = '') => lines.push(s), error: (s = '') => lines.push(s), text: () => lines.join('\n') };
}
const UP = async () => ({ ok: true, version: '1.3.0' });
const DOWN = async () => null;

test('watchSummary: off, paused, pending, error, watching', () => {
  const on = { enabled: true, dir: '/s', deleteOriginal: false, activatedAt: 5 };
  const health = { ok: true, version: '1.3.0' };
  assert.equal(cli.watchSummary({ settings: ws.DEFAULT_SETTINGS, state: null, health }).label, 'off');
  assert.equal(cli.watchSummary({ settings: on, state: null, health: null }).label, 'paused');
  // No verdict yet (or a server predating the feature, which never answers).
  const none = cli.watchSummary({ settings: on, state: null, health });
  assert.equal(none.label, 'pending');
  assert.match(none.hint, /snapstack update/);
  // A verdict for an OLDER activation is not this setting's verdict.
  assert.equal(cli.watchSummary({ settings: on, state: { activatedAt: 4, status: 'watching' }, health }).label, 'pending');
  const err = cli.watchSummary({ settings: on, state: { activatedAt: 5, status: 'error', error: { code: 'ENOENT' } }, health });
  assert.equal(err.tone, 'error');
  assert.match(err.hint, /does not exist/);
  const ok = cli.watchSummary({
    settings: on, state: { activatedAt: 5, status: 'watching', lastIngest: { number: 7, source: 'Shot.png' } }, health,
  });
  assert.equal(ok.label, 'watching');
  assert.match(ok.info, /#07 from Shot\.png/);
});

test('explainError gives the macOS remedy for a protected folder', () => {
  assert.match(cli.explainError({ code: 'EPERM' }, { platform: 'darwin' }), /Pictures\/Screenshots/);
  assert.doesNotMatch(cli.explainError({ code: 'EPERM' }, { platform: 'linux' }), /macOS/);
  assert.match(cli.explainError({ code: 'EACCES' }, { platform: 'darwin' }), /permissions/);
});

test('direct mode rejects a missing folder, a file, an unknown option, extra args', async () => {
  for (const args of [[path.join(shots, 'missing')], ['--nope', shots], [shots, shots]]) {
    const out = sink();
    assert.equal(await cli.runWatch(args, { out, isTTY: false, probe: UP }), 1, args.join(' '));
  }
  const file = path.join(shots, 'a.txt');
  await writeFile(file, 'x');
  const out = sink();
  assert.equal(await cli.runWatch([file], { out, isTTY: false, probe: UP }), 1);
  assert.match(out.text(), /not a folder/);
});

test('direct mode with the server down saves the setting and exits 0', async () => {
  const out = sink();
  assert.equal(await cli.runWatch([shots, '--delete-original'], { out, isTTY: false, probe: DOWN }), 0);
  const s = await ws.readWatchSettings();
  assert.equal(s.enabled, true);
  assert.equal(s.dir, path.resolve(shots));
  assert.equal(s.deleteOriginal, true);
  assert.match(out.text(), /not running/);
});

test('activate waits for the verdict that answers ITS activation only', async () => {
  const at = 1_000_000;
  // A stale verdict (older activation) is present: it must not count.
  await ws.writeWatchState({ activatedAt: at - 1, status: 'watching' });
  const stale = await cli.activate({ dir: shots, deleteOriginal: false }, { probe: UP, now: () => at, timeoutMs: 300 });
  assert.equal(stale.verdict, null);
  assert.equal(cli.reportActivation(stale, sink()), 1);

  // A daemon answering this activation, shortly after.
  setTimeout(() => ws.writeWatchState({ activatedAt: at + 1, status: 'error', error: { code: 'EPERM' } }), 100);
  const res = await cli.activate({ dir: shots, deleteOriginal: false }, { probe: UP, now: () => at + 1, timeoutMs: 2000 });
  assert.equal(res.verdict.status, 'error');
  const out = sink();
  assert.equal(cli.reportActivation(res, out), 1);
  assert.match(out.text(), /cannot watch/);
});

test('watch off disables and keeps the folder for next time', async () => {
  await ws.writeWatchSettings({ enabled: true, dir: shots, deleteOriginal: false, activatedAt: 1 });
  const out = sink();
  assert.equal(await cli.runWatch(['off'], { out, isTTY: false, probe: UP }), 0);
  const s = await ws.readWatchSettings();
  assert.equal(s.enabled, false);
  assert.equal(s.dir, shots);
});

test('bare watch without a terminal prints status + usage, never prompts', async () => {
  const out = sink();
  assert.equal(await cli.runWatch([], { out, isTTY: false, probe: DOWN }), 0);
  assert.match(out.text(), /Watch folder: off/);
  assert.match(out.text(), /Usage:/);
});
