<p align="center">
  <img src="assets/logo.png" alt="snapstack" width="440">
</p>

<p align="center">
  <a href="https://github.com/bgaze/snapstack-server/actions/workflows/ci.yml"><img src="https://github.com/bgaze/snapstack-server/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/bgaze/snapstack-server?color=blue" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node >= 18">
  <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-compatible-blueviolet" alt="MCP compatible"></a>
  <img src="https://img.shields.io/badge/100%25-local-success" alt="100% local">
</p>

The **snapstack server** is a single always-on Node process: it receives browser captures from the
[extension](https://github.com/bgaze/snapstack-extension), stacks them on disk, and serves them to any
MCP-capable LLM client over **Streamable HTTP**. It listens only on `127.0.0.1` — nothing ever leaves your machine.

> **New here?** The full install + usage guide lives in the **extension README**:
> **[snapstack-extension](https://github.com/bgaze/snapstack-extension)**. This page is the technical reference.

## Architecture

One always-on process serves both the extension (capture) and your MCP client, decoupled by a folder on disk.

```
[MV3 extension]  --POST /push (bytes)-->  ┐
                                          ▼
                            [snapstack server]   127.0.0.1:4123
                               ├─ writes ─►  ~/.snapstack/   (stack on disk)
                               └─ MCP /mcp (HTTP)  ◄── MCP client
```

- **Capture** — the extension encodes the shot as WebP (PNG fallback), downscales it, and POSTs it here.
- **Stack** — one image file (`.webp`/`.png`) plus a twin `.json` (url, title, timestamp, dimensions) per capture,
  named `NN <timestamp>`: a stable two-digit **number** (assigned in capture order, restarts at `01` when the stack
  empties) plus a timestamp, under `~/.snapstack/`.
- **Retrieval** — `get_screenshots` returns a JSON **manifest** (number, absolute path, dimensions, metadata —
  *no image bytes*); the client reads only the files it needs, by path. Deletion is a separate, explicit
  `clear_screenshots` step. **Retrieval never deletes.**

## Requirements

- **Node.js ≥ 18** (tested on Node 20) and **git** (for self-update at launch).
- An **MCP-capable LLM client** speaking the HTTP (Streamable HTTP) transport.
- The **[snapstack-extension](https://github.com/bgaze/snapstack-extension)** loaded in your browser.

## Install & run

```bash
git clone https://github.com/bgaze/snapstack-server.git
cd snapstack-server
npm install        # only @modelcontextprotocol/sdk + zod
npm start          # → snapstack server listening on http://127.0.0.1:4123
```

For start-at-login + crash-restart + self-update, run the installer for your OS — it wires an auto-start unit that
calls `deploy/snapstack-start.*`, which does a fail-open `git pull --ff-only` before launching node:

```bash
./deploy/install-macos.sh      # macOS  — launchd LaunchAgent
./deploy/install-linux.sh      # Linux  — systemd --user service
.\deploy\install-windows.ps1   # Windows — logon scheduled task
```

The full end-to-end walkthrough (idiomatic install paths, MCP client registration, the extension) is in the
**[extension README](https://github.com/bgaze/snapstack-extension)**.

## MCP

Register the running server as an **HTTP** MCP server pointing at `http://127.0.0.1:4123/mcp`
(copy `deploy/mcp.json` or adapt it — config syntax is client-specific). The `/mcp` endpoint is **stateless**:
a fresh server + transport is built per request.

### Exposed tools

| Tool                | Description                                                                                                                                                                          |
|---------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `get_screenshots`   | Lists pending captures as a JSON manifest (stable number, absolute path, dimensions, metadata) — **no image bytes, no deletion**. Pass `numbers` (e.g. `[1,3]`) to list only those. |
| `clear_screenshots` | Deletes captures. Pass `numbers` to delete specific ones; omit to clear the whole stack. Numbering restarts at `01` once empty.                                                      |
| `count_screenshots` | Number of pending captures, without retrieving them.                                                                                                                                |

`get_screenshots` and `count_screenshots` are **read-only**; only `clear_screenshots` is **destructive**. To run a
tool without a per-call confirmation, add its identifier to your client's allow-list (for Claude Code:
`mcp__snapstack__<tool>` in `permissions.allow`).

> **Token cost**: `get_screenshots` returns only the manifest, so it stays cheap whatever the stack size — the client
> then reads just the files it needs. WebP + downscaling keep those reads light.

## Configuration (environment variables)

| Variable         | Default        | Purpose                                 |
|------------------|----------------|-----------------------------------------|
| `SNAPSTACK_DIR`  | `~/.snapstack` | Stack folder.                           |
| `SNAPSTACK_PORT` | `4123`         | Listening port (always on `127.0.0.1`). |

## Troubleshooting

- **"Capture server not started"** (in the extension): start the server (`npm start`) or check the auto-start.
  Test: `curl http://127.0.0.1:4123/health`.
- **Port already in use** (`EADDRINUSE`): set `SNAPSTACK_PORT` to another value.
- **The client doesn't see the tools**: the server must run **before** the MCP client starts; check the config
  (`type: "http"`, correct URL). Direct test: `curl http://127.0.0.1:4123/count`.
- **Inspect the stack**: `ls ~/.snapstack` (image files + human-readable `.json`).

## License

MIT — see [LICENSE](./LICENSE).
