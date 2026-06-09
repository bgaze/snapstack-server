import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareSemver,
  serviceBadge,
  serverBadge,
  updateLine,
  renderReport,
} from '../lib/report.js';

// Pure rendering only: the live IO (probe /health, fetch the registry) is
// side-effecting and bounded by timeouts, exercised by hand. Colors are gated
// on a TTY, so every assertion here runs with useColor: false (plain text).

test('compareSemver orders major.minor.patch numerically', () => {
  assert.equal(compareSemver('1.1.0', '1.0.3'), 1);
  assert.equal(compareSemver('1.0.3', '1.1.0'), -1);
  assert.equal(compareSemver('1.0.3', '1.0.3'), 0);
  assert.equal(compareSemver('1.0.10', '1.0.9'), 1); // not lexicographic
  assert.equal(compareSemver('2.0.0', '1.9.9'), 1);
});

test('serviceBadge reflects the enabled/running pair and suggests the next action', () => {
  assert.deepEqual(serviceBadge({ enabled: true, running: true }).label, 'running');
  assert.equal(serviceBadge({ enabled: true, running: true }).hint, null);

  const stopped = serviceBadge({ enabled: true, running: false });
  assert.equal(stopped.label, 'stopped');
  assert.match(stopped.hint, /snapstack start/);

  const off = serviceBadge({ enabled: false, running: false });
  assert.equal(off.label, 'not enabled');
  assert.match(off.hint, /snapstack enable/);
});

test('serverBadge is healthy with /health, else points at the right remedy', () => {
  assert.equal(serverBadge({ ok: true }, { enabled: true, running: true }).label, 'healthy');
  // down + the service believes it is running → crash-loop → restart
  assert.match(serverBadge(null, { enabled: true, running: true }).hint, /restart/);
  // down + enabled but not running → start
  assert.match(serverBadge(null, { enabled: true, running: false }).hint, /start/);
  // down + not even enabled → enable
  assert.match(serverBadge(null, { enabled: false, running: false }).hint, /enable/);
});

test('updateLine shows an upgrade, up-to-date, or unknown state', () => {
  const up = updateLine({ local: '1.0.3', latest: '1.1.0', useColor: false });
  assert.match(up, /⬆ Update 1\.1\.0 available/);
  assert.match(up, /\(run 'snapstack restart' to update\)/);
  assert.match(updateLine({ local: '1.1.0', latest: '1.1.0', useColor: false }), /^ {2}✓ Up to date$/);
  assert.match(updateLine({ local: '1.0.3', latest: null, useColor: false }), /⚠ Update check unavailable/);
});

test('renderReport surfaces both badges, health detail, and the command list', () => {
  const service = { manager: 'launchd', target: 'com.snapstack.server', enabled: true, running: true, pid: 1199 };
  const health = { ok: true, version: '1.0.3', protocol: 1 };
  const out = renderReport({ service, health, count: 3, dir: '/home/u/.snapstack', useColor: false });

  assert.match(out, /Service\s+● running \(launchd · com\.snapstack\.server · pid 1199\)/);
  assert.match(out, /Server\s+● healthy \(http:/);
  assert.match(out, /Server version\s+1\.0\.3/);
  assert.match(out, /Protocol version\s+1/);
  assert.match(out, /Stack\s+\/home\/u\/\.snapstack \(3 screenshots pending\)/);
  assert.match(out, /^Commands$/m);
  assert.match(out, /snapstack start \| stop \| restart\s+Control the service/);
  assert.match(out, /snapstack enable \| disable\s+Start at login/);
  assert.match(out, /^Updates$/m); // the live update line is appended by runReport
});

test('renderReport omits the health detail when the server is down', () => {
  const service = { manager: 'systemd', target: 'snapstack.service', enabled: false, running: false };
  const out = renderReport({ service, health: null, count: undefined, dir: '/x', useColor: false });

  assert.match(out, /Server\s+● down \(→ run 'snapstack enable'\)/);
  assert.doesNotMatch(out, /Server version|Protocol version/); // no health → no version rows
  assert.match(out, /Stack\s+\/x$/m); // stack dir stays, no pending suffix when down
});
