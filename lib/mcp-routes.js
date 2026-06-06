import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { config } from './config.js';
import * as stack from './stack.js';

function describe(item, idx) {
  const meta = item.meta || {};
  const parts = [`#${idx}`];
  if (meta.title) parts.push(meta.title);
  if (meta.url) parts.push(meta.url);
  if (meta.capturedAt) parts.push(meta.capturedAt);
  if (meta.format) parts.push(meta.format);
  // Absolute local path on its own labeled line so the LLM can use it directly
  // (reference the file, build a link, read it back). `item.path` is resolved
  // live from the stack folder, so it is always correct.
  return `${parts.join(' · ')}\npath: ${item.path}`;
}

/** Build a fresh MCP server instance with the snapstack tools registered. */
export function buildMcpServer() {
  const server = new McpServer({ name: 'snapstack', version: '1.0.0' });

  server.registerTool(
    'get_screenshots',
    {
      title: 'Get screenshots',
      description:
        'Retrieve pending browser screenshots in chronological order (oldest first), then clear them from the stack '
        + '(the stack is the local folder where the snapstack browser extension pushes captures). '
        + 'Each capture is returned as a text block — "#<index> · <title> · <url> · <ISO timestamp> · <format>", then '
        + 'on its own line "path: <absolute local file path>" — followed by the image itself. Use the path to '
        + 'reference, link, or re-read the file locally.',
      inputSchema: {
        keep: z
          .boolean()
          .optional()
          .describe('If true, do not clear the stack after retrieval.'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Return only the N oldest captures instead of all of them.'),
      },
    },
    async ({ keep, limit }) => {
      const { items, errors } = await stack.readAll({ keep, limit });

      if (items.length === 0) {
        const content = [{ type: 'text', text: 'No pending screenshots in the snapstack stack.' }];
        if (errors.length) {
          content.push({ type: 'text', text: `(${errors.length} unreadable file(s) skipped.)` });
        }
        return { content };
      }

      const remaining = keep ? 0 : await stack.count();

      let status;
      if (keep) status = 'kept';
      else if (remaining > 0) status = `removed from the stack, ${remaining} remaining`;
      else status = 'stack cleared';
      const header = [`${items.length} screenshot(s) retrieved (${status}).`];

      if (errors.length) header.push(`${errors.length} unreadable file(s) skipped.`);
      if (!keep && remaining > 0) {
        header.push(
          `${remaining} screenshot(s) left: call get_screenshots again (with "limit" for large volumes) `
          + 'to keep draining the stack in batches until empty.',
        );
      }
      if (items.length > config.warnCount) {
        header.push(
          `⚠ Large batch (${items.length} images): some MCP clients cap a tool's output size. `
          + 'Prefer repeated calls with "limit" (e.g. limit:10) to drain the stack in batches.',
        );
      }

      const content = [{ type: 'text', text: header.join(' ') }];
      items.forEach((it, i) => {
        content.push({ type: 'text', text: describe(it, i + 1) });
        content.push({ type: 'image', data: it.data.toString('base64'), mimeType: it.mediaType });
      });
      return { content };
    },
  );

  server.registerTool(
    'clear_screenshots',
    {
      title: 'Clear screenshots',
      description: 'Delete all pending screenshots from the stack without retrieving them.',
    },
    async () => {
      const n = await stack.clear();
      return { content: [{ type: 'text', text: `${n} screenshot(s) deleted from the snapstack stack.` }] };
    },
  );

  server.registerTool(
    'count_screenshots',
    {
      title: 'Count screenshots',
      description: 'Return the number of pending screenshots in the stack without retrieving or clearing them.',
    },
    async () => {
      const n = await stack.count();
      return { content: [{ type: 'text', text: `${n} pending screenshot(s) in the snapstack stack.` }] };
    },
  );

  return server;
}

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
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
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
