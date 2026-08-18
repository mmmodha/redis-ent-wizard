import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import type { ClusterHealth, InstanceRecord, InstanceStatus } from "./types.js";

const { Pool } = pg;

export type CredentialRow = {
  id: string;
  ownerSub: string;
  ownerEmail: string;
  name: string;
  clientEmail: string;
  projectId: string;
  createdAt: string;
  updatedAt: string;
};

export type AuditEvent = {
  id: string;
  at: string;
  actorSub: string;
  actorEmail: string;
  action: string;
  targetType: string;
  targetId: string;
  detail?: string;
};

let pool: pg.Pool | undefined;
let usePostgres = false;

function dataDir(): string {
  const dir = process.env.DATA_DIR || path.resolve(process.cwd(), "../../data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fileDbPath(name: string): string {
  return path.join(dataDir(), name);
}

export function dbEnabled(): boolean {
  return usePostgres;
}

export async function initDb(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    usePostgres = false;
    // Ensure file-backed stores exist for the JSON fallback.
    for (const f of ["instances.json", "credentials-meta.json", "audit.json", "quota-overrides.json"]) {
      const p = fileDbPath(f);
      if (!fs.existsSync(p)) {
        fs.writeFileSync(p, f === "instances.json" || f.endsWith(".json") ? (f.startsWith("quota") ? "{}\n" : "[]\n") : "[]\n", "utf8");
      }
    }
    console.log("DATABASE_URL not set — using file-backed registry under DATA_DIR");
    return;
  }

  pool = new Pool({ connectionString: url });
  usePostgres = true;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS instances (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      project TEXT NOT NULL,
      region TEXT NOT NULL,
      owner_email TEXT NOT NULL,
      owner_sub TEXT,
      credentials_file TEXT NOT NULL,
      credentials_id TEXT,
      folder TEXT,
      config JSONB NOT NULL DEFAULT '{}',
      endpoints JSONB NOT NULL DEFAULT '{}',
      health JSONB,
      last_error TEXT,
      last_apply_started_at TIMESTAMPTZ,
      last_destroy_started_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS credentials (
      id TEXT PRIMARY KEY,
      owner_sub TEXT NOT NULL,
      owner_email TEXT NOT NULL,
      name TEXT NOT NULL,
      client_email TEXT NOT NULL,
      project_id TEXT NOT NULL DEFAULT '',
      enc_blob TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL,
      actor_sub TEXT NOT NULL,
      actor_email TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      detail TEXT
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      owner_sub TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_instances_owner ON instances(owner_sub);
    CREATE INDEX IF NOT EXISTS idx_credentials_owner ON credentials(owner_sub);
    CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_events(at DESC);
  `);
  console.log("Connected to Postgres and ensured schema");
}

function rowToInstance(r: pg.QueryResultRow): InstanceRecord {
  return {
    id: r.id,
    name: r.name,
    mode: r.mode,
    status: r.status as InstanceStatus,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    project: r.project,
    region: r.region,
    ownerEmail: r.owner_email,
    ownerSub: r.owner_sub || undefined,
    credentialsFile: r.credentials_file,
    credentialsId: r.credentials_id || undefined,
    folder: r.folder || undefined,
    config: r.config || {},
    endpoints: r.endpoints || {},
    health: (r.health as ClusterHealth) || undefined,
    lastError: r.last_error || undefined,
    lastApplyStartedAt: r.last_apply_started_at
      ? new Date(r.last_apply_started_at).toISOString()
      : undefined,
    lastDestroyStartedAt: r.last_destroy_started_at
      ? new Date(r.last_destroy_started_at).toISOString()
      : undefined,
  };
}

export async function dbReadInstances(): Promise<InstanceRecord[]> {
  if (!usePostgres || !pool) {
    const raw = fs.readFileSync(fileDbPath("instances.json"), "utf8");
    try {
      return JSON.parse(raw) as InstanceRecord[];
    } catch {
      return [];
    }
  }
  const res = await pool.query(`SELECT * FROM instances ORDER BY created_at DESC`);
  return res.rows.map(rowToInstance);
}

export async function dbGetInstance(id: string): Promise<InstanceRecord | undefined> {
  if (!usePostgres || !pool) {
    return (await dbReadInstances()).find((i) => i.id === id);
  }
  const res = await pool.query(`SELECT * FROM instances WHERE id = $1`, [id]);
  return res.rows[0] ? rowToInstance(res.rows[0]) : undefined;
}

export async function dbUpsertInstance(record: InstanceRecord): Promise<InstanceRecord> {
  if (!usePostgres || !pool) {
    const all = await dbReadInstances();
    const idx = all.findIndex((i) => i.id === record.id);
    if (idx >= 0) all[idx] = record;
    else all.push(record);
    fs.writeFileSync(fileDbPath("instances.json"), JSON.stringify(all, null, 2) + "\n", "utf8");
    return record;
  }
  await pool.query(
    `INSERT INTO instances (
      id, name, mode, status, created_at, updated_at, project, region,
      owner_email, owner_sub, credentials_file, credentials_id, folder,
      config, endpoints, health, last_error, last_apply_started_at, last_destroy_started_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
    )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      mode = EXCLUDED.mode,
      status = EXCLUDED.status,
      updated_at = EXCLUDED.updated_at,
      project = EXCLUDED.project,
      region = EXCLUDED.region,
      owner_email = EXCLUDED.owner_email,
      owner_sub = EXCLUDED.owner_sub,
      credentials_file = EXCLUDED.credentials_file,
      credentials_id = EXCLUDED.credentials_id,
      folder = EXCLUDED.folder,
      config = EXCLUDED.config,
      endpoints = EXCLUDED.endpoints,
      health = EXCLUDED.health,
      last_error = EXCLUDED.last_error,
      last_apply_started_at = EXCLUDED.last_apply_started_at,
      last_destroy_started_at = EXCLUDED.last_destroy_started_at
    `,
    [
      record.id,
      record.name,
      record.mode,
      record.status,
      record.createdAt,
      record.updatedAt,
      record.project,
      record.region,
      record.ownerEmail,
      record.ownerSub || null,
      record.credentialsFile,
      record.credentialsId || null,
      record.folder || null,
      JSON.stringify(record.config || {}),
      JSON.stringify(record.endpoints || {}),
      record.health ? JSON.stringify(record.health) : null,
      record.lastError || null,
      record.lastApplyStartedAt || null,
      record.lastDestroyStartedAt || null,
    ],
  );
  return record;
}

export async function dbRemoveInstance(id: string): Promise<void> {
  if (!usePostgres || !pool) {
    const all = (await dbReadInstances()).filter((i) => i.id !== id);
    fs.writeFileSync(fileDbPath("instances.json"), JSON.stringify(all, null, 2) + "\n", "utf8");
    return;
  }
  await pool.query(`DELETE FROM instances WHERE id = $1`, [id]);
}

export async function dbListCredentialsMeta(ownerSub?: string): Promise<CredentialRow[]> {
  if (!usePostgres || !pool) {
    const raw = fs.readFileSync(fileDbPath("credentials-meta.json"), "utf8");
    let all: CredentialRow[] = [];
    try {
      all = JSON.parse(raw) as CredentialRow[];
    } catch {
      all = [];
    }
    return ownerSub ? all.filter((c) => c.ownerSub === ownerSub) : all;
  }
  const res = ownerSub
    ? await pool.query(`SELECT id, owner_sub, owner_email, name, client_email, project_id, created_at, updated_at FROM credentials WHERE owner_sub = $1 ORDER BY name`, [ownerSub])
    : await pool.query(`SELECT id, owner_sub, owner_email, name, client_email, project_id, created_at, updated_at FROM credentials ORDER BY name`);
  return res.rows.map((r) => ({
    id: r.id,
    ownerSub: r.owner_sub,
    ownerEmail: r.owner_email,
    name: r.name,
    clientEmail: r.client_email,
    projectId: r.project_id,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  }));
}

export async function dbGetCredentialBlob(id: string): Promise<{ meta: CredentialRow; encBlob: string } | undefined> {
  if (!usePostgres || !pool) {
    const metaAll = await dbListCredentialsMeta();
    const meta = metaAll.find((c) => c.id === id);
    if (!meta) return undefined;
    const blobPath = path.join(dataDir(), "credentials-user", meta.ownerSub, `${id}.enc`);
    if (!fs.existsSync(blobPath)) return undefined;
    return { meta, encBlob: fs.readFileSync(blobPath, "utf8") };
  }
  const res = await pool.query(`SELECT * FROM credentials WHERE id = $1`, [id]);
  if (!res.rows[0]) return undefined;
  const r = res.rows[0];
  return {
    meta: {
      id: r.id,
      ownerSub: r.owner_sub,
      ownerEmail: r.owner_email,
      name: r.name,
      clientEmail: r.client_email,
      projectId: r.project_id,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    },
    encBlob: r.enc_blob,
  };
}

export async function dbUpsertCredential(meta: CredentialRow, encBlob: string): Promise<void> {
  if (!usePostgres || !pool) {
    const all = await dbListCredentialsMeta();
    const idx = all.findIndex((c) => c.id === meta.id);
    if (idx >= 0) all[idx] = meta;
    else all.push(meta);
    fs.writeFileSync(fileDbPath("credentials-meta.json"), JSON.stringify(all, null, 2) + "\n", "utf8");
    const dir = path.join(dataDir(), "credentials-user", meta.ownerSub);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${meta.id}.enc`), encBlob, "utf8");
    return;
  }
  await pool.query(
    `INSERT INTO credentials (id, owner_sub, owner_email, name, client_email, project_id, enc_blob, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       client_email = EXCLUDED.client_email,
       project_id = EXCLUDED.project_id,
       enc_blob = EXCLUDED.enc_blob,
       updated_at = EXCLUDED.updated_at`,
    [
      meta.id,
      meta.ownerSub,
      meta.ownerEmail,
      meta.name,
      meta.clientEmail,
      meta.projectId,
      encBlob,
      meta.createdAt,
      meta.updatedAt,
    ],
  );
}

