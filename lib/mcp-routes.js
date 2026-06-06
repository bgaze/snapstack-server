import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { config, allowedHosts } from './config.js';
import * as stack from './stack.js';

// Manifest item shape — reused for the output schema and matched by the
// structuredContent the tool returns. Mirrors stack.listDetailed().
const SCREENSHOT_SHAPE = {
  number: z.number().int().nullable(),
  name: z.string(),
  path: z.string(),
  url: z.string().nullable(),
  title: z.string().nullable(),
  capturedAt: z.string().nullable(),
  format: z.string().nullable(),
  bytes: z.number().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
};

/** Filter a manifest by capture numbers; report the ones that don't exist. */
function selectByNumbers(items, numbers) {
  if (!Array.isArray(numbers) || numbers.length === 0) return { items, missing: [] };
  const want = new Set(numbers);
  const selected = items.filter((it) => it.number != null && want.has(it.number));
  const present = new Set(selected.map((it) => it.number));
  const missing = [...new Set(numbers)].filter((n) => !present.has(n));
  return { items: selected, missing };
}

/** Build a fresh MCP server instance with the snapstack tools registered. */
export function buildMcpServer() {
  const server = new McpServer({ name: config.name, version: config.version });

  server.registerTool(
    'get_screenshots',
    {
      title: 'Get screenshots',
      description:
        'List the pending browser screenshots as a manifest — NO image data. The stack is the local folder '
        + 'where the snapstack browser extension pushes captures. Each entry has a stable two-digit "number", '
        + 'the absolute local "path", "width"/"height", and metadata (url, title, capturedAt, format, bytes). '
        + 'Read the file at "path" yourself only if you need the pixels. This tool does NOT delete anything — '
        + 'use clear_screenshots to remove captures. Pass "numbers" to list only specific captures '
        + '(e.g. [1] or [1,3]); omit to list them all.',
      inputSchema: {
        numbers: z
          .array(z.number().int().positive())
          .optional()
          .describe('Capture numbers to include (e.g. [1] or [1,3,5]). Omit to include all.'),
      },
      outputSchema: {
        count: z.number().int(),
        screenshots: z.array(z.object(SCREENSHOT_SHAPE)),
        missing: z.array(z.number().int()),
      },
    },
    async ({ numbers }) => {
      const all = await stack.listDetailed();
      const { items, missing } = selectByNumbers(all, numbers);
      const manifest = { count: items.length, screenshots: items, missing };
      // structuredContent for clients that parse it; the text block carries the
      // same JSON for clients that only read content.
      return {
        content: [{ type: 'text', text: JSON.stringify(manifest, null, 2) }],
        structuredContent: manifest,
      };
    },
  );

  server.registerTool(
    'clear_screenshots',
    {
      title: 'Clear screenshots',
      description:
        'Delete pending screenshots from the stack. Pass "numbers" to delete only specific captures '
        + '(e.g. [1] or [2,3]); omit to clear the whole stack. Once the stack is empty, numbering restarts at 01.',
      inputSchema: {
        numbers: z
          .array(z.number().int().positive())
          .optional()
          .describe('Capture numbers to delete (e.g. [2,3]). Omit to clear all.'),
      },
    },
    async ({ numbers }) => {
      const { deleted, missing, remaining } = await stack.clear(numbers);
      const parts = [`${deleted} screenshot(s) deleted from the snapstack stack.`];
      if (missing.length) parts.push(`Number(s) not found: ${missing.join(', ')}.`);
      parts.push(`${remaining} remaining.`);
      return { content: [{ type: 'text', text: parts.join(' ') }] };
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
