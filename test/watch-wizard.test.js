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
  return {
    lines,
    prompts,
    text: () => lines.join('\n'),
    log: (s = '') => lines.push(s),
    close() {},
    ask(q, { signal } = {}) {
      prompts.push(q);
      if (q === '') {
        return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      }
      if (!answers.length) throw new Error(`unexpected prompt: ${q}`);
      return Promise.resolve(answers.shift());
    },
  };
}

// Fake macOS `defaults` backed by a variable.
function fakeDefaults(initial) {
  const prefs = { location: initial };
  const exec = (cmd, args) => {
    if (cmd !== 'defaults') return { code: 1, stdout: '' };
    if (args[0] === 'read') return prefs.location ? { code: 0, stdout: prefs.location } : { code: 1, stdout: '' };
    if (args[0] === 'write') { prefs.location = args[3]; return { code: 0, stdout: '' }; }
    return { code: 1, stdout: '' };
  };
  return { prefs, exec };
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
});

test('macOS: declining the redirect changes nothing and prints the command', async () => {
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
