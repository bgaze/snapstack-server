import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { isStackDir, readWatchSettings, readWatchState, writeWatchSettings } from './watch-settings.js';
import {
  activate, explainError, probeHealth, reportActivation,
} from './watch-cli.js';
import {
  applyMacRedirect, formatCommand, isProtectedForService, macRedirectCommand, macThumbnailEnabled, macThumbnailTip,
  macUndoCommand, run, screenshotFolders,
} from './watch-paths.js';

// `snapstack watch` in a terminal: a guided setup. Every step has a default
// taken on Enter. It is the ONLY place allowed to change an OS preference (the
// macOS screenshot location), and only after an explicit "y".

const TEST_TIMEOUT_MS = 60_000;

/** Terminal I/O; `ask` accepts an AbortSignal so a pending prompt can be cancelled. */
export function terminalIo() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let closing = false;
  // Ctrl+C / Ctrl+D quit at once: nothing is saved before the final step.
  const quit = () => {
    if (closing) return;
    console.log('');
    process.exit(130);
  };
  rl.on('SIGINT', quit);
  rl.on('close', quit);
  return {
    ask: (q, { signal } = {}) => rl.question(q, signal ? { signal } : undefined),
    log: (s = '') => console.log(s),
    close: () => {
      closing = true;
      rl.close();
    },
  };
}

const yes = (answer, dflt) => {
  const a = String(answer ?? '').trim().toLowerCase();
  return a === '' ? dflt : a === 'y' || a === 'yes' || a === 'o' || a === 'oui';
};

function expand(input, home) {
  const p = input.trim();
  if (p === '~' || p.startsWith('~/')) return path.join(home, p.slice(1));
  return path.resolve(p);
}

/** Step 2: choose the folder (loops until a usable one). */
async function chooseFolder(io, { folders, settings, platform, home }) {
  // Reconfiguring an active watch → its folder; otherwise the OS proposal
  // (never a stale folder left behind by a `watch off`).
  const dflt = settings.enabled ? settings.dir : folders.proposed;
  for (;;) {
    io.log('');
    const answer = await io.ask(`Folder to watch [${dflt}]: `);
    const dir = answer.trim() ? expand(answer, home) : dflt;
    if (isStackDir(dir)) {
      io.log('That is the SnapStack stack folder itself — pick the folder your screenshots are saved to.');
      continue;
    }
    if (isProtectedForService(dir, { platform, home })) {
      io.log('Note: macOS may keep the background service out of this folder (Desktop, Documents and Downloads are');
      io.log('privacy-protected) — the server checks it right after.');
    }
    try {
      const st = await fs.stat(dir);
      if (!st.isDirectory()) {
        io.log(`${dir} is a file, not a folder.`);
        continue;
      }
    } catch {
      await fs.mkdir(dir, { recursive: true });
      io.log(`Created ${dir}.`);
    }
    return dir;
  }
}

/** Step 3: make the OS screenshot tool save into `dir`. */
async function redirect(io, { dir, folders, platform, home, exec }) {
  if (folders.effective === dir) {
    io.log('Your screenshot tool already saves there.');
    return;
  }
  if (platform === 'darwin') {
    io.log(`macOS currently saves screenshots to ${folders.effective}.`);
    const cmd = formatCommand(macRedirectCommand(dir));
    io.log('');
    if (yes(await io.ask(`Point macOS screenshots to ${dir}? [y/N] `), false)) {
      if (applyMacRedirect(dir, { home, exec })) {
        io.log('Done. To undo it later, run:');
        io.log(`  ${formatCommand(macUndoCommand(folders.current))}`);
      } else {
        io.log('Could not change it. Run it yourself:');
        io.log(`  ${cmd}`);
      }
    } else {
      io.log('To do it yourself, run:');
      io.log(`  ${cmd}`);
      io.log('or: Cmd+Shift+5 → Options → Save to → Other Location…');
    }
    return;
  }
  if (platform === 'win32') {
    io.log(`Windows saves Win+PrtScn and Snipping Tool screenshots to ${folders.effective}.`);
    io.log(`Set your screenshot tool to save into ${dir}, or watch ${folders.effective} instead.`);
    return;
  }
  io.log(`GNOME saves screenshots to ${folders.effective}. Set your screenshot tool to save into ${dir}, or watch that folder instead.`);
}

