import Fastify from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import {
  getInstance,
  instanceDir,
  readLog,
  readRegistry,
  removeInstance,
  upsertInstance,
} from "./registry.js";
import {
  getMergedOutputs,
  isBusy,
  isWatching,
  startApply,
  startDestroy,
  watchBootstrap,
} from "./terraform.js";
import { probeHealth } from "./health.js";
import { writeInstanceWorkspace } from "./workspace.js";
import { computeProgress } from "./progress.js";
import { preflight } from "./preflight.js";
import {
  GcpApiError,
  listDnsZones,
  listMachineTypes,
  listProjects,
  listRegions,
} from "./gcp.js";
import { authHook, authDisabled, oidcConfig, requireUser } from "./auth.js";
import {
  assertAdmin,
  assertCanMutate,
  assertCanView,
  filterInstances,
  isAdmin,
} from "./authz.js";
import {
  deleteUserCredential,
  listUserCredentials,
  resolveOwnedCredentialsPath,
  uploadUserCredential,
} from "./credentials-store.js";
import { verifyCredentialFile, verifyCredentialJson } from "./credential-verify.js";
import { normalizeAppMachineTypes } from "./app-web.js";
import { audit, listAudit } from "./audit.js";
import { checkCreateQuota, getQuotaLimits, iamHint } from "./quotas.js";
import { queueStats } from "./jobs.js";
import { initDb, migrateFileRegistryIfNeeded } from "./db.js";
import type { CreateInstanceInput, InstanceRecord } from "./types.js";

const createSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[a-z][a-z0-9-]*$/, "name must be lowercase alphanumeric/hyphen"),
  mode: z.enum(["vm", "gke"]),
  youremail: z
    .string()
    .trim()
    .min(3, "owner email or name is required")
    .max(64)
    .optional(),
  project: z.string().min(1),
  credentialsFile: z.string().min(1),
  region_name: z.string().optional(),
  env: z.string().optional(),
  folder: z.string().max(60).optional(),
  clustersize: z.number().int().min(1).max(9).optional(),
  machine_type: z.string().optional(),
  RS_release: z.string().optional(),
  RS_admin: z.string().optional(),
  app: z.number().int().min(0).max(5).optional(),
  app_machine_types: z.array(z.string().min(1)).max(5).optional(),
  app_machine_type: z.string().optional(),
  memviz_enabled: z.boolean().optional(),
  memviz_port: z.number().optional(),
  app_expose_http: z.boolean().optional(),
  app_expose_https: z.boolean().optional(),
  rof_nvme_disks: z.number().int().min(0).max(24).optional(),
  gke_clustersize: z.number().int().min(1).max(10).optional(),
  gke_machine_type: z.string().optional(),
  rec_nodes: z.number().int().min(1).max(9).optional(),
  dns_managed_zone: z.string().optional(),
  dns_zone_dns_name: z.string().optional(),
  rs_private_subnet: z.string().optional(),
  rs_public_subnet: z.string().optional(),
  region_zones: z.array(z.string()).optional(),
});

const preflightSchema = createSchema.partial({ project: true }).extend({
  project: z.string().optional(),
});

function toId(name: string, env?: string): string {
  return `${name}-${env || "default"}`;
}

function operationStartedAt(inst: InstanceRecord): string | undefined {
  return inst.status === "destroying" || inst.status === "destroyed"
    ? inst.lastDestroyStartedAt
    : inst.lastApplyStartedAt;
}

async function decorate(inst: InstanceRecord) {
  const endpoints = await getMergedOutputs(inst.id);
  const progress = computeProgress(
    readLog(inst.id),
    inst.status,
    inst.mode,
    operationStartedAt(inst),
    inst.health,
  );
  return { ...inst, busy: isBusy(inst.id), endpoints, progress };
}

