import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RewClient } from "./client.js";
import { createServer } from "./server.js";

/**
 * Stand up a fake wizard API so the tools layer can be exercised end-to-end
 * (tool registration, argument passing, response + error mapping) without the
 * real API or any cloud. The fake records the last request for assertions.
 */
function fakeApi(): Promise<{ server: Server; url: string; calls: Array<{ method: string; path: string; body: unknown }> }> {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const server = createHttpServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push({ method: req.method || "", path: req.url || "", body });
      const reply = (status: number, obj: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.url === "/credentials") return reply(200, [{ id: "demo.json", file: "demo.json", projectId: "demo-proj", clientEmail: "sa@demo", valid: true }]);
      if (req.url?.startsWith("/gcp/projects")) return reply(200, [{ projectId: "demo-proj", name: "Demo" }]);
      if (req.url?.startsWith("/gcp/regions")) return reply(200, [{ name: "europe-west1", status: "UP", zones: [], zoneSuffixes: ["b", "c", "d"] }]);
      if (req.url === "/designs/schema") return reply(200, { jsonSchema: { type: "object" }, capabilities: { summary: "guide" } });
      if (req.url === "/designs/validate") return reply(200, { ok: true });
      if (req.url === "/designs/render") return reply(200, { mainTf: "module x", variablesTf: "variable y", tfvars: "z = 1" });
      if (req.url === "/designs" && req.method === "POST") return reply(201, { id: "demo-default", name: "demo", mode: "vm", status: "draft", reviewUrl: "http://web/edit?from=demo-default" });
      if (req.url === "/designs" && req.method === "GET") return reply(200, [{ id: "demo-default", status: "draft", reviewUrl: "http://web/edit?from=demo-default" }]);
      if (req.url?.startsWith("/designs/")) return reply(200, { id: "demo-default", status: "draft" });
      return reply(404, { error: "not found" });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, calls });
    });
  });
}

async function connectedClient(apiUrl: string, token = "tok") {
  const client = new Client({ name: "test", version: "1.0.0" });
  const mcp = createServer(new RewClient(apiUrl, token));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(b), client.connect(a)]);
  return client;
}

describe("MCP server tools", () => {
  let api: Awaited<ReturnType<typeof fakeApi>>;
  before(async () => {
    api = await fakeApi();
  });
  after(() => api.server.close());

  it("exposes only define/validate/render/read tools — no apply or destroy", async () => {
    const client = await connectedClient(api.url);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "get_design",
      "list_capabilities",
      "list_credentials",
      "list_designs",
      "list_projects",
      "list_regions",
      "render_design",
      "save_design",
      "validate_design",
    ]);
    for (const forbidden of ["apply", "create", "destroy", "retry", "recreate", "delete", "upload"]) {
      assert.ok(
        !names.some((n) => n.includes(forbidden)),
        `tool surface must not contain a "${forbidden}" tool`,
      );
    }
    await client.close();
  });

  it("save_design forwards the config and returns a reviewUrl", async () => {
    const client = await connectedClient(api.url);
    const res = await client.callTool({
      name: "save_design",
      arguments: { config: { name: "demo", mode: "vm", youremail: "jane", project: "p", credentialsFile: "k.json" } },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    assert.match(text, /reviewUrl/);
    assert.match(text, /edit\?from=demo-default/);
    const saved = api.calls.find((c) => c.path === "/designs" && c.method === "POST");
    assert.ok(saved, "expected a POST /designs");
    assert.equal((saved!.body as { name: string }).name, "demo");
    await client.close();
  });

  it("discovery tools reach the credential/project/region endpoints", async () => {
    const client = await connectedClient(api.url);
    const creds = await client.callTool({ name: "list_credentials", arguments: {} });
    assert.match((creds.content as Array<{ text: string }>)[0].text, /demo-proj/);
    const projects = await client.callTool({ name: "list_projects", arguments: { credentialsFile: "demo.json" } });
    assert.match((projects.content as Array<{ text: string }>)[0].text, /demo-proj/);
    const regions = await client.callTool({
      name: "list_regions",
      arguments: { credentialsFile: "demo.json", project: "demo-proj" },
    });
    assert.match((regions.content as Array<{ text: string }>)[0].text, /europe-west1/);
    await client.close();
  });

  it("list_capabilities returns the JSON schema and guide", async () => {
    const client = await connectedClient(api.url);
    const res = await client.callTool({ name: "list_capabilities", arguments: {} });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    assert.match(text, /jsonSchema/);
    assert.match(text, /guide/);
    await client.close();
  });

  it("maps an API error to an isError tool result", async () => {
    const client = await connectedClient("http://127.0.0.1:1"); // nothing listening
    const res = await client.callTool({ name: "list_designs", arguments: {} });
    assert.equal(res.isError, true);
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    assert.match(text, /Cannot reach the wizard API/);
    await client.close();
  });
});
