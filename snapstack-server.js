#!/usr/bin/env node
import http from 'node:http';
import { config } from './lib/config.js';
import { ensureDir } from './lib/stack.js';
import { handleCaptureRequest } from './lib/capture-routes.js';
import { handleMcpRequest } from './lib/mcp-routes.js';

// Subcommands: register/remove the auto-start unit (start at login + self-update).
// `snapstack-server` with no subcommand runs the server in the foreground.
const cmd = process.argv[2];
if (cmd === 'install' || cmd === 'uninstall') {
  const { install, uninstall } = await import('./lib/install.js');
  try {
    if (cmd === 'install') install();
    else uninstall();
  } catch (e) {
    console.error(String(e?.message || e));
    process.exit(1);
  }
  process.exit(0);
}

// Single always-on process: serves the capture intake (/push, /health, /count)
// for the browser extension AND the MCP endpoint (/mcp) for any MCP client, all on
// 127.0.0.1 only. The stack folder on disk is the decoupling point.
await ensureDir();

const server = http.createServer((req, res) => {
  let pathname = '/';
  try {
    pathname = new URL(req.url, `http://${config.host}`).pathname;
  } catch {
    /* keep default */
  }

  if (pathname === '/mcp') {
    handleMcpRequest(req, res);
    return;
  }

  handleCaptureRequest(req, res, pathname).catch((e) => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
    }
  });
});

server.listen(config.port, config.host, () => {
  console.log(`snapstack server listening on http://${config.host}:${config.port}`);
  console.log(`  stack dir : ${config.dir}`);
  console.log(`  capture   : POST http://${config.host}:${config.port}/push`);
  console.log(`  MCP (HTTP): http://${config.host}:${config.port}/mcp`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} already in use. Set SNAPSTACK_PORT to another value.`);
    process.exit(1);
  }
  console.error(e);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n${sig} received, shutting down.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
