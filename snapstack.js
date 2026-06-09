#!/usr/bin/env node
import { config } from './lib/config.js';

// Single entry point for SnapStack. Subcommands:
//   (none) | status      two-axis health report (+ live update check)
//   run                  the always-on capture + HTTP MCP daemon
//   mcp                  the stdio MCP front-end (spawned by the LLM client)
//   start | stop | restart   transient control of the auto-start service
//   enable | disable     register / remove start-at-login
//   --version | --help

const HELP = `SnapStack — local browser-screenshot pipe for MCP clients.

Usage: snapstack <command>

  (none), status        Health report: service + server status, update check
  start | stop | restart  Control the running service (this session)
  enable | disable      Register / remove start-at-login (+ crash-restart, self-update)
  run                   Run the capture + MCP daemon in the foreground
  mcp                   Run the stdio MCP front-end (for LLM-client config)
  --version, -v         Print the version
  --help, -h            Show this help
`;

function fail(msg) {
  console.error(msg);
  process.exitCode = 1;
}

async function control(cmd) {
  const svc = await import('./lib/service.js');
  if (cmd === 'enable') return svc.enable();
  if (cmd === 'disable') return svc.disable();

  if (cmd === 'start' && !svc.serviceStatus().enabled) {
    return fail("Service is not enabled — run 'snapstack enable' first.");
  }
  const past = { start: 'started', stop: 'stopped', restart: 'restarted' }[cmd];
  const ok = svc[cmd]();
  if (ok) console.log(`snapstack ${past}.`);
  else fail(`Could not ${cmd} the service (is it enabled? run 'snapstack enable').`);
}

const cmd = process.argv[2];

switch (cmd) {
  case 'run': {
    const { startServer } = await import('./lib/server.js');
    await startServer();
    break;
  }
  case 'mcp': {
    const { startStdioMcp } = await import('./lib/mcp-stdio.js');
    await startStdioMcp();
    break;
  }
  case 'enable':
  case 'disable':
  case 'start':
  case 'stop':
  case 'restart':
    await control(cmd);
    break;
  case undefined:
  case 'status': {
    const { runReport } = await import('./lib/report.js');
    process.exitCode = await runReport();
    break;
  }
  case '--version':
  case '-v':
    console.log(config.version);
    break;
  case '--help':
  case '-h':
    process.stdout.write(HELP);
    break;
  default:
    fail(`Unknown command: ${cmd}\n`);
    process.stdout.write(HELP);
}
