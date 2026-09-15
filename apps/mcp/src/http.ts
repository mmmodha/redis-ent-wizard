#!/usr/bin/env node
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { RewClient } from "./client.js";
import { createServer } from "./server.js";
import { loadConfig } from "./config.js";

/**
 * Hosted Streamable HTTP transport. Stateless: each POST spins up a fresh
 * server + transport, handles the request, and tears down. The caller's own
 * bearer token is forwarded to the API, so actions are attributed to a real
 * define-scoped principal (least privilege — no shared admin secret here).
 */
const cfg = loadConfig();
const MCP_PATH = "/mcp";

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length).trim();
  }
  return undefined;
}

function send(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

async function handleMcp(req: IncomingMessage, res: ServerResponse) {
  // Require a caller token: the MCP forwards it to the API, which enforces the
  // define scope. Without one, provisioning couldn't be blocked per-principal.
  const token = bearer(req);
  if (!token) {
    return send(res, 401, {
      jsonrpc: "2.0",
      error: { code: -32001, message: "Authorization: Bearer <define-token> required" },
      id: null,
    });
  }

  const client = new RewClient(cfg.apiUrl, token);
  const server = createServer(client);
  // Stateless: no session id, one exchange per request.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

const httpServer = createHttpServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/health") return send(res, 200, { ok: true });
  if (url.pathname === MCP_PATH) {
    handleMcp(req, res).catch((err) => {
      console.error("[rew-mcp] request error:", err);
      if (!res.headersSent) {
        send(res, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: err instanceof Error ? err.message : "Internal error" },
          id: null,
        });
      }
    });
    return;
  }
  send(res, 404, { error: "Not found" });
});

httpServer.listen(cfg.httpPort, cfg.httpHost, () => {
  console.error(
    `[rew-mcp] HTTP server ready at http://${cfg.httpHost}:${cfg.httpPort}${MCP_PATH} (api=${cfg.apiUrl})`,
  );
});
