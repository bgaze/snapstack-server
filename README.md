<p align="center">
  <img src="assets/logo.png" alt="snapstack" width="440">
</p>

The **snapstack server** is a single always-on Node process that powers snapstack: it receives browser captures from
the [extension](https://github.com/bgaze/snapstack-extension), stacks them on disk, and serves them to any
MCP-capable LLM client over **Streamable HTTP**.

**Fully local**: it never listens on anything but `127.0.0.1`, no data ever leaves your machine.

> This is the **server** half of snapstack. It needs the companion browser extension to capture screens:
> **[snapstack-extension](https://github.com/bgaze/snapstack-extension)**.

## Architecture

A single always-on Node server serves both the extension (capture) and your MCP client, decoupled by a folder on disk.

```
[MV3 extension]  --POST /push (bytes)-->  ┐
                                          ▼
                            [snapstack server]   127.0.0.1:4123
                               ├─ writes ─►  ~/.snapstack/   (FIFO stack on disk)
                               └─ MCP /mcp (HTTP)  ◄── MCP client
```

- **Capture**: the extension encodes the capture as WebP (PNG fallback), downscales it if needed, and POSTs it here.
- **Stack**: one image file (`.webp`/`.png`) plus a twin `.json` (URL, title, timestamp) per capture, named to stay in
  chronological order under `~/.snapstack/`.
- **Retrieval**: the MCP tools read the stack, return the images to the LLM, then clear it.

## Requirements

- **Node.js ≥ 18** (tested on Node 20).
- An **MCP-capable LLM client** that supports the HTTP (Streamable HTTP) transport.
- The **[snapstack-extension](https://github.com/bgaze/snapstack-extension)** loaded in your browser.

## Installation

```bash
npm install
```

## Running the server

### Manually

```bash
npm start
# → snapstack server listening on http://127.0.0.1:4123
```

The server must be running for the extension to stack captures and for the MCP client to retrieve them.

### At login (recommended)

- **macOS (launchd)**:
  ```bash
  ./deploy/install-macos.sh
  ```
  Generates and loads a LaunchAgent (`~/Library/LaunchAgents/com.snapstack.server.plist`), starting at login with
  auto-restart. Logs: `/tmp/snapstack.out.log`, `/tmp/snapstack.err.log`.
  Uninstall:
  `launchctl unload ~/Library/LaunchAgents/com.snapstack.server.plist && rm ~/Library/LaunchAgents/com.snapstack.server.plist`

- **Linux (systemd `--user`)**: edit the paths in `deploy/snapstack.service`, then:
  ```bash
  cp deploy/snapstack.service ~/.config/systemd/user/
  systemctl --user daemon-reload
  systemctl --user enable --now snapstack.service
  ```

- **Windows**: create a "at logon" scheduled task running `node C:\path\to\snapstack\server\snapstack-server.js`.

## MCP client configuration

Register the running snapstack server as an **HTTP** MCP server in your client (the server must already be running).
Most MCP clients accept a project- or user-level config; copy `deploy/mcp.json` or adapt it to your client's format:

```json
{
  "mcpServers": {
    "snapstack": {
      "type": "http",
      "url": "http://127.0.0.1:4123/mcp"
    }
  }
}
```

> The exact config syntax varies per client — consult your MCP client's documentation for how to declare an HTTP MCP
> server.

### Exposed MCP tools

| Tool                | Description                                                                                                                    |
|---------------------|--------------------------------------------------------------------------------------------------------------------------------|
| `get_screenshots`   | Retrieves pending captures (chronological order) then clears the stack. Options: `keep` (don't clear), `limit` (the N oldest). |
| `clear_screenshots` | Clears the stack without retrieving anything.                                                                                  |
| `count_screenshots` | Number of pending captures, without retrieving them.                                                                           |

### Auto-approving the tools (optional)

Most MCP clients ask for confirmation before running a tool. To let snapstack's tools run without a prompt, add them to
your client's allow-list — the exact mechanism is client-specific.

For **Claude Code**, add the tool identifiers (`mcp__<server>__<tool>`) to `permissions.allow` in `settings.json`
(`~/.claude/settings.json` to cover every project):

```json
{
  "permissions": {
    "allow": [
      "mcp__snapstack__count_screenshots",
      "mcp__snapstack__get_screenshots",
      "mcp__snapstack__clear_screenshots"
    ]
  }
}
```

`mcp__snapstack` alone (no tool suffix) would allow all of the server's tools at once. Note that `get_screenshots`
(clears the stack after retrieval) and `clear_screenshots` (deletes everything) are **destructive** — this is the
intended workflow, but omit `clear_screenshots` from the list if you'd rather keep a confirmation on the full wipe.

## Configuration (environment variables)

| Variable         | Default        | Purpose                                 |
|------------------|----------------|-----------------------------------------|
| `SNAPSTACK_DIR`  | `~/.snapstack` | Stack folder.                           |
| `SNAPSTACK_PORT` | `4123`         | Listening port (always on `127.0.0.1`). |

> **Token cost**: some MCP clients cap a tool's output size, and images are large. For long stacks, use `limit` on
> `get_screenshots` (call it repeatedly to drain the stack in batches), and keep WebP + `maxEdge` to reduce weight.

## Troubleshooting

- **"Capture server not started"** (in the extension): start the server (`npm start`) or check the auto-start.
  Test: `curl http://127.0.0.1:4123/health`.
- **Port already in use** (`EADDRINUSE`): change `SNAPSTACK_PORT`.
- **The client doesn't see the tool**: the server must run **before** the MCP client starts; check your client's MCP
  config (`type: "http"`, correct URL). Direct test: `curl http://127.0.0.1:4123/count`.
- **Inspect the stack**: `ls ~/.snapstack` (image files + human-readable `.json`).

## License

MIT — see [LICENSE](./LICENSE).
