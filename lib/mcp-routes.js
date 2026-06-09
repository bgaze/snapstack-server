import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { allowedHosts } from './config.js';
import { buildMcpServer } from './mcp-tools.js';

// The MCP tool definitions live in lib/mcp-tools.js (transport-agnostic), shared
// with the stdio front-end (lib/mcp-stdio.js). This module is the HTTP transport
// only: a fresh server + Streamable HTTP transport per request (stateless).

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Handle one MCP request on /mcp using the Streamable HTTP transport in
 * stateless mode (a fresh server + transport per request — safe and simple for
 * a single-user localhost tool).
 */
export async function handleMcpRequest(req, res) {
  if (!['POST', 'GET', 'DELETE'].includes(req.method)) {
    res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST, GET, DELETE' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }));
    return;
  }

  const server = buildMcpServer();
  // Stateless, plus a DNS-rebinding guard: only our own 127.0.0.1/localhost
  // authority is accepted as the Host (a re-bound attacker.com would not match).
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableDnsRebindingProtection: true,
    allowedHosts: allowedHosts(),
  });
  res.on('close', () => {
    Promise.resolve(transport.close?.()).catch(() => {});
    Promise.resolve(server.close?.()).catch(() => {});
  });

  try {
    await server.connect(transport);
    const body = req.method === 'POST' ? await readJson(req) : undefined;
    await transport.handleRequest(req, res, body);
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: String(e?.message || e) }, id: null }));
    }
  }
}
