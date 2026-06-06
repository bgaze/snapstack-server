import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { makePng } from './fixtures.js';

// End-to-end check of the stdio front-end (snapstack-mcp.js): spawn the real bin
// and drive it with the MCP SDK client over stdin/stdout. Exercises the shared
// factory (lib/mcp-tools.js) over the same on-disk stack — no HTTP, no registry.

const serverRoot = fileURLToPath(new URL('..', import.meta.url));
const bin = path.join(serverRoot, 'snapstack-mcp.js');

// Seed a capture in an isolated stack dir, then point the spawned bin at it.
const dir = await mkdtemp(path.join(os.tmpdir(), 'snapstack-stdio-'));
process.env.SNAPSTACK_DIR = dir;
const stack = await import('../lib/stack.js');
await stack.ensureDir();
await stack.write(makePng(120, 80), 'image/png', { url: 'http://example.test', title: 'Example' });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [bin],
  env: { SNAPSTACK_DIR: dir, PATH: process.env.PATH },
});
const client = new Client({ name: 'snapstack-test', version: '1.0.0' });
await client.connect(transport);

test.after(async () => {
  await client.close();
  await rm(dir, { recursive: true, force: true });
});

test('stdio front-end exposes the three snapstack tools', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['clear_screenshots', 'count_screenshots', 'get_screenshots']);
});

test('count_screenshots reports the seeded capture', async () => {
  const r = await client.callTool({ name: 'count_screenshots' });
  assert.match(r.content[0].text, /^1 pending/);
});

test('get_screenshots returns a manifest over the same on-disk stack', async () => {
  const r = await client.callTool({ name: 'get_screenshots', arguments: {} });
  const manifest = JSON.parse(r.content[0].text);
  assert.equal(manifest.count, 1);
  assert.equal(manifest.screenshots[0].width, 120);
  assert.equal(manifest.screenshots[0].height, 80);
  assert.equal(manifest.screenshots[0].url, 'http://example.test');
});
