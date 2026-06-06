#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ensureDir } from './lib/stack.js';
import { buildMcpServer } from './lib/mcp-tools.js';

// stdio MCP front-end: the client spawns this process and speaks JSON-RPC over
// stdin/stdout (no port, no network) — for clients that don't connect to the
// HTTP /mcp URL. Same tools, over the same on-disk stack (~/.snapstack, honoring
// SNAPSTACK_DIR) as the always-on server. Capture intake stays in snapstack-server;
// this front-end is read/clear only, spawned on demand.
//
// Typical client config:
//   { "command": "npx", "args": ["-y", "-p", "snapstack-server", "snapstack-mcp"] }

await ensureDir();
const server = buildMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
