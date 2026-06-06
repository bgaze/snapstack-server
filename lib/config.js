import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const DEFAULT_DIR = path.join(os.homedir(), '.snapstack');
const DEFAULT_PORT = 4123;

// Single source of truth for the version: package.json. Surfaced on /health and
// in the MCP server identity so the contract is versioned from one place.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/**
 * Runtime configuration, resolved once from the environment.
 * - SNAPSTACK_DIR  : stack folder on disk (default ~/.snapstack)
 * - SNAPSTACK_PORT : TCP port (default 4123)
 * Host is always 127.0.0.1 — this tool never listens on a public interface.
 */
export const config = {
  name: 'snapstack',
  version: pkg.version,
  dir: process.env.SNAPSTACK_DIR
    ? path.resolve(process.env.SNAPSTACK_DIR)
    : DEFAULT_DIR,
  port: Number.parseInt(process.env.SNAPSTACK_PORT ?? '', 10) || DEFAULT_PORT,
  host: '127.0.0.1',
  // Reject capture bodies larger than this (raw image bytes or JSON dataUrl).
  maxBodyBytes: 20 * 1024 * 1024,
};

/** Hosts accepted on every surface — defends against DNS-rebinding. */
export function allowedHosts() {
  return [`127.0.0.1:${config.port}`, `localhost:${config.port}`];
}
