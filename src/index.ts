#!/usr/bin/env node
import { startServer } from "./server.js";

startServer().catch((err) => {
  // Log to stderr so it is visible in the MCP client's server log pane.
  // stdout is reserved for the JSON-RPC transport.
  // eslint-disable-next-line no-console
  console.error("audio-mcp fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