export async function dbDeleteCredential(id: string): Promise<void> {
  const existing = await dbGetCredentialBlob(id);
  if (!usePostgres || !pool) {
    if (existing) {
      const all = (await dbListCredentialsMeta()).filter((c) => c.id !== id);
      fs.writeFileSync(fileDbPath("credentials-meta.json"), JSON.stringify(all, null, 2) + "\n", "utf8");
      const blobPath = path.join(dataDir(), "credentials-user", existing.meta.ownerSub, `${id}.enc`);
      fs.rmSync(blobPath, { force: true });
    }
    return;
  }
  await pool.query(`DELETE FROM credentials WHERE id = $1`, [id]);
}

export async function dbAppendAudit(event: AuditEvent): Promise<void> {
  if (!usePostgres || !pool) {
    const p = fileDbPath("audit.json");
    let all: AuditEvent[] = [];
    try {
      all = JSON.parse(fs.readFileSync(p, "utf8")) as AuditEvent[];
    } catch {
      all = [];
    }
    all.push(event);
    // Keep last 5000 events on disk.
    if (all.length > 5000) all = all.slice(-5000);
    fs.writeFileSync(p, JSON.stringify(all, null, 2) + "\n", "utf8");
    return;
  }
  await pool.query(
    `INSERT INTO audit_events (id, at, actor_sub, actor_email, action, target_type, target_id, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      event.id,
      event.at,
      event.actorSub,
      event.actorEmail,
      event.action,
      event.targetType,
      event.targetId,
      event.detail || null,
    ],
  );
}

export async function dbListAudit(limit = 100): Promise<AuditEvent[]> {
  if (!usePostgres || !pool) {
    try {
      const all = JSON.parse(fs.readFileSync(fileDbPath("audit.json"), "utf8")) as AuditEvent[];
      return all.slice(-limit).reverse();
    } catch {
      return [];
    }
  }
  const res = await pool.query(
    `SELECT id, at, actor_sub, actor_email, action, target_type, target_id, detail
     FROM audit_events ORDER BY at DESC LIMIT $1`,
    [limit],
  );
  return res.rows.map((r) => ({
    id: r.id,
    at: new Date(r.at).toISOString(),
    actorSub: r.actor_sub,
    actorEmail: r.actor_email,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    detail: r.detail || undefined,
  }));
}

/** Migrate legacy instances.json into Postgres once when empty. */
export async function migrateFileRegistryIfNeeded(): Promise<void> {
  if (!usePostgres || !pool) return;
  const count = await pool.query(`SELECT COUNT(*)::int AS n FROM instances`);
  if (count.rows[0].n > 0) return;
  const legacy = path.join(dataDir(), "instances.json");
  if (!fs.existsSync(legacy)) return;
  try {
    const list = JSON.parse(fs.readFileSync(legacy, "utf8")) as InstanceRecord[];
    for (const inst of list) await dbUpsertInstance(inst);
    console.log(`Migrated ${list.length} instances from instances.json into Postgres`);
  } catch (err) {
    console.warn("Could not migrate instances.json:", err);
  }
}
