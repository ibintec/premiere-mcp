---
name: edit-premiere-project
description: Inspect, edit, verify, and export an open Adobe Premiere Pro project through the local Premiere MCP Bridge.
---

# Edit Premiere Project

Use the `premiere-pro` MCP server for Premiere operations. Start every session with `get_capabilities`, then call `verify_premiere_connection` before any mutation.

Inspect project and sequence state before editing. Ask before destructive actions or overwriting exports. Re-read the relevant sequence, clip, or project state after every mutation and never report a project change as complete without that readback.

If the connection check fails, install the companion package with `git clone https://github.com/ibintec/premiere-mcp.git && cd premiere-mcp && npm install && npm run build && npm install -g .`, run `premiere-pro-mcp --install-cep`, restart Premiere, and start `Window > Extensions > MCP Bridge (CEP)`.
