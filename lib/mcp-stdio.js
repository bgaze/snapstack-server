import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ensureDir } from './stack.js';
import { buildMcpServer } from './mcp-tools.js';

// The stdio MCP front-end (`snapstack mcp`): the LLM client spawns this process
// and speaks MCP over stdin/stdout. It shares the transport-agnostic tool
// factory (lib/mcp-tools.js) with the HTTP /mcp route over the same on-disk
// stack — no HTTP server, no registry, no capture intake here.
export async function startStdioMcp() {
  await ensureDir();
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
