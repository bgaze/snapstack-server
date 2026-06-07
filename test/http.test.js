import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makePng } from './fixtures.js';

// Fixed dir + port set before import: allowedHosts() is derived from config.port,
// so the Host guard only passes for requests to that exact authority.
const dir = await mkdtemp(path.join(os.tmpdir(), 'snapstack-http-'));
process.env.SNAPSTACK_DIR = dir;
process.env.SNAPSTACK_PORT = '41237';
const { config } = await import('../lib/config.js');
const { handleCaptureRequest } = await import('../lib/capture-routes.js');
const { handleMcpRequest } = await import('../lib/mcp-routes.js');

// Same dispatch as snapstack-server.js, so the test exercises real routing.
const server = http.createServer((req, res) => {
  let pathname = '/';
  try {
    pathname = new URL(req.url, `http://${config.host}`).pathname;
  } catch {
    /* keep default */
  }
  if (pathname === '/mcp') return handleMcpRequest(req, res);
  handleCaptureRequest(req, res, pathname).catch(() => {
    if (!res.headersSent) { res.writeHead(500); res.end(); }
  });
});

await new Promise((r) => server.listen(config.port, config.host, r));
const base = `http://${config.host}:${config.port}`;

test.after(() => new Promise((resolve) => {
  server.close(() => rm(dir, { recursive: true, force: true }).then(resolve));
}));

// fetch (undici) forbids overriding the Host header, so forged-host cases use
// the raw http client.
function rawStatus(method, pathname, host, body) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Accept'] = 'application/json, text/event-stream';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request(
      { host: config.host, port: config.port, path: pathname, method, headers },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); },
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('GET /health returns the version + protocol handshake', async () => {
  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.name, 'snapstack');
  assert.match(j.version, /^\d+\.\d+\.\d+/);
  assert.equal(typeof j.protocol, 'number');
  assert.ok(j.protocol >= 1);
  assert.equal(typeof j.minClientProtocol, 'number');
});

test('push → list → file → clear round-trip', async () => {
  const png = makePng(120, 80);
  const push = await fetch(`${base}/push`, {
    method: 'POST',
    headers: {
      'Content-Type': 'image/png',
      'X-Snapstack-Url': encodeURIComponent('http://example.test'),
      'X-Snapstack-Title': encodeURIComponent('Example'),
    },
    body: png,
  });
  assert.equal(push.status, 200);
  assert.equal((await push.json()).count, 1);

  const list = await (await fetch(`${base}/list`)).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].width, 120);
  assert.equal(list[0].height, 80);
  assert.equal(list[0].url, 'http://example.test');

  const name = list[0].name;
  const file = await fetch(`${base}/file/${encodeURIComponent(name)}`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);

  const clear = await fetch(`${base}/clear`, { method: 'POST' });
  assert.equal((await clear.json()).count, 0);
});

test('GET /file rejects non-image and traversal names', async () => {
  assert.equal((await fetch(`${base}/file/foo.txt`)).status, 400);
  assert.equal((await fetch(`${base}/file/..%2F..%2Fpackage.json`)).status, 400);
});

test('GET /file returns 404 for a valid but absent name', async () => {
  const name = encodeURIComponent('99 2099-01-01 00-00-00.png');
  assert.equal((await fetch(`${base}/file/${name}`)).status, 404);
});

test('GET /config returns the default policy', async () => {
  const r = await fetch(`${base}/config`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.format, 'webp');
  assert.equal(j.quality, 0.85);
  assert.equal(j.maxWidth, 1568);
  assert.equal(j.maxSlices, 50);
});

test('POST /config persists a valid policy and GET reads it back', async () => {
  const body = JSON.stringify({ format: 'png', quality: 0.7, maxWidth: 1200, maxSlices: 30 });
  const post = await fetch(`${base}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  assert.equal(post.status, 200);
  assert.deepEqual(await post.json(), { format: 'png', quality: 0.7, maxWidth: 1200, maxSlices: 30 });
  const get = await (await fetch(`${base}/config`)).json();
  assert.equal(get.format, 'png');
  assert.equal(get.maxWidth, 1200);
});

test('POST /config rejects an invalid policy with 400', async () => {
  const bad = JSON.stringify({ format: 'tiff', quality: 0.5, maxWidth: 100, maxSlices: 10 });
  const r = await fetch(`${base}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: bad,
  });
  assert.equal(r.status, 400);
});

test('config.json survives a stack clear', async () => {
  await fetch(`${base}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format: 'png', quality: 0.5, maxWidth: 1000, maxSlices: 25 }),
  });
  await fetch(`${base}/push`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: makePng(10, 10) });
  await fetch(`${base}/clear`, { method: 'POST' });
  const get = await (await fetch(`${base}/config`)).json();
  assert.equal(get.maxWidth, 1000);
});

test('capture surface rejects a forged Host (DNS-rebinding guard)', async () => {
  assert.equal(await rawStatus('GET', '/health', 'evil.example.com'), 403);
  assert.equal(await rawStatus('GET', '/count', 'attacker.test:80'), 403);
  assert.equal(await rawStatus('GET', '/health', `127.0.0.1:${config.port}`), 200);
});

test('MCP endpoint rejects a forged Host', async () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const status = await rawStatus('POST', '/mcp', 'evil.example.com', body);
  assert.ok(status >= 400, `expected an error status, got ${status}`);
});
