#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RewClient } from "./client.js";
import { createServer } from "./server.js";
import { loadConfig } from "./config.js";

/**
 * Local stdio transport: one server bound to a single configured define token.
 * This is what Claude Desktop / Claude Code / Cursor launch per developer.
 * Note: never write to stdout here — it is the JSON-RPC channel; logs go to
 * stderr.
 */
async function main() {
  const cfg = loadConfig();
  if (!cfg.apiToken) {
    console.error(
      "[rew-mcp] warning: REW_API_TOKEN is not set; calls will be unauthenticated and rejected unless the API runs with AUTH_DISABLED.",
    );
  }
  const client = new RewClient(cfg.apiUrl, cfg.apiToken);
  // Local transport shares the filesystem with the caller, so local file
  // uploads are meaningful here (they are not on the hosted HTTP server).
  const server = createServer(client, { allowLocalUpload: true });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[rew-mcp] stdio server ready (api=${cfg.apiUrl})`);
}

main().catch((err) => {
  console.error("[rew-mcp] fatal:", err);
  process.exit(1);
});
