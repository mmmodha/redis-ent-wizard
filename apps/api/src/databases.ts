import https from "node:https";
import { clusterNamePrefix, normalizeClusters } from "./clusters.js";
import type {
  CreateInstanceInput,
  DatabaseSpec,
  DatabaseState,
  InstanceRecord,
  LicenseState,
} from "./types.js";

const RE_API_PORT = 9443;
const GIB = 1024 * 1024 * 1024;
/** Fraction of raw node memory usable for database data (rest is RE overhead). */
const USABLE_MEMORY_FRACTION = 0.85;
/** RAM portion of a Redis on Flash (Flex) database; the rest lives on NVMe. */
const FLEX_RAM_FRACTION = 0.1;

// Redis Enterprise serves its REST API with a self-signed certificate.
function reRequest(
  url: string,
  method: "GET" | "POST" | "PUT",
  auth: { user: string; pass: string },
  body?: unknown,
  timeoutMs = 15000,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = https.request(
      url,
      {
        method,
        rejectUnauthorized: false,
        timeout: timeoutMs,
        headers: {
          Authorization: "Basic " + Buffer.from(`${auth.user}:${auth.pass}`).toString("base64"),
          ...(payload ? { "Content-Type": "application/json" } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => {
          data += String(c);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export interface ClusterRestTarget {
  label: string;
  host: string;
  port: number;
  user: string;
  pass: string;
}

/** REST endpoints for each cluster in a deployment, aligned by creation order. */
export function clusterRestTargets(record: InstanceRecord): ClusterRestTarget[] {
  const ep = record.endpoints || {};
  if (record.mode === "gke") {
    const recs = Array.isArray(ep.recs) ? (ep.recs as Record<string, unknown>[]) : [];
    const rows = recs.length
      ? recs
      : [{ ui: ep.rec_ui_url, admin_username: ep.admin_username, admin_password: ep.admin_password, name: ep.rec_name }];
    return rows.map((r, i) => {
      const ui = String(r.ui || r.rec_ui_url || "");
      let host = "";
      try {
        host = ui ? new URL(ui).hostname : "";
      } catch {
        host = "";
      }
      return {
        label: String(r.name || `rec ${i + 1}`),
        host,
        port: RE_API_PORT,
        user: String(r.admin_username ?? ep.admin_username ?? ""),
        pass: String(r.admin_password ?? ep.admin_password ?? ""),
      };
    });
  }

  const clusters = ep.clusters;
  if (Array.isArray(clusters) && clusters.length) {
    return clusters.map((raw, i) => {
      const c = raw as Record<string, unknown>;
      const ips = asStringArray(c.nodes_ip);
      return {
        label: String(c.name || `cluster ${i + 1}`),
        host: ips[0] || "",
        port: RE_API_PORT,
        user: String(c.admin_username ?? ep.admin_username ?? ""),
        pass: String(c.admin_password ?? ep.admin_password ?? ""),
      };
    });
  }

  const ips = asStringArray(ep.nodes_ip);
  return [
    {
      label: "cluster",
      host: ips[0] || "",
      port: RE_API_PORT,
      user: String(ep.admin_username ?? ""),
      pass: String(ep.admin_password ?? ""),
    },
  ];
}

// --- capacity -------------------------------------------------------------

export function clusterCapacityBytes(nodes: number, machineMemoryMb: number): number {
  return Math.max(0, Math.floor(nodes * machineMemoryMb * 1024 * 1024 * USABLE_MEMORY_FRACTION));
}

/**
 * RAM bytes a set of databases consumes on the cluster, counting replication as
 * x2. A Flex (Redis on Flash) database only keeps a RAM portion in memory — the
 * rest lives on NVMe — so it counts at its RAM fraction, not its full size.
 */
export function requiredDbBytes(databases: DatabaseSpec[] = []): number {
  return databases.reduce((sum, d) => {
    const total = Math.max(0, Number(d.memory_gb) || 0) * GIB;
    const ram = d.flex ? total * FLEX_RAM_FRACTION : total;
    return sum + ram * (d.replication ? 2 : 1);
  }, 0);
}

export function capacityFor(
  nodes: number,
  machineMemoryMb: number,
  databases: DatabaseSpec[] = [],
): { capacity: number; required: number; remaining: number; ok: boolean } {
  const capacity = clusterCapacityBytes(nodes, machineMemoryMb);
  const required = requiredDbBytes(databases);
  return { capacity, required, remaining: capacity - required, ok: required <= capacity };
}

// --- creation -------------------------------------------------------------

export function buildBdbPayload(db: DatabaseSpec): Record<string, unknown> {
  const sharded = Boolean(db.sharding);
  const ossCluster = Boolean(db.oss_cluster);
  const memorySize = Math.max(0, Math.round((Number(db.memory_gb) || 0) * GIB));
  // The OSS Cluster API requires an all-master-shards (or all-nodes) proxy —
  // RE rejects oss_cluster + single with a 406 — so enabling OSS forces it.
  const proxyPolicy = ossCluster || db.proxy_policy === "all-master-shards" ? "all-master-shards" : "single";
  const payload: Record<string, unknown> = {
    name: db.name,
    memory_size: memorySize,
    replication: Boolean(db.replication),
    eviction_policy: db.eviction_policy || "noeviction",
    sharding: sharded,
    type: "redis",
    port: db.port ?? 12000,
    proxy_policy: proxyPolicy,
    shards_placement: db.shards_placement === "sparse" ? "sparse" : "dense",
    oss_cluster: ossCluster,
  };
  if (sharded) {
    payload.shards_count = Math.max(1, Math.floor(Number(db.shards_count) || 1));
  }
  // A sharded database served through per-shard endpoints (all-master-shards,
  // whether or not the OSS Cluster API is on) needs an explicit hashing policy;
  // RE rejects it as "missing shard_key_regex" otherwise. Single-proxy sharded
  // databases use standard hashing and need none.
  if (sharded && proxyPolicy === "all-master-shards") {
    payload.shard_key_regex = [
      { regex: ".*\\{(?<tag>.*)\\}.*" },
      { regex: "(?<tag>.*)" },
    ];
  }
  // Redis on Flash (Auto Tiering): most of the dataset lives on NVMe, a RAM
  // portion stays in memory. Requires flash-enabled nodes on the cluster.
  if (db.flex) {
    payload.bigstore = true;
    payload.bigstore_ram_size = Math.max(Math.round(memorySize * FLEX_RAM_FRACTION), 256 * 1024 * 1024);
  }
  if (db.password) payload.authentication_redis_pass = db.password;
  if (db.modules?.length) {
    payload.module_list = db.modules.map((m) => ({ module_name: m, module_args: "" }));
  }
  return payload;
}

/** Databases configured per cluster (aligned by creation order with targets). */
function configuredDatabases(record: InstanceRecord): DatabaseSpec[][] {
  const cfg = (record.config || {}) as unknown as CreateInstanceInput;
  try {
    const clusters = normalizeClusters({ ...cfg, mode: record.mode });
    // normalizeClusters strips databases; read them straight off the raw config.
    const raw = Array.isArray(cfg.clusters) ? cfg.clusters : [];
    return clusters.map((_, i) => (raw[i]?.databases as DatabaseSpec[] | undefined) || []);
  } catch {
    const raw = Array.isArray(cfg.clusters) ? cfg.clusters : [];
    return raw.map((c) => (c.databases as DatabaseSpec[] | undefined) || []);
  }
}

/**
 * Create every configured database that does not already exist, via the RE
 * REST API. Idempotent: names that already exist are left alone. Returns the
 * per-database state to record on the instance.
 */
export async function createDatabases(record: InstanceRecord): Promise<DatabaseState[]> {
  const perCluster = configuredDatabases(record);
  if (!perCluster.some((list) => list.length)) return [];

  const targets = clusterRestTargets(record);
  const states: DatabaseState[] = [];

  // For the RE DNS endpoint fallback (redis-<port>.cluster.<prefix>.<zone>).
  const cfg = (record.config || {}) as unknown as CreateInstanceInput;
  const deploymentPrefix = `${cfg.name}-${cfg.env || "default"}`;
  const dnsZone = String(cfg.dns_zone_dns_name || "demo.redislabs.com").replace(/\.$/, "");
  const rawClusters = Array.isArray(cfg.clusters) ? cfg.clusters : [];

  for (let i = 0; i < perCluster.length; i++) {
    const databases = perCluster[i];
    if (!databases.length) continue;
    const target = targets[i] || targets[0];
    const clusterLabel = target?.label || `cluster ${i + 1}`;
    const clusterFqdn = `cluster.${clusterNamePrefix(deploymentPrefix, i, String(rawClusters[i]?.name || ""))}.${dnsZone}`;

    if (!target || !target.host || !target.user || !target.pass) {
      for (const db of databases) {
        states.push({ cluster: clusterLabel, name: db.name, status: "failed", error: "cluster REST endpoint or admin credentials unavailable" });
      }
      continue;
    }

    const base = `https://${target.host}:${target.port}`;
    const existing = new Map<string, BdbObj>();
    try {
      const res = await reRequest(`${base}/v1/bdbs`, "GET", { user: target.user, pass: target.pass });
      if (res.status === 200) {
        for (const b of JSON.parse(res.body) as BdbObj[]) existing.set(String(b.name), b);
      }
    } catch {
      /* proceed; POST will surface errors per-db */
    }

    for (const db of databases) {
      const port = db.port ?? 12000;
      if (existing.has(db.name)) {
        const bdb = existing.get(db.name);
        states.push({ cluster: clusterLabel, name: db.name, status: "active", uid: bdb?.uid, port, endpoint: endpointFromBdb(bdb, port, clusterFqdn, target.host) });
        continue;
      }
      try {
        const res = await reRequest(
          `${base}/v1/bdbs`,
          "POST",
          { user: target.user, pass: target.pass },
          buildBdbPayload(db),
        );
        if (res.status >= 200 && res.status < 300) {
          let bdb: BdbObj | undefined;
          try {
            bdb = JSON.parse(res.body) as BdbObj;
          } catch {
            /* ignore */
          }
          states.push({ cluster: clusterLabel, name: db.name, status: "active", uid: bdb?.uid, port, endpoint: endpointFromBdb(bdb, port, clusterFqdn, target.host) });
        } else {
          states.push({ cluster: clusterLabel, name: db.name, status: "failed", error: `HTTP ${res.status}: ${res.body.slice(0, 200)}` });
        }
      } catch (err) {
        states.push({ cluster: clusterLabel, name: db.name, status: "failed", error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return states;
}

export function hasDatabases(record: InstanceRecord): boolean {
  return configuredDatabases(record).some((list) => list.length > 0);
}

type BdbObj = { uid?: number; name?: string; endpoints?: { dns_name?: string; port?: number }[] };

/**
 * The database's stable DNS endpoint. Redis Enterprise assigns each bdb a name
 * like `redis-<port>.cluster.<prefix>.<zone>`; prefer that (from the bdb's own
 * endpoints), then a constructed equivalent, and only fall back to node IP.
 */
function endpointFromBdb(bdb: BdbObj | undefined, port: number, clusterFqdn: string, host: string): string {
  const dns = (bdb?.endpoints || []).map((e) => e?.dns_name).find(Boolean);
  if (dns) return `${dns}:${port}`;
  if (clusterFqdn) return `redis-${port}.${clusterFqdn}:${port}`;
  return `${host}:${port}`;
}

// --- licensing ------------------------------------------------------------

/** License string configured per cluster, aligned by creation order. */
function configuredLicenses(record: InstanceRecord): string[] {
  const cfg = (record.config || {}) as unknown as CreateInstanceInput;
  const raw = Array.isArray(cfg.clusters) ? cfg.clusters : [];
  try {
    const clusters = normalizeClusters({ ...cfg, mode: record.mode });
    return clusters.map((_, i) => String(raw[i]?.license ?? "").trim());
  } catch {
    return raw.map((c) => String(c.license ?? "").trim());
  }
}

export function hasLicenses(record: InstanceRecord): boolean {
  return configuredLicenses(record).some((l) => l.length > 0);
}

/**
 * Apply the configured license to each cluster via the RE REST API. Uniform for
 * VM (node IP) and GKE (REC LoadBalancer IP). Must run before database creation
 * since a trial license caps shard count and memory.
 */
export async function applyLicenses(record: InstanceRecord): Promise<LicenseState[]> {
  const licenses = configuredLicenses(record);
  if (!licenses.some((l) => l.length)) return [];

  const targets = clusterRestTargets(record);
  const states: LicenseState[] = [];

  for (let i = 0; i < licenses.length; i++) {
    const license = licenses[i];
    if (!license) continue;
    const target = targets[i] || targets[0];
    const clusterLabel = target?.label || `cluster ${i + 1}`;

    if (!target || !target.host || !target.user || !target.pass) {
      states.push({ cluster: clusterLabel, status: "failed", error: "cluster REST endpoint or admin credentials unavailable" });
      continue;
    }

    const base = `https://${target.host}:${target.port}`;
    try {
      const res = await reRequest(`${base}/v1/license`, "PUT", { user: target.user, pass: target.pass }, { license });
      if (res.status >= 200 && res.status < 300) {
        let detail: string | undefined;
        try {
          const body = JSON.parse(res.body) as { expired?: boolean; expiration_date?: string; type_name?: string };
          detail = [body.type_name, body.expiration_date ? `expires ${body.expiration_date}` : undefined]
            .filter(Boolean)
            .join(" · ") || undefined;
        } catch {
          /* ignore */
        }
        states.push({ cluster: clusterLabel, status: "applied", detail });
      } else {
        states.push({ cluster: clusterLabel, status: "failed", error: `HTTP ${res.status}: ${res.body.slice(0, 200)}` });
      }
    } catch (err) {
      states.push({ cluster: clusterLabel, status: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }

  return states;
}
