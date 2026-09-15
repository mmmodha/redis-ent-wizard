import type { FastifyInstance } from "fastify";
import { zodToJsonSchema } from "zod-to-json-schema";
import { createSchema } from "./schema.js";
import { CAPABILITIES_GUIDE } from "./capabilities.js";
import { renderTerraform } from "./workspace.js";
import { getInstance, readRegistry, upsertInstance } from "./registry.js";
import { requireUser } from "./auth.js";
import { canViewInstance } from "./authz.js";
import { resolveCreatedBy, CREATED_BY_ERROR } from "./created-by.js";
import { audit } from "./audit.js";
import type { CreateInstanceInput, InstanceRecord } from "./types.js";

function designId(name: string, env?: string): string {
  return `${name}-${env || "default"}`;
}

function reviewUrl(id: string): string {
  const base = (process.env.REW_WEB_URL || "http://localhost:3000").replace(/\/$/, "");
  return `${base}/edit?from=${encodeURIComponent(id)}`;
}

/**
 * Define-only routes. These validate, render, and persist a create-config as a
 * `draft` instance for a human to review and apply — they NEVER call startApply
 * or touch cloud state. The MCP server is the primary caller.
 */
// Derived once: the create-config as JSON Schema, for MCP tool input schemas
// and client-side validation. createSchema is the single source of truth.
const createJsonSchema = zodToJsonSchema(createSchema, {
  name: "CreateInstanceInput",
  $refStrategy: "none",
});

export function registerDesignRoutes(app: FastifyInstance) {
  // The create-config JSON Schema + an authored guide to the component kinds
  // and wiring rules. The MCP server fetches this to teach the model the shape
  // of what it can define. Offline, no credentials.
  app.get("/designs/schema", async (_req, reply) => {
    return reply.send({ jsonSchema: createJsonSchema, capabilities: CAPABILITIES_GUIDE });
  });

  // Offline schema validation (no credentials, no GCP).
  app.post("/designs/validate", async (req, reply) => {
    requireUser(req);
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.send({ ok: false, errors: parsed.error.flatten() });
    }
    return reply.send({ ok: true });
  });

  // Render the Terraform a config would produce, without applying.
  app.post("/designs/render", async (req, reply) => {
    requireUser(req);
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const input = parsed.data as CreateInstanceInput;
    try {
      const { mainTf, variablesTf, tfvars } = renderTerraform(input.mode, input);
      return reply.send({ mainTf, variablesTf, tfvars });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Persist a config as a draft for human review. No provisioning.
  app.post("/designs", async (req, reply) => {
    const user = requireUser(req);
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const input = parsed.data as CreateInstanceInput;
    const createdBy = resolveCreatedBy(input.youremail, user);
    if (!createdBy) return reply.code(400).send({ error: CREATED_BY_ERROR });
    input.youremail = createdBy;

    const id = designId(input.name, input.env);
    const existing = await getInstance(id);
    // Only overwrite our own not-yet-live records; never clobber live infra.
    if (existing && existing.status !== "draft" && existing.status !== "destroyed") {
      return reply.code(409).send({ error: `Instance ${id} already exists and is not a draft` });
    }

    const now = new Date().toISOString();
    const record: InstanceRecord = {
      id,
      name: input.name,
      mode: input.mode,
      status: "draft",
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      project: input.project,
      region: input.region_name || "europe-west1",
      ownerEmail: input.youremail,
      ownerSub: user.sub,
      credentialsFile: input.credentialsFile,
      config: input as unknown as Record<string, unknown>,
      endpoints: {},
      folder: input.folder?.trim() || undefined,
    };
    await upsertInstance(record);
    await audit(user, "design.save", "instance", id, `draft ${input.mode} ${input.project}`);
    return reply.code(201).send({ ...record, reviewUrl: reviewUrl(id) });
  });

  // List the caller's drafts.
  app.get("/designs", async (req, reply) => {
    const user = requireUser(req);
    const drafts = (await readRegistry())
      .filter((r) => r.status === "draft")
      .filter((r) => canViewInstance(user, r));
    return reply.send(drafts.map((r) => ({ ...r, reviewUrl: reviewUrl(r.id) })));
  });

  app.get<{ Params: { id: string } }>("/designs/:id", async (req, reply) => {
    const user = requireUser(req);
    const record = await getInstance(req.params.id);
    if (!record || record.status !== "draft" || !canViewInstance(user, record)) {
      return reply.code(404).send({ error: "Draft not found" });
    }
    return reply.send({ ...record, reviewUrl: reviewUrl(record.id) });
  });
}