function gcpErrorReply(err: unknown): { status: number; body: { error: string; hint?: string } } {
  if (err instanceof GcpApiError) {
    const hint = iamHint(err.message);
    return {
      status: err.status >= 400 && err.status < 600 ? err.status : 502,
      body: { error: err.message, hint },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 400, body: { error: message, hint: iamHint(message) } };
}

function httpError(reply: import("fastify").FastifyReply, err: unknown) {
  const status = (err as { statusCode?: number }).statusCode || 400;
  return reply.code(status).send({ error: err instanceof Error ? err.message : String(err) });
}

await initDb();
await migrateFileRegistryIfNeeded();

const app = Fastify({ logger: true });
await app.register(cors, { origin: true, credentials: true });

app.addHook("preHandler", async (req, reply) => {
  await authHook(req, reply);
  if (reply.sent) return;
});

app.get("/health", async () => ({
  ok: true,
  authDisabled: authDisabled(),
  oidc: oidcConfig().enabled,
}));

app.get("/auth/config", async () => {
  const cfg = oidcConfig();
  return {
    authDisabled: authDisabled(),
    oidcEnabled: cfg.enabled,
    issuer: cfg.enabled ? cfg.issuer : undefined,
    clientId: cfg.enabled ? cfg.clientId : undefined,
  };
});

app.get("/auth/me", async (req) => {
  const user = requireUser(req);
  return { ...user, quotas: getQuotaLimits(), jobs: queueStats() };
});

app.get("/credentials", async (req) => listUserCredentials(requireUser(req)));

app.post<{ Body: { credentialsFile?: string; json?: string } }>("/credentials/verify", async (req, reply) => {
  const user = requireUser(req);
  const credentialsFile = String(req.body?.credentialsFile || "").trim();
  const json = String(req.body?.json || "");
  if (!credentialsFile && !json) {
    return reply.code(400).send({ error: "Provide credentialsFile or json to verify" });
  }
  try {
    if (json) {
      return await verifyCredentialJson(json);
    }
    const { absPath } = await resolveOwnedCredentialsPath(user, credentialsFile);
    return await verifyCredentialFile(absPath);
  } catch (err) {
    return httpError(reply, err);
  }
});

app.post<{ Body: { name?: string; json?: string } }>("/credentials", async (req, reply) => {
  const user = requireUser(req);
  const name = String(req.body?.name || "").trim();
  const json = String(req.body?.json || "");
  if (!json) return reply.code(400).send({ error: "json is required" });
  try {
    const created = await uploadUserCredential(user, name, json);
    await audit(user, "credentials.upload", "credential", created.id, created.clientEmail);
    return reply.code(201).send(created);
  } catch (err) {
    return httpError(reply, err);
  }
});

app.delete<{ Params: { id: string } }>("/credentials/:id", async (req, reply) => {
  const user = requireUser(req);
  try {
    await deleteUserCredential(user, req.params.id, isAdmin(user));
    await audit(user, "credentials.delete", "credential", req.params.id);
    return { ok: true };
  } catch (err) {
    return httpError(reply, err);
  }
});

async function withCredPath<T>(
  req: import("fastify").FastifyRequest,
  credentialsFile: string,
  fn: (abs: string) => Promise<T>,
): Promise<T> {
  const user = requireUser(req);
  const { absPath } = await resolveOwnedCredentialsPath(user, credentialsFile);
  return fn(absPath);
}

app.get<{ Querystring: { credentialsFile?: string } }>("/gcp/projects", async (req, reply) => {
  const { credentialsFile } = req.query;
  if (!credentialsFile) return reply.code(400).send({ error: "credentialsFile is required" });
  try {
    return await withCredPath(req, credentialsFile, (abs) => listProjects(abs));
  } catch (err) {
    const { status, body } = gcpErrorReply(err);
    return reply.code(status).send(body);
  }
});

app.get<{ Querystring: { credentialsFile?: string; project?: string } }>(
  "/gcp/regions",
  async (req, reply) => {
    const { credentialsFile, project } = req.query;
    if (!credentialsFile || !project) {
      return reply.code(400).send({ error: "credentialsFile and project are required" });
    }
    try {
      return await withCredPath(req, credentialsFile, (abs) => listRegions(abs, project));
    } catch (err) {
      const { status, body } = gcpErrorReply(err);
      return reply.code(status).send(body);
    }
  },
);

app.get<{ Querystring: { credentialsFile?: string; project?: string; zone?: string } }>(
  "/gcp/machine-types",
  async (req, reply) => {
    const { credentialsFile, project, zone } = req.query;
    if (!credentialsFile || !project || !zone) {
      return reply.code(400).send({ error: "credentialsFile, project and zone are required" });
    }
    try {
      return await withCredPath(req, credentialsFile, (abs) => listMachineTypes(abs, project, zone));
    } catch (err) {
      const { status, body } = gcpErrorReply(err);
      return reply.code(status).send(body);
    }
  },
);

app.get<{ Querystring: { credentialsFile?: string; project?: string } }>(
  "/gcp/dns-zones",
  async (req, reply) => {
    const { credentialsFile, project } = req.query;
    if (!credentialsFile || !project) {
      return reply.code(400).send({ error: "credentialsFile and project are required" });
    }
    try {
      return await withCredPath(req, credentialsFile, (abs) => listDnsZones(abs, project));
    } catch (err) {
      const { status, body } = gcpErrorReply(err);
      return reply.code(status).send(body);
    }
  },
);

app.post("/preflight", async (req, reply) => {
  const user = requireUser(req);
  const parsed = preflightSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  try {
    const input = { ...parsed.data } as CreateInstanceInput;
    if (!input.youremail) input.youremail = user.email;
    const { absPath } = await resolveOwnedCredentialsPath(user, input.credentialsFile);
    input.credentialsFile = absPath;
    return await preflight(input);
  } catch (err) {
    const { status, body } = gcpErrorReply(err);
    return reply.code(status).send(body);
  }
});

app.get<{ Querystring: { folder?: string; owner?: string; status?: string } }>(
  "/instances",
  async (req) => {
    const user = requireUser(req);
    const { folder, owner, status } = req.query;
    const list = filterInstances(user, await readRegistry())
      .filter((i) => (folder === undefined ? true : (i.folder || "") === folder))
      .filter((i) => (owner === undefined ? true : i.ownerEmail === owner))
      .filter((i) => (status === undefined ? true : i.status === status));
    return Promise.all(list.map(decorate));
  },
);

app.get<{ Params: { id: string } }>("/instances/:id", async (req, reply) => {
  const user = requireUser(req);
  const inst = await getInstance(req.params.id);
  if (!inst) return reply.code(404).send({ error: "not found" });
  try {
    assertCanView(user, inst);
  } catch (err) {
    return httpError(reply, err);
  }
  return decorate(inst);
});

app.get<{ Params: { id: string } }>("/instances/:id/outputs", async (req, reply) => {
  const user = requireUser(req);
  const inst = await getInstance(req.params.id);
  if (!inst) return reply.code(404).send({ error: "not found" });
  try {
    assertCanView(user, inst);
  } catch (err) {
    return httpError(reply, err);
  }
  await audit(user, "instance.view_outputs", "instance", inst.id);
  return getMergedOutputs(inst.id);
});

app.get<{ Params: { id: string } }>("/instances/:id/progress", async (req, reply) => {
  const user = requireUser(req);
  const inst = await getInstance(req.params.id);
  if (!inst) return reply.code(404).send({ error: "not found" });
  try {
    assertCanView(user, inst);
  } catch (err) {
    return httpError(reply, err);
  }
  return computeProgress(
    readLog(inst.id),
    inst.status,
    inst.mode,
    operationStartedAt(inst),
    inst.health,
  );
});

app.post<{ Params: { id: string } }>("/instances/:id/health", async (req, reply) => {
  const user = requireUser(req);
  const inst = await getInstance(req.params.id);
  if (!inst) return reply.code(404).send({ error: "not found" });
  try {
    assertCanView(user, inst);
  } catch (err) {
    return httpError(reply, err);
  }
  if (inst.status === "destroyed" || inst.status === "destroying") {
    return reply.code(409).send({ error: `instance is ${inst.status}` });
  }

  const health = await probeHealth(inst);
  const current = await getInstance(inst.id);
  if (!current) return reply.code(404).send({ error: "not found" });

  const status =
    health.state === "ready"
      ? "ready"
      : current.status === "ready" || current.status === "degraded"
        ? "bootstrapping"
        : current.status;
  await upsertInstance({ ...current, health, status, updatedAt: new Date().toISOString() });
  if (status === "bootstrapping") watchBootstrap(inst.id);
  return health;
});

app.get<{ Params: { id: string }; Querystring: { access_token?: string } }>(
  "/instances/:id/logs",
  async (req, reply) => {
  const user = requireUser(req);
  const inst = await getInstance(req.params.id);
  if (!inst) return reply.code(404).send({ error: "not found" });
  try {
    assertCanView(user, inst);
  } catch (err) {
    return httpError(reply, err);
  }

  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": req.headers.origin || "*",
    "Access-Control-Allow-Credentials": "true",
  });

  let offset = 0;
  const send = async () => {
    const full = readLog(inst.id);
    if (full.length > offset) {
      const chunk = full.slice(offset);
      offset = full.length;
      reply.raw.write(`data: ${JSON.stringify({ chunk })}\n\n`);
    }
    const current = await getInstance(inst.id);
    reply.raw.write(
      `data: ${JSON.stringify({
        status: current?.status,
        busy: isBusy(inst.id),
        progress: current
          ? computeProgress(
              full,
              current.status,
              current.mode,
              operationStartedAt(current),
              current.health,
            )
          : undefined,
      })}\n\n`,
    );
  };

  void send();
  const timer = setInterval(() => void send(), 1000);
  req.raw.on("close", () => {
    clearInterval(timer);
    reply.raw.end();
  });
});

