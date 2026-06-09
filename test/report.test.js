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

test('updateLine shows an upgrade, up-to-date, or offline state', () => {
  assert.match(updateLine({ local: '1.0.3', latest: '1.1.0', useColor: false }), /update available\s+1\.0\.3 → 1\.1\.0/);
  assert.match(updateLine({ local: '1.0.3', latest: '1.1.0', useColor: false }), /snapstack restart/);
  assert.match(updateLine({ local: '1.1.0', latest: '1.1.0', useColor: false }), /up to date/);
  assert.match(updateLine({ local: '1.0.3', latest: null, useColor: false }), /unavailable/);
});

test('renderReport surfaces both badges, health detail, and the command list', () => {
  const service = { manager: 'launchd', target: 'com.snapstack.server', enabled: true, running: true, pid: 1199 };
  const health = { ok: true, version: '1.0.3', protocol: 1 };
  const out = renderReport({ service, health, count: 3, dir: '/home/u/.snapstack', useColor: false });

  assert.match(out, /Service\s+● running/);
  assert.match(out, /com\.snapstack\.server · pid 1199/); // pid shown when running
  assert.match(out, /Server\s+● healthy/);
  assert.match(out, /version 1\.0\.3\s+protocol 1\s+·\s+3 screenshots pending/);
  assert.match(out, /stack\s+\/home\/u\/\.snapstack/);
  assert.match(out, /snapstack start \| stop \| restart/);
  assert.match(out, /snapstack enable \| disable/);
});

test('renderReport omits the health detail when the server is down', () => {
  const service = { manager: 'systemd', target: 'snapstack.service', enabled: false, running: false };
  const out = renderReport({ service, health: null, count: undefined, dir: '/x', useColor: false });

  assert.match(out, /Server\s+● down\s+→ run 'snapstack enable'/);
  assert.doesNotMatch(out, /protocol/);
  assert.match(out, /1 screenshot pending|stack\s+\/x/); // detail block gone, stack dir stays
});
