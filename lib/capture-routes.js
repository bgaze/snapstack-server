import { spawn } from 'node:child_process';
import { config, allowedHosts } from './config.js';
import * as stack from './stack.js';

// DNS-rebinding guard: a page served from attacker.com re-bound to 127.0.0.1
// still sends `Host: attacker.com`, so only our own authority is accepted. CORS
// merely hides the response; this blocks the no-cors write side effect too.
function hostAllowed(req) {
  return allowedHosts().includes((req.headers.host || '').toLowerCase());
}

// Open the stack folder in the OS file manager. The command receives only the
// fixed, pre-resolved config.dir (never request input) and runs without a shell,
// so there is no injection surface. Errors are swallowed (no opener available).
function revealDir() {
  let cmd;
  if (process.platform === 'darwin') cmd = 'open';
  else if (process.platform === 'win32') cmd = 'explorer';
  else cmd = 'xdg-open';
  const child = spawn(cmd, [config.dir], { detached: true, stdio: 'ignore' });
  child.on('error', () => {}); // missing opener → ignore, never crash the server
  child.unref();
}

// Only browser-extension origins are allowed via CORS. Extension requests made
// with a 127.0.0.1 host_permission usually bypass CORS entirely, but reflecting
// the origin keeps content-script / page contexts working too.
const EXT_ORIGIN = /^(chrome-extension|moz-extension):\/\//;

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && EXT_ORIGIN.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Snapstack-Url, X-Snapstack-Title');
  // Chrome Private Network Access: allow extension → 127.0.0.1 preflights.
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeHeader(v) {
  if (!v) return null;
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/** Routes the capture-side HTTP surface: /push, /health, /count (+ CORS). */
export async function handleCaptureRequest(req, res, pathname) {
  if (!hostAllowed(req)) {
    return sendJson(res, 403, { ok: false, error: 'forbidden host' });
  }
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === '/health' && req.method === 'GET') {
    // version = marketing semver; protocol = extension↔server wire contract.
    return sendJson(res, 200, {
      ok: true,
      name: config.name,
      version: config.version,
      protocol: config.protocol,
      minClientProtocol: config.minClientProtocol,
    });
  }

  if (pathname === '/count' && req.method === 'GET') {
    try {
      return sendJson(res, 200, { count: await stack.count() });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  if (pathname === '/push' && req.method === 'POST') {
    return handlePush(req, res);
  }

  // --- stack management surface (for the extension dropdown) --------------
  if (pathname === '/list' && req.method === 'GET') {
    try {
      return sendJson(res, 200, await stack.listDetailed());
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  if (pathname.startsWith('/file/')) {
    const name = decodeURIComponent(pathname.slice('/file/'.length));
    if (!stack.isValidName(name)) {
      return sendJson(res, 400, { ok: false, error: 'invalid name' });
    }
    if (req.method === 'GET') {
      const entry = await stack.get(name);
      if (!entry) return sendJson(res, 404, { ok: false, error: 'not found' });
      res.writeHead(200, {
        'Content-Type': entry.mediaType,
        'Content-Length': entry.bytes.length,
        'Cache-Control': 'no-store',
      });
      return res.end(entry.bytes);
    }
    if (req.method === 'DELETE') {
      const ok = await stack.remove(name);
      if (!ok) return sendJson(res, 404, { ok: false, error: 'not found' });
      return sendJson(res, 200, { ok: true, count: await stack.count() });
    }
    return sendJson(res, 405, { ok: false, error: 'method not allowed' });
  }

  if (pathname === '/clear' && req.method === 'POST') {
    try {
      await stack.clear();
      return sendJson(res, 200, { ok: true, count: 0 });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  if (pathname === '/reveal' && req.method === 'POST') {
    try {
      revealDir();
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  return sendJson(res, 404, { ok: false, error: 'not found' });
}

async function handlePush(req, res) {
  let raw;
  try {
    raw = await readBody(req, config.maxBodyBytes);
  } catch {
    return sendJson(res, 413, { ok: false, error: 'payload too large' });
  }

  const ctype = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  let bytes;
  let mediaType;
  let meta;

  try {
    if (ctype === 'application/json') {
      // Compat path: { dataUrl, url, title }
      const { dataUrl, url, title } = JSON.parse(raw.toString('utf8'));
      const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s.exec(dataUrl || '');
      if (!m) return sendJson(res, 400, { ok: false, error: 'invalid dataUrl' });
      mediaType = m[1];
      bytes = Buffer.from(m[2], 'base64');
      meta = { url, title };
    } else if (ctype.startsWith('image/')) {
      // Preferred path: raw image bytes + metadata headers.
      mediaType = ctype;
      bytes = raw;
      meta = {
        url: decodeHeader(req.headers['x-snapstack-url']),
        title: decodeHeader(req.headers['x-snapstack-title']),
      };
    } else {
      return sendJson(res, 415, { ok: false, error: 'unsupported content-type' });
    }
  } catch {
    return sendJson(res, 400, { ok: false, error: 'bad request' });
  }

  if (!bytes || bytes.length === 0) {
    return sendJson(res, 400, { ok: false, error: 'empty body' });
  }

  try {
    await stack.write(bytes, mediaType, meta);
    return sendJson(res, 200, { ok: true, count: await stack.count() });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: e.message });
  }
}
