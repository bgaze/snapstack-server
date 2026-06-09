import { config } from './config.js';
import { serviceStatus } from './service.js';

// `snapstack` (bare) / `snapstack status`: a two-axis health report. The Service
// badge comes from the OS service manager (enabled/running); the Server badge
// from a live /health probe — they are independent (a loaded service whose
// process is crash-looping shows Service running + Server down). The update line
// is a live registry check, rendered last and rewritten in place so the rest of
// the report (all local) stays instant.

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  grey: '\x1b[90m',
};

export function paint(useColor, code, s) {
  return useColor ? `${code}${s}${ANSI.reset}` : s;
}

/** Numeric semver compare on major.minor.patch (prerelease tags ignored). */
export function compareSemver(a, b) {
  const pa = String(a).split('.');
  const pb = String(b).split('.');
  for (let i = 0; i < 3; i++) {
    const x = parseInt(pa[i], 10) || 0;
    const y = parseInt(pb[i], 10) || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** Service badge from {enabled, running} — plus the next action when degraded. */
export function serviceBadge({ enabled, running }) {
  if (running) return { dot: '●', color: ANSI.green, label: 'running', hint: null };
  if (enabled) return { dot: '●', color: ANSI.yellow, label: 'stopped', hint: "run 'snapstack start'" };
  return { dot: '○', color: ANSI.grey, label: 'not enabled', hint: "run 'snapstack enable'" };
}

/** Server badge from the live /health probe, pointing at the right remedy. */
export function serverBadge(health, service) {
  if (health) return { dot: '●', color: ANSI.green, label: 'healthy', hint: null };
  let hint;
  if (service?.running) hint = "run 'snapstack restart'";
  else if (service?.enabled) hint = "run 'snapstack start'";
  else hint = "run 'snapstack enable'";
  return { dot: '●', color: ANSI.red, label: 'down', hint };
}

/**
 * Render the report body up to (and including) the "Updates" header. The live
 * update line is appended by runReport so it can be rewritten in place.
 * Layout: a plain padded label on the left, a value on the right — the value is
 * dim, except the colored "● <status>" of the Service/Server rows.
 */
export function renderReport({ service, health, count, dir, useColor }) {
  const b = (s) => paint(useColor, ANSI.bold, s);
  const d = (s) => paint(useColor, ANSI.dim, s);
  const row = (label, value) => `  ${label.padEnd(19)}${value}`;

  // "● <status>" stays colored by status; the parenthetical detail is dim.
  const badgeCell = (bd, info) =>
    paint(useColor, bd.color, `${bd.dot} ${bd.label}`) + d(bd.hint ? ` (→ ${bd.hint})` : ` (${info})`);

  let svcInfo = `${service.manager} · ${service.target}`;
  if (service.running && service.pid) svcInfo += ` · pid ${service.pid}`;

  const lines = [];
  lines.push(b('SnapStack'));
  lines.push('');
  lines.push(row('Service', badgeCell(serviceBadge(service), svcInfo)));
  lines.push(row('Server', badgeCell(serverBadge(health, service), `http://${config.host}:${config.port}`)));
  if (health) {
    lines.push(row('Server version', d(String(health.version))));
    lines.push(row('Protocol version', d(String(health.protocol))));
  }
  const pending = typeof count === 'number' ? ` (${count} screenshot${count === 1 ? '' : 's'} pending)` : '';
  lines.push(row('Stack', d(`${dir}${pending}`)));
  lines.push('');

  lines.push(b('Commands'));
  lines.push('');
  const cmds = [
    ['snapstack start | stop | restart', 'Control the service'],
    ['snapstack enable | disable', 'Start at login (on/off)'],
    ['snapstack status', 'This report'],
  ];
  // pad the plain command before coloring so the descriptions stay aligned
  for (const [c, desc] of cmds) lines.push(`  ${d(c.padEnd(38))}${desc}`);
  lines.push('');

  lines.push(b('Updates'));

  return lines.join('\n');
}

/** The live update line for the "Updates" section: available / up to date / unknown. */
export function updateLine({ local, latest, useColor }) {
  if (!latest) return paint(useColor, ANSI.dim, '  ⚠ Update check unavailable');
  if (local && compareSemver(latest, local) > 0) {
    return paint(useColor, ANSI.yellow, `  ⬆ Update ${latest} available`)
      + paint(useColor, ANSI.dim, `   (run 'snapstack restart' to update)`);
  }
  return paint(useColor, ANSI.green, '  ✓ Up to date');
}

// --- IO ---------------------------------------------------------------------

async function getJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Probe the running server: liveness (/health) + pending count (/count). */
export async function probeServer(timeoutMs = 1000) {
  const base = `http://${config.host}:${config.port}`;
  const [health, count] = await Promise.all([
    getJson(`${base}/health`, timeoutMs),
    getJson(`${base}/count`, timeoutMs),
  ]);
  return { health: health?.ok ? health : null, count: count?.count };
}

/** Latest published version from the npm registry (null on offline/timeout). */
export async function fetchLatest(timeoutMs = 3000) {
  const j = await getJson('https://registry.npmjs.org/snapstack-server/latest', timeoutMs);
  return j?.version || null;
}

/** Orchestrate the report: instant local block, then live update line. */
export async function runReport() {
  const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  const service = serviceStatus();
  const { health, count } = await probeServer(1000);
  const body = renderReport({ service, health, count, dir: config.dir, useColor });
  const local = health?.version || config.version;

  if (useColor) {
    // Print the report with a placeholder, then rewrite that last line in place.
    process.stdout.write(`${body}\n\n${paint(true, ANSI.dim, '  ⟳ checking for updates…')}\n`);
    const latest = await fetchLatest(3000);
    process.stdout.write(`\x1b[1A\x1b[2K\r${updateLine({ local, latest, useColor })}\n`);
  } else {
    const latest = await fetchLatest(3000);
    process.stdout.write(`${body}\n\n${updateLine({ local, latest, useColor })}\n`);
  }

  return health ? 0 : 1;
}
