import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  applyMacRedirect, formatCommand, isProtectedForService, macUndoCommand, screenshotFolders,
} from '../lib/watch-paths.js';

const HOME = '/Users/ada';

// Fake exec: answers from a table keyed by "cmd arg1 arg2…".
function fakeExec(table) {
  const calls = [];
  const exec = (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    calls.push(key);
    return table[key] ?? { code: 1, stdout: '' };
  };
  return { exec, calls };
}

test('macOS, location unset → Desktop (protected) → propose Pictures/Screenshots', () => {
  const { exec } = fakeExec({});
  const f = screenshotFolders({ platform: 'darwin', home: HOME, exec, exists: () => true });
  assert.equal(f.current, null);
  assert.equal(f.effective, '/Users/ada/Desktop');
  assert.equal(f.protected, true);
  assert.equal(f.proposed, '/Users/ada/Pictures/Screenshots');
});

test('macOS, location set to a missing folder → macOS falls back to the Desktop', () => {
  const { exec } = fakeExec({ 'defaults read com.apple.screencapture location': { code: 0, stdout: '~/Downloads/screenshots' } });
  const f = screenshotFolders({ platform: 'darwin', home: HOME, exec, exists: () => false });
  assert.equal(f.current, '/Users/ada/Downloads/screenshots');
  assert.equal(f.effective, '/Users/ada/Desktop');
  assert.equal(f.proposed, '/Users/ada/Pictures/Screenshots');
});

test('macOS, location set to a readable folder → keep it', () => {
  const { exec } = fakeExec({ 'defaults read com.apple.screencapture location': { code: 0, stdout: '/Users/ada/Shots' } });
  const f = screenshotFolders({ platform: 'darwin', home: HOME, exec, exists: () => true });
  assert.equal(f.protected, false);
  assert.equal(f.proposed, '/Users/ada/Shots');
});

test('macOS protected folders, sub-folders included; others are fine', () => {
  const opts = { platform: 'darwin', home: HOME };
  for (const p of ['~/Desktop', '/Users/ada/Downloads/screenshots', '/Users/ada/Documents/x', '/Users/ada/Library/Mobile Documents/com~apple~CloudDocs']) {
    assert.equal(isProtectedForService(p, opts), true, p);
  }
  for (const p of ['/Users/ada/Pictures/Screenshots', '/Users/ada/DesktopShots', '/tmp/shots']) {
    assert.equal(isProtectedForService(p, opts), false, p);
  }
  assert.equal(isProtectedForService('/Users/ada/Desktop', { platform: 'linux', home: HOME }), false);
});

test('Windows: Screenshots known folder, %VARS% expanded; fallback when absent', () => {
  const { exec } = fakeExec({
    [`reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders /v {B7BEDE81-DF94-4682-A7D8-57A52620B86F}`]: {
      code: 0,
      stdout: 'HKEY_CURRENT_USER\\...\n    {B7BEDE81-DF94-4682-A7D8-57A52620B86F}    REG_EXPAND_SZ    %USERPROFILE%\\Pictures\\Screenshots',
    },
  });
  const f = screenshotFolders({ platform: 'win32', home: 'C:\\Users\\ada', env: { USERPROFILE: 'C:\\Users\\ada' }, exec });
  assert.equal(f.proposed, 'C:\\Users\\ada\\Pictures\\Screenshots');
  const none = screenshotFolders({ platform: 'win32', home: HOME, env: {}, exec: fakeExec({}).exec });
  assert.equal(none.current, null);
  assert.equal(none.proposed, path.join(HOME, 'Pictures', 'Screenshots'));
});

test('Linux: XDG Pictures/Screenshots, fallback ~/Pictures/Screenshots', () => {
  const { exec } = fakeExec({ 'xdg-user-dir PICTURES': { code: 0, stdout: '/home/ada/Images' } });
  assert.equal(screenshotFolders({ platform: 'linux', home: '/home/ada', exec }).proposed, '/home/ada/Images/Screenshots');
  // xdg-user-dir answers $HOME when PICTURES is not configured.
  const unset = fakeExec({ 'xdg-user-dir PICTURES': { code: 0, stdout: '/home/ada' } });
  assert.equal(screenshotFolders({ platform: 'linux', home: '/home/ada', exec: unset.exec }).proposed, '/home/ada/Pictures/Screenshots');
});

test('macOS redirect: write then read back; undo restores or deletes', () => {
  const store = {};
  const exec = (cmd, args) => {
    if (args[0] === 'write') { store.location = args[3]; return { code: 0, stdout: '' }; }
    if (args[0] === 'read') return store.location ? { code: 0, stdout: store.location } : { code: 1, stdout: '' };
    return { code: 1, stdout: '' };
  };
  assert.equal(applyMacRedirect('/Users/ada/Pictures/Screenshots', { home: HOME, exec }), true);
  assert.equal(formatCommand(macUndoCommand(null)), 'defaults delete com.apple.screencapture location');
  assert.equal(formatCommand(macUndoCommand('/Users/ada/My Shots')), "defaults write com.apple.screencapture location '/Users/ada/My Shots'");
});