/** Step 8: wait for a new stacked screenshot, or Enter, or the timeout. */
export async function waitForIngest(io, since, { timeoutMs = TEST_TIMEOUT_MS, intervalMs = 500 } = {}) {
  const ctrl = new AbortController();
  const skip = io.ask('', { signal: ctrl.signal }).then(() => 'skipped', () => 'aborted');
  const poll = (async () => {
    const end = Date.now() + timeoutMs;
    while (!ctrl.signal.aborted && Date.now() < end) {
      const s = await readWatchState();
      if (s?.lastIngest && s.lastIngest.at > since) return s.lastIngest;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return 'timeout';
  })();
  const result = await Promise.race([skip, poll]);
  ctrl.abort();
  return result;
}

/**
 * The guided setup. Returns the exit code. Dependencies are injectable so the
 * whole flow runs in tests without a terminal, a daemon or macOS.
 */
export async function runWizard({
  io = terminalIo(),
  platform = process.platform,
  home = os.homedir(),
  exec = run,
  probe = probeHealth,
  now = Date.now,
  testTimeoutMs = TEST_TIMEOUT_MS,
} = {}) {
  try {
    io.log('SnapStack — send your OS screenshots to the stack');
    const settings = await readWatchSettings();
    io.log('');
    io.log(settings.enabled
      ? `Currently watching ${settings.dir} (originals ${settings.deleteOriginal ? 'deleted' : 'kept'}).`
      : 'No folder is watched yet.');

    // Re-run on an active watch: stopping it comes first; "no" reconfigures it.
    if (settings.enabled) {
      io.log('');
      if (yes(await io.ask(`Stop watching ${settings.dir}? [y/N] `), false)) {
        await writeWatchSettings({ ...settings, enabled: false });
        io.log('Watch folder off — screenshots are no longer picked up.');
        return 0;
      }
    }

    const folders = screenshotFolders({ platform, home, exec });
    if (platform === 'darwin') {
      io.log('');
      if (folders.current && folders.current !== folders.effective) {
        io.log(`macOS is set to save screenshots to ${folders.current}, which does not exist — so they land on ${folders.effective}.`);
      } else {
        io.log(`macOS saves screenshots to ${folders.effective}.`);
      }
      if (folders.protected) io.log('The SnapStack background service may not be allowed to read that folder (macOS privacy protection).');
    }

    // Closing tip (macOS): the floating thumbnail delays every save by ~5 s.
    const tip = () => {
      if (platform !== 'darwin' || !macThumbnailEnabled({ exec })) return;
      io.log('');
      for (const line of macThumbnailTip()) io.log(line);
    };

    for (;;) {
      const dir = await chooseFolder(io, { folders, settings, platform, home });
      await redirect(io, { dir, folders, platform, home, exec });
      const keepDefault = settings.enabled ? !settings.deleteOriginal : true;
      io.log('');
      const keep = yes(await io.ask(`Keep the original file once it is in the stack? ${keepDefault ? '[Y/n]' : '[y/N]'} `), keepDefault);

      const result = await activate({ dir, deleteOriginal: !keep }, { probe, now });
      const code = reportActivation(result, { log: io.log, error: io.log });
      if (!result.verdict) {
        if (code === 0) tip();
        return code;
      }
      if (result.verdict.status === 'error') {
        io.log('');
        if (yes(await io.ask('Choose another folder? [Y/n] '), true)) continue;
        return 1;
      }

      io.log('');
      if (yes(await io.ask('Test it now with a screenshot? [Y/n] '), true)) {
        io.log(`Take a screenshot now — waiting up to ${Math.round(testTimeoutMs / 1000)} s (Enter to skip).`);
        const got = await waitForIngest(io, result.settings.activatedAt, { timeoutMs: testTimeoutMs });
        if (got && typeof got === 'object') {
          io.log('');
          io.log(`✓ Got it: #${String(got.number).padStart(2, '0')} (from ${got.source ?? got.name}) is in the stack.`);
          io.log('Ask your AI assistant to look at your screenshots.');
        } else if (got === 'timeout') {
          io.log('');
          io.log('No screenshot arrived. Check where your screenshot tool saves (above), then run \'snapstack\'.');
          const s = await readWatchState();
          if (s?.status === 'error') io.log(`The server reports: ${explainError(s.error)}.`);
        }
      }
      tip();
      return 0;
    }
  } catch (e) {
    if (e?.code === 'ABORT_ERR' || e?.name === 'AbortError') return 130; // Ctrl+C / closed input
    io.log(`snapstack watch: ${e.message}`);
    return 1;
  } finally {
    io.close?.();
  }
}
