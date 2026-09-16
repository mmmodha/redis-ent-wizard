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
export interface ServerOptions {
  /**
   * Register upload_artifact, which reads a LOCAL file path and uploads it.
   * Only meaningful when the server shares a filesystem with the caller — i.e.
   * the local stdio transport. The hosted HTTP server leaves it off (a path
   * would resolve on the server, not the caller), so those callers use
   * url/gcs/git artifacts instead.
   */
  allowLocalUpload?: boolean;
}

export function createServer(client: RewClient, opts: ServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Define Redis Enterprise infrastructure on GCP for a human to review and apply. " +
        "Call list_capabilities first to learn the create-config shape and wiring rules. " +
        "To make a draft that is ready to apply, call list_credentials and pick one (prefer a " +
        "credential whose projectId matches the intent), then list_projects / list_regions to set " +
        "project, region_name, and region_zones. If no suitable credential exists, omit " +
        "credentialsFile/project/region — leave them for the human to choose in the wizard; do NOT " +
        "invent placeholder values. For application artifacts: use kind 'url', 'gcs', or 'git' for a " +
        "hosted file; for a LOCAL file call upload_artifact(path, type) when available and reference " +
        "the returned id as { kind: 'upload', ref: <id>, type }; otherwise leave it for the human. " +
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
    "list_credentials",
    {
      title: "List available GCP credentials",
      description:
        "List the GCP service-account credentials this tool can see (id, project, client email). Use the returned `file`/`id` as a design's credentialsFile, and its projectId as the project. Read-only.",
    },
    async () => guard(() => client.listCredentials()),
  );

  server.registerTool(
    "list_projects",
    {
      title: "List GCP projects for a credential",
      description:
        "List the GCP projects a credential can access. Read-only. Use to set a design's `project`.",
      inputSchema: { credentialsFile: z.string().describe("A credential id/file from list_credentials.") },
    },
    async ({ credentialsFile }) => guard(() => client.listProjects(credentialsFile)),
  );

  server.registerTool(
    "list_regions",
    {
      title: "List GCP regions for a project",
      description:
        "List regions (and their zone suffixes) available to a credential+project. Read-only. Use to set a design's `region_name` and `region_zones`.",
      inputSchema: {
        credentialsFile: z.string().describe("A credential id/file from list_credentials."),
        project: z.string().describe("A GCP project id."),
      },
    },
    async ({ credentialsFile, project }) => guard(() => client.listRegions(credentialsFile, project)),
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

  if (opts.allowLocalUpload) {
    server.registerTool(
      "upload_artifact",
      {
        title: "Upload a local application artifact",
        description:
          "Upload a LOCAL jar/binary file (by absolute path on this machine) to stage it for a design. Returns an artifact record whose `id` you set as an application's artifact: { kind: 'upload', ref: <id>, type }. The file is read by the local MCP server and sent to the API directly. For files not on this machine, use kind 'url'/'gcs'/'git' instead.",
        inputSchema: {
          path: z.string().describe("Absolute path to a local jar or binary file."),
          type: z.enum(["jar", "binary"]).describe("Artifact type."),
        },
      },
      async ({ path, type }) => guard(() => client.uploadArtifact(path, type)),
    );
  }

  server.registerTool(
    "update_design",
    {
      title: "Update a draft design",
      description:
        "Deep-patch an existing draft (by id) so a human and you can edit it in tandem. Send only the fields to change: objects merge recursively, and named arrays (clusters, databases, applications, …) merge by name — items and fields you omit are kept. Human-owned fields a person already set (per-cluster license, database passwords, per-cluster admin username) are always preserved and cannot be overwritten. Returns the updated record and its reviewUrl. Does NOT provision.",
      inputSchema: {
        id: z.string().describe("The draft design id (e.g. from save_design / list_designs)."),
        patch: z
          .object({})
          .passthrough()
          .describe("Partial create-config with just the fields to change; see list_capabilities."),
      },
    },
    async ({ id, patch }) => guard(() => client.updateDesign(id, patch)),
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
