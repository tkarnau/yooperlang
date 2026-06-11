# Yooperlang reference MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives
MCP-aware assistants (Claude Desktop, Cursor, and friends) access to the
Yooperlang language reference, so they can read and search the spec while
helping you write Yooperlang.

It is intentionally dependency-free - MCP is JSON-RPC 2.0 over stdio, and this
server speaks it directly. There is nothing to install. You only need Node 18+.

## What it exposes

Resources (read directly from the repo, so they never drift from source):

- `yoop://spec` - the full language specification (SPEC.md)
- `yoop://std/<path>` - every standard-library module, e.g.
  `yoop://std/core/vec.yoop`

Tools:

- `search_reference(query)` - section-aware search over SPEC.md. Returns the
  matching sections (headings and body). Good for "how do traits work", "kind
  syntax", "generic bounds", and so on.

## Use it from an MCP client

Add an entry to your client's MCP server config. The command is just Node
running `server.js` with an absolute path to wherever you cloned the repo.

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "yooperlang": {
      "command": "node",
      "args": ["/absolute/path/to/yooperlang/tools/mcp-reference/server.js"]
    }
  }
}
```

Cursor and most other MCP clients use the same `command` / `args` shape.

## Try it without a client

The MCP Inspector launches an interactive UI against any stdio server:

```bash
npx @modelcontextprotocol/inspector node tools/mcp-reference/server.js
```

Or drive it by hand - it reads newline-delimited JSON-RPC on stdin:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_reference","arguments":{"query":"generic bound"}}}' \
  | node tools/mcp-reference/server.js
```