app.post("/instances", async (req, reply) => {
  const user = requireUser(req);
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }

  const input = parsed.data as CreateInstanceInput;
  input.youremail = user.email || input.youremail || user.name;
  const id = toId(input.name, input.env);
  if (await getInstance(id)) {
    return reply.code(409).send({ error: `Instance ${id} already exists` });
  }

  const quota = await checkCreateQuota(user, input);
  if (!quota.ok) {
    return reply.code(422).send({ error: "Quota exceeded", details: quota.errors });
  }

  let credentialsAbs: string;
  let credentialsId: string | undefined;
  try {
    const resolved = await resolveOwnedCredentialsPath(user, input.credentialsFile);
    credentialsAbs = resolved.absPath;
    credentialsId = resolved.credentialsId;
  } catch (err) {
    return httpError(reply, err);
  }

  const skipPreflight = (req.query as { force?: string } | undefined)?.force === "true";
  if (!skipPreflight) {
    try {
      const result = await preflight({ ...input, credentialsFile: credentialsAbs });
      if (!result.ok) {
        return reply.code(422).send({
          error: "Preflight checks failed",
          checks: result.checks.filter((c) => c.level === "fail"),
        });
      }
    } catch (err) {
      return reply.code(400).send({
        error: `Preflight could not run: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  if (input.mode === "vm") {
    const app = input.app ?? 0;
    input.app_machine_types = normalizeAppMachineTypes({
      app,
      app_machine_types: input.app_machine_types,
      app_machine_type: input.app_machine_type,
    });
    if (app === 0) {
      input.app_machine_type = undefined;
      input.memviz_enabled = false;
      input.app_expose_http = false;
      input.app_expose_https = false;
    }
  }

  const workDir = instanceDir(id);
  try {
    writeInstanceWorkspace(workDir, input.mode, input, credentialsAbs);
  } catch (err) {
    return reply.code(400).send({
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const now = new Date().toISOString();
  const record: InstanceRecord = {
    id,
    name: input.name,
    mode: input.mode,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    project: input.project,
    region: input.region_name || "europe-west1",
    ownerEmail: input.youremail,
    ownerSub: user.sub,
    credentialsFile: credentialsAbs,
    credentialsId,
    config: input as unknown as Record<string, unknown>,
    endpoints: {},
    folder: input.folder?.trim() || undefined,
  };
  await upsertInstance(record);
  await audit(user, "instance.create", "instance", id, `${input.mode} ${input.project}`);
  await startApply(id, user.sub);
  return reply.code(201).send(record);
});

app.delete<{ Params: { id: string } }>("/instances/:id", async (req, reply) => {
  const user = requireUser(req);
  const inst = await getInstance(req.params.id);
  if (!inst) return reply.code(404).send({ error: "not found" });
  try {
    assertCanMutate(user, inst);
  } catch (err) {
    return httpError(reply, err);
  }
  if (isBusy(inst.id)) return reply.code(409).send({ error: "instance is busy" });
  await audit(user, "instance.destroy", "instance", inst.id);
  await startDestroy(inst.id, false, user.sub);
  return { ok: true, id: inst.id, status: "destroying" };
});

app.post<{ Body: { ids?: string[] } }>("/instances/bulk-destroy", async (req, reply) => {
  const user = requireUser(req);
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return reply.code(400).send({ error: "ids is required" });

  const started: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const id of ids) {
    const inst = await getInstance(id);
    if (!inst) {
      skipped.push({ id, reason: "not found" });
      continue;
    }
    if (!filterInstances(user, [inst]).length) {
      skipped.push({ id, reason: "forbidden" });
      continue;
    }
    if (isBusy(id)) {
      skipped.push({ id, reason: "busy" });
      continue;
    }
    if (inst.status === "destroyed") {
      skipped.push({ id, reason: "already destroyed" });
      continue;
    }
    await startDestroy(id, false, user.sub);
    started.push(id);
  }
  await audit(user, "instance.bulk_destroy", "instance", started.join(","));
  return { ok: true, started, skipped };
});

app.post<{ Params: { id: string } }>("/instances/:id/forget", async (req, reply) => {
  const user = requireUser(req);
  const inst = await getInstance(req.params.id);
  if (!inst) return reply.code(404).send({ error: "not found" });
  try {
    assertCanMutate(user, inst);
  } catch (err) {
    return httpError(reply, err);
  }
  if (isBusy(inst.id)) return reply.code(409).send({ error: "instance is busy" });
  if (inst.status !== "destroyed" && inst.status !== "failed") {
    return reply.code(409).send({
      error: `Refusing to forget an instance in status "${inst.status}" — destroy it first`,
    });
  }
  await removeInstance(inst.id);
  await audit(user, "instance.forget", "instance", inst.id);
  return { ok: true, id: inst.id };
});

app.patch<{ Params: { id: string }; Body: { folder?: string | null } }>(
  "/instances/:id",
  async (req, reply) => {
    const user = requireUser(req);
    const inst = await getInstance(req.params.id);
    if (!inst) return reply.code(404).send({ error: "not found" });
    try {
      assertCanMutate(user, inst);
    } catch (err) {
      return httpError(reply, err);
    }
    const raw = req.body?.folder;
    if (raw === undefined) return reply.code(400).send({ error: "folder is required" });
    const folder = raw === null ? undefined : String(raw).trim().slice(0, 60) || undefined;
    await upsertInstance({ ...inst, folder, updatedAt: new Date().toISOString() });
    return { ok: true, id: inst.id, folder: folder ?? null };
  },
);

app.get("/folders", async (req) => {
  const user = requireUser(req);
  const counts = new Map<string, number>();
  for (const inst of filterInstances(user, await readRegistry())) {
    const key = inst.folder?.trim() || "";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([folder, count]) => ({ folder, count }))
    .sort((a, b) => a.folder.localeCompare(b.folder));
});

app.get("/owners", async (req) => {
  const user = requireUser(req);
  const counts = new Map<string, number>();
  for (const inst of filterInstances(user, await readRegistry())) {
    const key = inst.ownerEmail?.trim() || "";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([owner, count]) => ({ owner, count }))
    .sort((a, b) => a.owner.localeCompare(b.owner));
});

app.post<{ Params: { id: string } }>("/instances/:id/retry", async (req, reply) => {
  const user = requireUser(req);
  const inst = await getInstance(req.params.id);
  if (!inst) return reply.code(404).send({ error: "not found" });
  try {
    assertCanMutate(user, inst);
  } catch (err) {
    return httpError(reply, err);
  }
  if (isBusy(inst.id)) return reply.code(409).send({ error: "instance is busy" });

  try {
    const config = inst.config as unknown as CreateInstanceInput;
    if (config?.name && config?.mode) {
      const { absPath } = await resolveOwnedCredentialsPath(
        user,
        inst.credentialsId || inst.credentialsFile,
      );
      writeInstanceWorkspace(instanceDir(inst.id), inst.mode, config, absPath);
    }
  } catch (err) {
    return reply.code(400).send({
      error: `Could not regenerate workspace: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  await audit(user, "instance.retry", "instance", inst.id);
  await startApply(inst.id, user.sub);
  return { ok: true, id: inst.id, status: "applying" };
});

app.get("/admin/audit", async (req, reply) => {
  const user = requireUser(req);
  try {
    assertAdmin(user);
  } catch (err) {
    return httpError(reply, err);
  }
  return listAudit(200);
});

app.get("/admin/jobs", async (req, reply) => {
  const user = requireUser(req);
  try {
    assertAdmin(user);
  } catch (err) {
    return httpError(reply, err);
  }
  return queueStats();
});

for (const inst of await readRegistry()) {
  if (inst.status === "bootstrapping" && !isWatching(inst.id)) watchBootstrap(inst.id);
}

const port = Number(process.env.PORT || 4000);
const host = process.env.HOST || "0.0.0.0";

try {
  await app.listen({ port, host });
  console.log(`API listening on http://${host}:${port} (authDisabled=${authDisabled()})`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
