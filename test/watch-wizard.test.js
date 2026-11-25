import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const stackDir = await mkdtemp(path.join(os.tmpdir(), 'snapstack-wizard-'));
const home = await mkdtemp(path.join(os.tmpdir(), 'snapstack-wizard-home-'));
process.env.SNAPSTACK_DIR = stackDir;
const { runWizard } = await import('../lib/watch-wizard.js');
const ws = await import('../lib/watch-settings.js');

test.after(async () => {
  await rm(stackDir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

// Scripted terminal: answers in order; an empty-prompt ask (the "Enter to
// skip" wait) stays pending until aborted, like a real idle terminal.
function scriptedIo(answers) {
  const lines = [];
  const prompts = [];
  const transcript = [];
  return {
    lines,
    prompts,
    transcript,
    text: () => lines.join('\n'),
    log: (s = '') => { lines.push(s); transcript.push({ line: s }); },
    close() {},
    ask(q, { signal } = {}) {
      prompts.push(q);
      if (q !== '') transcript.push({ prompt: q });
      if (q === '') {
        return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      }
      if (!answers.length) throw new Error(`unexpected prompt: ${q}`);
      return Promise.resolve(answers.shift());
    },
  };
}

// Fake macOS `defaults` (com.apple.screencapture keys) backed by an object.
function fakeDefaults(location, extra = {}) {
  const prefs = { location, ...extra };
  const exec = (cmd, args) => {
    if (cmd !== 'defaults') return { code: 1, stdout: '' };
    const key = args[2];
    if (args[0] === 'read') return prefs[key] != null ? { code: 0, stdout: String(prefs[key]) } : { code: 1, stdout: '' };
    if (args[0] === 'write') { prefs[key] = args[args.length - 1]; return { code: 0, stdout: '' }; }
    return { code: 1, stdout: '' };
  };
  return { prefs, exec };
}

// Every question opens its own block: what was printed just before it is a blank line.
function assertBlocksIsolated(io) {
  io.transcript.forEach((entry, i) => {
    if (entry.prompt) assert.equal(io.transcript[i - 1]?.line, '', `no blank line before: ${entry.prompt}`);
  });
}

// Fake daemon: answers the first activation it sees with `verdict`, then
// (optionally) reports one ingested screenshot.
function fakeDaemon(verdict, { ingest = false } = {}) {
  const timer = setInterval(async () => {
    const s = await ws.readWatchSettings();
    const st = await ws.readWatchState();
    if (!s.enabled || st?.activatedAt === s.activatedAt) return;
    await ws.writeWatchState({
      activatedAt: s.activatedAt, dir: s.dir, ...verdict,
      lastIngest: ingest ? { number: 3, name: '03 x.webp', source: 'Shot.png', at: s.activatedAt + 50 } : null,
    });
  }, 50);
  return () => clearInterval(timer);
}

const UP = async () => ({ ok: true, version: '1.3.0' });

test('macOS happy path: proposed folder created, redirect on "y", undo shown, live test', async () => {
  await ws.writeWatchSettings(ws.DEFAULT_SETTINGS); // first run
  const { prefs, exec } = fakeDefaults('~/Downloads/screenshots'); // missing → Desktop
  const stop = fakeDaemon({ status: 'watching', error: null }, { ingest: true });
  const io = scriptedIo(['', 'y', '', 'y']); // folder default, redirect yes, keep original, test yes
  const code = await runWizard({ io, platform: 'darwin', home, exec, probe: UP });
  stop();

  const proposed = path.join(home, 'Pictures', 'Screenshots');
  assert.equal(code, 0, io.text());
  await access(proposed); // created
  assert.equal(prefs.location, proposed);
  assert.match(io.text(), /does not exist — so they land on/);
  assert.match(io.text(), /defaults write com\.apple\.screencapture location .*Downloads\/screenshots/); // undo
  assert.match(io.text(), /Watching /);
  assert.match(io.text(), /Got it: #03 \(from Shot\.png\)/);
  const s = await ws.readWatchSettings();
  assert.deepEqual([s.enabled, s.dir, s.deleteOriginal], [true, proposed, false]);
  assertBlocksIsolated(io);
  // Thumbnail on (macOS default) → closing tip with both ways to turn it off.
  assert.match(io.lines.at(-1), /defaults write com\.apple\.screencapture show-thumbnail -bool false/);
  assert.match(io.text(), /Show Floating Thumbnail/);
});

test('macOS: no thumbnail tip once the thumbnail is off', async () => {
  await ws.writeWatchSettings(ws.DEFAULT_SETTINGS);
  const { exec } = fakeDefaults(null, { 'show-thumbnail': '0' });
  const stop = fakeDaemon({ status: 'watching', error: null });
  const io = scriptedIo(['', 'n', '', 'n']);
  const code = await runWizard({ io, platform: 'darwin', home, exec, probe: UP });
  stop();
  assert.equal(code, 0, io.text());
  assert.doesNotMatch(io.text(), /Tip:/);
});

test('re-run on an active watch: "y" to stop turns it off, nothing else asked', async () => {
  const dir = path.join(home, 'Active');
  await ws.writeWatchSettings({ enabled: true, dir, deleteOriginal: true, activatedAt: 1 });
  const io = scriptedIo(['y']);
  const code = await runWizard({ io, platform: 'darwin', home, exec: fakeDefaults(null).exec, probe: UP });
  assert.equal(code, 0, io.text());
  assert.equal(io.prompts.length, 1);
  assert.match(io.prompts[0], /^Stop watching .*Active\? \[y\/N\]/);
  const s = await ws.readWatchSettings();
  assert.deepEqual([s.enabled, s.dir], [false, dir]);
});

test('re-run on an active watch: "n" reconfigures, defaults are the current setting', async () => {
  const dir = path.join(home, 'Active');
  await ws.writeWatchSettings({ enabled: true, dir, deleteOriginal: true, activatedAt: 1 });
  const stop = fakeDaemon({ status: 'watching', error: null });
  const io = scriptedIo(['n', '', 'n', '', 'n']); // keep watching, same folder, no redirect, keep default, no test
  const code = await runWizard({ io, platform: 'darwin', home, exec: fakeDefaults(null, { 'show-thumbnail': '0' }).exec, probe: UP });
  stop();
  assert.equal(code, 0, io.text());
  assert.ok(io.prompts.some((p) => p === `Folder to watch [${dir}]: `), io.prompts.join(' | '));
  assert.ok(io.prompts.some((p) => /Keep the original .*\[y\/N\]/.test(p))); // current: originals deleted
  const s = await ws.readWatchSettings();
  assert.deepEqual([s.enabled, s.dir, s.deleteOriginal], [true, dir, true]);
  assertBlocksIsolated(io);
});

test('after a watch off, the OS proposal is offered again (not the old folder)', async () => {
  await ws.writeWatchSettings({ enabled: false, dir: path.join(home, 'Documents'), deleteOriginal: false, activatedAt: 1 });
  const stop = fakeDaemon({ status: 'watching', error: null });
  const io = scriptedIo(['', 'n', '', 'n']);
  await runWizard({ io, platform: 'darwin', home, exec: fakeDefaults(null).exec, probe: UP });
  stop();
  assert.equal(io.prompts.find((p) => p.startsWith('Folder')), `Folder to watch [${path.join(home, 'Pictures', 'Screenshots')}]: `);
});

test('macOS: declining the redirect changes nothing and prints the command', async () => {
  await ws.writeWatchSettings(ws.DEFAULT_SETTINGS); // first run
  const { prefs, exec } = fakeDefaults(null);
  const stop = fakeDaemon({ status: 'watching', error: null });
  const io = scriptedIo(['', 'n', 'n', 'n']); // default folder, no redirect, delete original, no test
  const code = await runWizard({ io, platform: 'darwin', home, exec, probe: UP });
  stop();
  assert.equal(code, 0, io.text());
  assert.equal(prefs.location, null);
  assert.match(io.text(), /To do it yourself, run:/);
  assert.equal((await ws.readWatchSettings()).deleteOriginal, true);
});

test('a protected folder gets a note (no extra question); an error verdict offers another folder', async () => {
  await ws.writeWatchSettings(ws.DEFAULT_SETTINGS); // first run
  const { exec } = fakeDefaults(null);
  const stop = fakeDaemon({ status: 'error', error: { code: 'EPERM' } });
  const io = scriptedIo([
    path.join(home, 'Desktop'), // protected → a note, no question
    'n', '', // no redirect, keep original → daemon says EPERM
    'n', // do not choose another folder
  ]);
  const code = await runWizard({ io, platform: 'darwin', home, exec, probe: UP });
  stop();
  assert.equal(code, 1, io.text());
  assert.match(io.text(), /may keep the background service out/);
  assert.ok(!io.prompts.some((p) => /anyway/i.test(p)));
  assert.match(io.text(), /cannot watch/);
});

test('server down: the setting is saved, no verdict wait, no test', async () => {
  await ws.writeWatchSettings(ws.DEFAULT_SETTINGS); // first run: no previous folder
  const io = scriptedIo(['', '']); // Linux: default folder, keep original
  const exec = () => ({ code: 1, stdout: '' });
  const code = await runWizard({ io, platform: 'linux', home, exec, probe: async () => null });
  assert.equal(code, 0, io.text());
  assert.match(io.text(), /not running/);
  assert.equal((await ws.readWatchSettings()).dir, path.join(home, 'Pictures', 'Screenshots'));
});
