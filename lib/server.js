import http from 'node:http';
import { config } from './config.js';
import { ensureDir } from './stack.js';
import { handleCaptureRequest } from './capture-routes.js';
import { handleMcpRequest } from './mcp-routes.js';

// The always-on daemon: one Node process serving the capture surface and the
// MCP (Streamable HTTP) surface on 127.0.0.1, dispatched by path. This is what
// `snapstack run` launches — and what the auto-start launcher exec's.
export async function startServer() {
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

  return server;
}
