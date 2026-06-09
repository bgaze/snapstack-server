import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from './config.js';
import * as stack from './stack.js';

// The snapstack MCP tools, registered on a fresh McpServer over the on-disk
// stack — transport-agnostic on purpose. Both front-ends reuse this:
//   - HTTP (Streamable HTTP) : lib/mcp-routes.js, the always-on server
//   - stdio                  : lib/mcp-stdio.js, run via `snapstack mcp`
// Keeping it free of any transport import means the stdio front-end does not
// pull in the HTTP transport (and vice-versa).

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
        + 'where the SnapStack browser extension pushes captures. Each entry has a stable two-digit "number", '
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
      const parts = [`${deleted} screenshot(s) deleted from the SnapStack stack.`];
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
      return { content: [{ type: 'text', text: `${n} pending screenshot(s) in the SnapStack stack.` }] };
    },
  );

  return server;
}
