import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiError, RewClient } from "./client.js";

export const SERVER_NAME = "redis-ent-wizard";
export const SERVER_VERSION = "1.0.0";

/**
 * A create-config: the design payload the wizard understands. The authoritative
 * schema lives in the API (`createSchema`) and is surfaced by `list_capabilities`
 * as JSON Schema. We accept any object here and let the API validate — the tool
 * descriptions point the model at `list_capabilities` for the exact shape, and
 * `validate_design` gives a fast round-trip to check a draft before saving.
 */
const configShape = { config: z.object({}).passthrough().describe("A create-config object; see list_capabilities for the schema.") };

function textResult(value: unknown, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text }], isError };
}

/** Run an API call and map any ApiError to a readable tool error result. */
async function guard(fn: () => Promise<unknown>) {
  try {
    return textResult(await fn());
  } catch (err) {
    if (err instanceof ApiError) return textResult(`Error: ${err.message}`, true);
    return textResult(`Error: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

/**
 * Build an MCP server exposing ONLY define/validate/render/read tools. There is
 * deliberately no apply/create/destroy/retry/recreate tool: this surface can
 * define infrastructure for human review, never provision it. The `client`'s
 * token is also define-scoped, so the API refuses provisioning regardless.
 */
export function createServer(client: RewClient): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Define Redis Enterprise infrastructure on GCP for a human to review and apply. " +
        "Call list_capabilities first to learn the create-config shape and wiring rules. " +
        "Use validate_design / render_design to check a design, then save_design to persist a " +
        "draft and get a reviewUrl. This tool cannot provision or destroy anything.",
    },
  );

  server.registerTool(
    "list_capabilities",
    {
      title: "List capabilities",
      description:
        "Return the create-config JSON Schema and an authored guide to component kinds (clusters, databases, applications, Cloud SQL, Pub/Sub, BigQuery, storage, RDI), modes (vm/gke), and wiring rules. Call this before defining a design.",
    },
    async () => guard(() => client.getCapabilities()),
  );

  server.registerTool(
    "validate_design",
    {
      title: "Validate a design",
      description:
        "Schema-validate a create-config offline (no cloud credentials). Returns { ok: true } or the validation errors. Use before save_design.",
      inputSchema: configShape,
    },
    async ({ config }) => guard(() => client.validate(config)),
  );

  server.registerTool(
    "render_design",
    {
      title: "Render Terraform for a design",
      description:
        "Return the Terraform (main.tf, variables.tf, terraform.tfvars) a create-config would generate, without applying anything. Useful to preview what a design provisions.",
      inputSchema: configShape,
    },
    async ({ config }) => guard(() => client.render(config)),
  );

  server.registerTool(
    "save_design",
    {
      title: "Save a design as a draft",
      description:
        "Persist a create-config as a DRAFT instance for a human to review and apply. Returns the record and a reviewUrl that opens it in the wizard. Does NOT provision any cloud resources.",
      inputSchema: configShape,
    },
    async ({ config }) => guard(() => client.saveDesign(config)),
  );

  server.registerTool(
    "list_designs",
    {
      title: "List draft designs",
      description: "List the draft designs visible to this token, each with its reviewUrl.",
    },
    async () => guard(() => client.listDesigns()),
  );

  server.registerTool(
    "get_design",
    {
      title: "Get a draft design",
      description: "Fetch a single draft design by id, with its reviewUrl.",
      inputSchema: { id: z.string().describe("The draft design id.") },
    },
    async ({ id }) => guard(() => client.getDesign(id)),
  );

  return server;
}
