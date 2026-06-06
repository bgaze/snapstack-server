import os from 'node:os';
import path from 'node:path';

const DEFAULT_DIR = path.join(os.homedir(), '.snapstack');
const DEFAULT_PORT = 4123;

/**
 * Runtime configuration, resolved once from the environment.
 * - SNAPSTACK_DIR  : stack folder on disk (default ~/.snapstack)
 * - SNAPSTACK_PORT : TCP port (default 4123)
 * Host is always 127.0.0.1 — this tool never listens on a public interface.
 */
export const config = {
  dir: process.env.SNAPSTACK_DIR
    ? path.resolve(process.env.SNAPSTACK_DIR)
    : DEFAULT_DIR,
  port: Number.parseInt(process.env.SNAPSTACK_PORT ?? '', 10) || DEFAULT_PORT,
  host: '127.0.0.1',
  // Reject capture bodies larger than this (raw image bytes or JSON dataUrl).
  maxBodyBytes: 20 * 1024 * 1024,
  // Above this many captures, get_screenshots warns about the MCP output token cap.
  warnCount: 20,
};
