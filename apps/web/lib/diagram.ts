import type { Edge, Node } from "@xyflow/react";
import { effectiveDbReplication, clusterRedisNodeCount } from "./db-replication";

/**
 * Node data model for the visual designer. Each variant carries an index
 * signature so it satisfies React Flow's `Record<string, unknown>` node-data
 * constraint while still being discriminable by `kind`.
 */
export type NodeKind =
  | "network"
  | "gke"
  | "cluster"
  | "database"
  | "vms"
  | "application"
  | "loadbalancer"
  | "storage"
  | "pubsub"
  | "bigquery"
  | "cloudsql"
  | "rdi";

export type RootData = {
  kind: "network" | "gke";
  label: string;
  gke_machine_type?: string;
  gke_clustersize?: number;
  [k: string]: unknown;
};

export type ClusterData = {
  kind: "cluster";
  name: string;
  nodes: number;
  machine_type: string;
  rof_nvme_disks: number;
  rs_version: string;
  rec_nodes: number;
  license?: string;
  [k: string]: unknown;
};

export type DatabaseData = {
  kind: "database";
  name: string;
  memory_gb: number;
  replication: boolean;
  sharding: boolean;
  shards_count: number;
  eviction_policy: string;
  port: number;
  password: string;
  modules: string[];
  proxy_policy: "single" | "all-master-shards";
  shards_placement: "dense" | "sparse";
  oss_cluster: boolean;
  flex: boolean;
  /** Set on the tool-synthesized RDI pipeline-state database (visual only). */
  rdiInternal?: boolean;
  [k: string]: unknown;
};

export type VmsData = {
  kind: "vms";
  name: string;
  count: number;
  machine_type: string;
  disk_gib: number;
  memviz_enabled: boolean;
  expose_http: boolean;
  expose_https: boolean;
  extra_ports: string;
  [k: string]: unknown;
};

export type ArtifactSource = {
  kind: "upload" | "url" | "gcs" | "git";
  ref: string;
  type: "jar" | "binary";
  branch?: string;
  runInDocker?: boolean;
};

export type ApplicationData = {
  kind: "application";
  name: string;
  command: string;
  ports: string;
  env: { key: string; value: string }[];
  // VM mode
  requirements: string[];
  artifact: ArtifactSource;
  vm_count: number;
  machine_type: string;
  disk_gib: number;
  // GKE mode
  image: string;
  replicas: number;
  expose: "none" | "lb";
  [k: string]: unknown;
};

export type LoadBalancerData = {
  kind: "loadbalancer";
  name: string;
  expose_http: boolean;
  expose_https: boolean;
  extra_ports: string;
  [k: string]: unknown;
};

export type StorageData = {
  kind: "storage";
  name: string;
  location: string;
  storage_class: "STANDARD" | "NEARLINE" | "COLDLINE" | "ARCHIVE";
  versioning: boolean;
  force_destroy: boolean;
  access: "read" | "readwrite";
  [k: string]: unknown;
};

export type PubsubData = {
  kind: "pubsub";
  name: string;
  create_subscription: boolean;
  role: "publish" | "subscribe" | "both";
  [k: string]: unknown;
};

export type BigqueryData = {
  kind: "bigquery";
  name: string;
  location: string;
  access: "read" | "readwrite";
  [k: string]: unknown;
};

export type CloudSqlData = {
  kind: "cloudsql";
  name: string;
  engine: "postgres" | "mysql";
  tier: string;
  db_name: string;
  db_user: string;
  connectivity: "private" | "proxy" | "public";
  [k: string]: unknown;
};

/** One RDI pipeline's per-table mapping, keyed by source in RdiData.pipelines. */
export type RdiTableConfig = { table: string; key_prefix?: string };

export type RdiData = {
  kind: "rdi";
  name: string;
  machine_type: string;
  /** Per-source table/transform config authored in the pipeline editor. */
  pipelines?: { source: string; tables?: RdiTableConfig[] }[];
  [k: string]: unknown;
};

export type DesignNodeData =
  | RootData
  | ClusterData
  | DatabaseData
  | VmsData
  | ApplicationData
  | LoadBalancerData
  | StorageData
  | PubsubData
  | BigqueryData
  | CloudSqlData
  | RdiData;

export type DesignNode = Node<DesignNodeData>;
export type DesignEdge = Edge;

export type DesignSettings = {
  name: string;
  env: string;
  folder: string;
  youremail: string;
  skip_deletion: boolean;
  mode: "vm" | "gke";
  RS_admin: string;
  operator_chart_version: string;
  credentialsFile: string;
  project: string;
  region_name: string;
  region_zones: string[];
  dns_managed_zone: string;
  dns_zone_dns_name: string;
};

export const EVICTION_POLICIES = [
  "noeviction",
  "allkeys-lru",
  "allkeys-lfu",
  "allkeys-random",
  "volatile-lru",
  "volatile-lfu",
  "volatile-random",
  "volatile-ttl",
] as const;

export const APP_REQUIREMENTS = [
  { id: "openjdk-25", label: "OpenJDK 25" },
  { id: "openjdk-21", label: "OpenJDK 21" },
  { id: "openjdk-17", label: "OpenJDK 17" },
  { id: "nodejs", label: "Node.js" },
  { id: "python3", label: "Python 3" },
  { id: "python3-pip", label: "pip (Python)" },
  { id: "build-essential", label: "build-essential" },
  { id: "git", label: "git" },
  { id: "docker", label: "Docker" },
] as const;

export const ARTIFACT_SOURCE_OPTIONS = [
  { kind: "upload", label: "Upload" },
  { kind: "url", label: "URL" },
  { kind: "gcs", label: "GCS" },
  { kind: "git", label: "GitHub" },
] as const;

export function withGitSourceRequirements(reqs: string[], runInDocker: boolean): string[] {
  const extra = runInDocker ? ["git", "docker"] : ["git"];
  const out = runInDocker ? [...reqs] : reqs.filter((id) => id !== "docker");
  for (const id of extra) {
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

export const DB_MODULES = [
  { id: "search", label: "search" },
  { id: "ReJSON", label: "ReJSON" },
  { id: "timeseries", label: "timeseries" },
  { id: "bf", label: "bf" },
] as const;

export function clusterSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20)
    .replace(/-+$/g, "");
}

export function parsePorts(raw: string): number[] {
  if (!raw.trim()) return [];
  return raw
    .split(/[\s,;]+/)
    .map((p) => Number(p))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function envToRecord(rows: { key: string; value: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key) out[key] = row.value;
  }
  return out;
}

/** Data accessors keep the discriminated union readable without casts everywhere. */
function isCluster(n: DesignNode): n is Node<ClusterData> {
  return n.data.kind === "cluster";
}
function isDatabase(n: DesignNode): n is Node<DatabaseData> {
  return n.data.kind === "database";
}
function isVms(n: DesignNode): n is Node<VmsData> {
  return n.data.kind === "vms";
}
function isApplication(n: DesignNode): n is Node<ApplicationData> {
  return n.data.kind === "application";
}
function isLoadBalancer(n: DesignNode): n is Node<LoadBalancerData> {
  return n.data.kind === "loadbalancer";
}
function isStorage(n: DesignNode): n is Node<StorageData> {
  return n.data.kind === "storage";
}
function isPubsub(n: DesignNode): n is Node<PubsubData> {
  return n.data.kind === "pubsub";
}
function isBigquery(n: DesignNode): n is Node<BigqueryData> {
  return n.data.kind === "bigquery";
}
function isCloudSql(n: DesignNode): n is Node<CloudSqlData> {
  return n.data.kind === "cloudsql";
}
function isRdi(n: DesignNode): n is Node<RdiData> {
  return n.data.kind === "rdi";
}
/** True for the tool-synthesized RDI pipeline-state database node. */
function isRdiInternalDb(n: DesignNode): boolean {
  return n.data.kind === "database" && Boolean((n.data as DatabaseData).rdiInternal);
}

/** Human-facing name for a cluster node, used for edge connect references. */
export function clusterName(node: Node<ClusterData>, index: number): string {
  return clusterSlug(node.data.name) || `cluster${index + 1}`;
}

/**
 * The DNS prefix a cluster's resources get, matching the backend's
 * clusterNamePrefix: named clusters use their slug, the first unnamed cluster
 * uses the bare deployment prefix, later ones get a `-cN` suffix.
 */
export function clusterDnsPrefix(deploymentPrefix: string, index: number, name: string): string {
  const slug = clusterSlug(name);
  if (slug) return `${deploymentPrefix}-${slug}`;
  return index <= 0 ? deploymentPrefix : `${deploymentPrefix}-c${index + 1}`;
}

/**
 * The endpoint a database will be reachable at once the cluster is created.
 * VM clusters resolve to the cluster FQDN on the database port; GKE databases
 * are reached through the REC load balancer, whose IP is assigned on create.
 */
export function predictedDatabaseEndpoint(
  settings: Pick<DesignSettings, "name" | "env" | "dns_zone_dns_name" | "mode">,
  clusterNameRaw: string,
  clusterIndex: number,
  port: number,
): { endpoint: string; resolved: boolean; note?: string } {
  const p = Number(port) || 12000;
  if (settings.mode === "gke") {
    return { endpoint: `:${p}`, resolved: false, note: "on the REC load balancer (IP assigned on create)" };
  }
  const zone = (settings.dns_zone_dns_name || "").replace(/\.$/, "");
  if (!settings.name || !zone) {
    return { endpoint: `:${p}`, resolved: false, note: "set instance name and DNS zone" };
  }
  const deploymentPrefix = `${settings.name}-${settings.env || "default"}`;
  const fqdn = `cluster.${clusterDnsPrefix(deploymentPrefix, clusterIndex, clusterNameRaw)}.${zone}`;
  return { endpoint: `${fqdn}:${p}`, resolved: true };
}

/** DatabaseData for the tool-synthesized RDI pipeline-state database (visual only). */
export function rdiStateNodeData(rdiName: string): DatabaseData {
  return {
    kind: "database",
    name: `${(rdiName || "rdi").trim()}-state`,
    memory_gb: 1,
    replication: false,
    sharding: false,
    shards_count: 1,
    eviction_policy: "noeviction",
    port: 13000,
    password: "",
    modules: [],
    proxy_policy: "single",
    shards_placement: "dense",
    oss_cluster: false,
    flex: false,
    rdiInternal: true,
  };
}

/**
 * Reconcile the RDI pipeline-state database on the live canvas: for the RDI node
 * (one per deployment) that has a target-database edge, ensure exactly one
 * internal state database (`rdi-internal-<rdiId>`) exists in the target's
 * cluster, linked to RDI by a distinct `design-edge-rdi` edge. Removes any stale
 * internal database when the target edge, the RDI node, or the cluster is gone.
 * Returns null when nothing needs to change (so callers avoid render loops).
 */
export function reconcileRdiInternalNodes(
  nodes: DesignNode[],
  edges: DesignEdge[],
): { nodes: DesignNode[]; edges: DesignEdge[] } | null {
  const dbById = new Map(nodes.filter(isDatabase).map((n) => [n.id, n] as const));
  // Desired internal DBs keyed by node id -> its cluster + owning RDI.
  const desired = new Map<string, { rdiId: string; clusterId: string; rdiName: string }>();
  for (const rdi of nodes.filter(isRdi)) {
    const targetEdge = edges.find((e) => {
      if (e.source !== rdi.id) return false;
      const t = dbById.get(e.target);
      return Boolean(t && !isRdiInternalDb(t));
    });
    if (!targetEdge) continue;
    const clusterId = dbById.get(targetEdge.target)?.parentId;
    if (!clusterId) continue;
    desired.set(`rdi-internal-${rdi.id}`, { rdiId: rdi.id, clusterId, rdiName: rdi.data.name });
  }

  const existing = nodes.filter(isRdiInternalDb);
  const wantEdgeIds = new Set([...desired.keys()].map((id) => `edge-rdiint-${id.replace("rdi-internal-", "")}`));
  const haveInternalEdges = edges.filter((e) => e.id.startsWith("edge-rdiint-"));

  // Does the current graph already match the desired set (nodes + cluster + edges)?
  const nodesMatch =
    existing.length === desired.size &&
    existing.every((n) => {
      const d = desired.get(n.id);
      return d && n.parentId === d.clusterId;
    });
  const edgesMatch =
    haveInternalEdges.length === wantEdgeIds.size && haveInternalEdges.every((e) => wantEdgeIds.has(e.id));
  if (nodesMatch && edgesMatch) return null;

  // Rebuild: drop all internal DBs + their edges, then add the desired set.
  let nextNodes = nodes.filter((n) => !isRdiInternalDb(n));
  let nextEdges = edges.filter((e) => !e.id.startsWith("edge-rdiint-"));
  for (const [id, d] of desired) {
    nextNodes.push({
      id,
      type: "database",
      parentId: d.clusterId,
      extent: "parent",
      deletable: false,
      position: { x: 16, y: 0 },
      style: { width: NODE_SIZE.database.width, height: NODE_SIZE.database.height },
      data: rdiStateNodeData(d.rdiName),
    });
    nextEdges.push({
      id: `edge-rdiint-${d.rdiId}`,
      source: d.rdiId,
      target: id,
      animated: true,
      className: "design-edge-rdi",
    });
  }
  nextNodes = layoutDiagram(nextNodes);
  return { nodes: nextNodes, edges: nextEdges };
}

/** Env-var slug from a component name (mirrors the API's envSlug). */
export function envVarSlug(name: string): string {
  return String(name || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * The environment variables a provider component injects into any consumer wired
 * to it. Used to show an "Exposes" hint on nodes, dialogs, and wizard editors.
 * `connectName` is the reference name a consumer uses (cluster/db/lb/app name;
 * the Set-of-VMs group is "app").
 */
export function exposedVariables(
  kind: NodeKind,
  connectName: string,
): { name: string; description: string }[] {
  const s = envVarSlug(connectName) || "<NAME>";
  switch (kind) {
    case "cluster":
      return [
        { name: `REDIS_${s}_HOST`, description: "Cluster endpoint host" },
        { name: `REDIS_${s}_ADMIN_USER`, description: "Cluster admin username" },
        { name: `REDIS_${s}_ADMIN_PASSWORD`, description: "Cluster admin password (auto-generated)" },
      ];
    case "database":
      return [{ name: `REDIS_${s}_ENDPOINT`, description: "Database endpoint (host:port)" }];
    case "loadbalancer":
      return [{ name: `LB_${s}_ENDPOINT`, description: "Internal load-balancer VIP (host:port)" }];
    case "storage":
      return [
        { name: `GCS_${s}_BUCKET`, description: "Bucket name" },
        { name: `GCS_${s}_URL`, description: "Bucket URL (gs://…)" },
      ];
    case "pubsub":
      return [
        { name: `PUBSUB_${s}_TOPIC`, description: "Topic resource name" },
        { name: `PUBSUB_${s}_SUBSCRIPTION`, description: "Subscription resource name (if created)" },
        { name: `PUBSUB_${s}_PROJECT`, description: "GCP project id" },
      ];
    case "bigquery":
      return [
        { name: `BIGQUERY_${s}_DATASET`, description: "Dataset id" },
        { name: `BIGQUERY_${s}_PROJECT`, description: "GCP project id" },
        { name: `BIGQUERY_${s}_LOCATION`, description: "Dataset location" },
      ];
    case "cloudsql":
      return [
        { name: `SQL_${s}_HOST`, description: "Instance IP" },
        { name: `SQL_${s}_PORT`, description: "Database port" },
        { name: `SQL_${s}_DB`, description: "Database name" },
        { name: `SQL_${s}_USER`, description: "Database user" },
        { name: `SQL_${s}_PASSWORD`, description: "Database password (auto-generated)" },
        { name: `SQL_${s}_CONNECTION_NAME`, description: "Cloud SQL connection name" },
      ];
    case "application":
    case "vms":
      return [{ name: `${s}_HOST`, description: "Component hostname" }];
    default:
      return [];
  }
}

/**
 * Convert the diagram into the create payload consumed by POST /instances.
 * Mirrors the wizard's `payload()` shape and layers on the new fields.
 */
export function diagramToCreateInput(
  nodes: DesignNode[],
  edges: DesignEdge[],
  settings: DesignSettings,
): Record<string, unknown> {
  const clusters = nodes.filter(isCluster);
  // The RDI pipeline-state database is synthesized by the API from the RDI→target
  // relationship, so it is excluded here — it is neither a user database nor a
  // connectable target on the canvas.
  const databases = nodes.filter(isDatabase).filter((d) => !isRdiInternalDb(d));
  const vmsNodes = nodes.filter(isVms);
  const apps = nodes.filter(isApplication);
  const rdiNodes = nodes.filter(isRdi);
  const lbs = nodes.filter(isLoadBalancer);
  const storageNodes = nodes.filter(isStorage);
  const pubsubNodes = nodes.filter(isPubsub);
  const bigqueryNodes = nodes.filter(isBigquery);
  const cloudsqlNodes = nodes.filter(isCloudSql);

  const clusterNameById = new Map<string, string>();
  clusters.forEach((c, i) => clusterNameById.set(c.id, clusterName(c, i)));

  // Provider registries for connection edges. Databases inject their endpoint;
  // apps and the single Set-of-VMs group ("app") inject a host; buckets a name.
  const dbNameById = new Map<string, string>();
  databases.forEach((d) => dbNameById.set(d.id, d.data.name.trim() || "db"));
  const storageNameById = new Map<string, string>();
  storageNodes.forEach((s) => storageNameById.set(s.id, s.data.name.trim() || "bucket"));
  const pubsubNameById = new Map<string, string>();
  pubsubNodes.forEach((p) => pubsubNameById.set(p.id, p.data.name.trim() || "topic"));
  const bigqueryNameById = new Map<string, string>();
  bigqueryNodes.forEach((b) => bigqueryNameById.set(b.id, b.data.name.trim() || "dataset"));
  const cloudsqlNameById = new Map<string, string>();
  cloudsqlNodes.forEach((s) => cloudsqlNameById.set(s.id, s.data.name.trim() || "sql"));
  const hostNameById = new Map<string, string>();
  apps.forEach((a) => hostNameById.set(a.id, a.data.name.trim() || "app"));
  vmsNodes.forEach((v) => hostNameById.set(v.id, "app"));

  // A load balancer FRONTS a target when the LB is the edge source (or the
  // target is its parent). An edge INTO the LB is a consumer reading its VIP.
  const hostIds = [...apps.map((a) => a.id), ...vmsNodes.map((v) => v.id)];
  const frontingTargetId = (lb: Node<LoadBalancerData>): string | undefined => {
    if (lb.parentId && hostIds.includes(lb.parentId)) return lb.parentId;
    for (const e of edges) if (e.source === lb.id && hostIds.includes(e.target)) return e.target;
    return undefined;
  };
  // Final LB names must match load_balancers[].name so the Terraform VIP merge
  // (google_compute_address.lb[name]) resolves; derive them once here.
  const lbFinalNameById = new Map<string, string>();
  lbs.forEach((lb) => {
    const nm = lb.data.name.trim();
    const tId = frontingTargetId(lb);
    if (tId && apps.some((a) => a.id === tId)) {
      lbFinalNameById.set(lb.id, nm || `${hostNameById.get(tId)}-lb`);
    } else if (tId) {
      lbFinalNameById.set(lb.id, nm || "app-lb");
    } else {
      lbFinalNameById.set(lb.id, nm || "lb");
    }
  });
  const uniq = (xs: string[]) => [...new Set(xs)];

  const databasesFor = (clusterId: string) => {
    const cluster = clusters.find((c) => c.id === clusterId);
    const nodeCount = clusterRedisNodeCount(cluster?.data, settings.mode);
    return databases
      .filter((d) => d.parentId === clusterId)
      .map((d) => ({
        name: d.data.name.trim() || "db",
        memory_gb: Number(d.data.memory_gb),
        replication: effectiveDbReplication(Boolean(d.data.replication), nodeCount),
        sharding: Boolean(d.data.sharding),
        shards_count: d.data.sharding ? Number(d.data.shards_count) : 1,
        eviction_policy: d.data.eviction_policy,
        port: Number(d.data.port),
        password: d.data.password,
        modules: d.data.modules,
        proxy_policy: d.data.proxy_policy,
        shards_placement: d.data.shards_placement,
        oss_cluster: Boolean(d.data.oss_cluster),
        flex: Boolean(d.data.flex),
      }));
  };

  const applications = apps.map((a) => {
    const outgoing = edges.filter((e) => e.source === a.id);
    const connectClusters = uniq(
      outgoing.filter((e) => clusterNameById.has(e.target)).map((e) => clusterNameById.get(e.target) as string),
    );
    const connectDatabases = uniq(
      outgoing.filter((e) => dbNameById.has(e.target)).map((e) => dbNameById.get(e.target) as string),
    );
    const connectLoadBalancers = uniq(
      outgoing.filter((e) => lbFinalNameById.has(e.target)).map((e) => lbFinalNameById.get(e.target) as string),
    );
    const connectApps = uniq(
      outgoing
        .filter((e) => hostNameById.has(e.target) && e.target !== a.id)
        .map((e) => hostNameById.get(e.target) as string),
    );
    const connectStorage = uniq(
      outgoing.filter((e) => storageNameById.has(e.target)).map((e) => storageNameById.get(e.target) as string),
    );
    const connectPubsub = uniq(
      outgoing.filter((e) => pubsubNameById.has(e.target)).map((e) => pubsubNameById.get(e.target) as string),
    );
    const connectBigquery = uniq(
      outgoing.filter((e) => bigqueryNameById.has(e.target)).map((e) => bigqueryNameById.get(e.target) as string),
    );
    const connectSql = uniq(
      outgoing.filter((e) => cloudsqlNameById.has(e.target)).map((e) => cloudsqlNameById.get(e.target) as string),
    );
    const common: Record<string, unknown> = {
      name: a.data.name.trim() || "app",
    };
    if (a.data.command.trim()) common.command = a.data.command.trim();
    const ports = parsePorts(a.data.ports);
    if (ports.length) common.ports = ports;
    const env = envToRecord(a.data.env);
    if (Object.keys(env).length) common.env = env;
    if (connectClusters.length) common.connectClusters = connectClusters;
    if (connectDatabases.length) common.connectDatabases = connectDatabases;
    if (connectLoadBalancers.length) common.connectLoadBalancers = connectLoadBalancers;
    if (connectApps.length) common.connectApps = connectApps;
    if (connectStorage.length) common.connectStorage = connectStorage;
    if (connectPubsub.length) common.connectPubsub = connectPubsub;
    if (connectBigquery.length) common.connectBigquery = connectBigquery;
    if (connectSql.length) common.connectSql = connectSql;
    if (settings.mode === "vm") {
      Object.assign(common, {
        artifact: {
          kind: a.data.artifact.kind,
          ref: a.data.artifact.ref,
          type: a.data.artifact.type,
          ...(a.data.artifact.kind === "git" && a.data.artifact.branch
            ? { branch: a.data.artifact.branch }
            : {}),
          ...(a.data.artifact.kind === "git" ? { runInDocker: Boolean(a.data.artifact.runInDocker) } : {}),
        },
        requirements: a.data.requirements,
        vm_count: Number(a.data.vm_count),
        machine_type: a.data.machine_type,
        disk_gib: Number(a.data.disk_gib),
      });
    } else {
      Object.assign(common, {
        image: a.data.image,
        replicas: Number(a.data.replicas),
        expose: a.data.expose,
      });
    }
    return common;
  });

  const base: Record<string, unknown> = {
    name: settings.name,
    mode: settings.mode,
    youremail: settings.youremail,
    skip_deletion: settings.skip_deletion,
    // Redis intent is derived from the canvas: a cluster node present ⇒ deploy Redis.
    redis_enabled: settings.mode === "vm" ? clusters.length > 0 : true,
    project: settings.project,
    credentialsFile: settings.credentialsFile,
    region_name: settings.region_name,
    env: settings.env,
    folder: settings.folder.trim() || undefined,
    region_zones: settings.region_zones,
    applications,
  };

  // Storage buckets are available in both VM and GKE.
  const storageBuckets = storageNodes.map((s) => ({
    name: s.data.name.trim() || "bucket",
    location: s.data.location.trim() || undefined,
    storage_class: s.data.storage_class,
    versioning: Boolean(s.data.versioning),
    force_destroy: Boolean(s.data.force_destroy),
    access: s.data.access,
  }));
  if (storageBuckets.length) base.storage_buckets = storageBuckets;

  const pubsubTopics = pubsubNodes.map((p) => ({
    name: p.data.name.trim() || "topic",
    create_subscription: Boolean(p.data.create_subscription),
    role: p.data.role,
  }));
  if (pubsubTopics.length) base.pubsub_topics = pubsubTopics;

  const bigqueryDatasets = bigqueryNodes.map((b) => ({
    name: b.data.name.trim() || "dataset",
    location: b.data.location.trim() || undefined,
    access: b.data.access,
  }));
  if (bigqueryDatasets.length) base.bigquery_datasets = bigqueryDatasets;

  const cloudSqlInstances = cloudsqlNodes.map((s) => ({
    name: s.data.name.trim() || "sql",
    engine: s.data.engine,
    tier: s.data.tier.trim() || undefined,
    db_name: s.data.db_name.trim() || undefined,
    db_user: s.data.db_user.trim() || undefined,
    connectivity: s.data.connectivity,
  }));
  if (cloudSqlInstances.length) base.cloud_sql_instances = cloudSqlInstances;

  // RDI (one per deployment). Its target and pipeline sources come from edges:
  // RDI→database (non-internal) is the target; each RDI→Cloud SQL is a pipeline.
  const rdiNode = rdiNodes[0];
  if (rdiNode) {
    const outgoing = edges.filter((e) => e.source === rdiNode.id);
    const target = outgoing
      .map((e) => dbNameById.get(e.target))
      .find((n): n is string => Boolean(n));
    const sources = uniq(
      outgoing.filter((e) => cloudsqlNameById.has(e.target)).map((e) => cloudsqlNameById.get(e.target) as string),
    );
    // Merge per-source table config authored in the pipeline editor.
    const tablesBySource = new Map<string, RdiTableConfig[]>();
    for (const p of rdiNode.data.pipelines || []) {
      if (p.tables && p.tables.length) tablesBySource.set(p.source, p.tables);
    }
    const rdi: Record<string, unknown> = {
      name: rdiNode.data.name.trim() || "rdi",
      machine_type: rdiNode.data.machine_type,
    };
    if (target) rdi.target = target;
    if (sources.length) {
      rdi.pipelines = sources.map((source) => {
        const tables = tablesBySource.get(source);
        return tables && tables.length ? { source, tables } : { source };
      });
    }
    base.rdi = rdi;
  }

  if (settings.mode === "vm") {
    const clusterNodes = clusters;
    const first = clusterNodes[0];
    // App VMs come from Set-of-VMs nodes; a load balancer on a VMs node opens ports.
    const appCount = vmsNodes.reduce((n, v) => n + Number(v.data.count), 0);
    const appMachineTypes: string[] = [];
    const appDiskGib: number[] = [];
    for (const v of vmsNodes) {
      for (let i = 0; i < Number(v.data.count); i += 1) {
        appMachineTypes.push(v.data.machine_type);
        appDiskGib.push(Number(v.data.disk_gib));
      }
    }
    // A load balancer fronting the Set-of-VMs node opens its ports.
    const vmsLb = lbs.find((lb) => {
      const t = frontingTargetId(lb);
      return t !== undefined && vmsNodes.some((v) => v.id === t);
    });

    // Internal LB spec: each load balancer node fronts either an application or
    // the Set-of-VMs group (LB is the edge source or the target is its parent).
    // Ports come from the target application when known, else the LB's own settings.
    const appPortsById = new Map<string, number[]>();
    apps.forEach((a) => appPortsById.set(a.id, parsePorts(a.data.ports)));
    const lbNodePorts = (lb: Node<LoadBalancerData>): number[] => {
      const ports: number[] = [];
      if (lb.data.expose_http) ports.push(80);
      if (lb.data.expose_https) ports.push(443);
      return [...ports, ...parsePorts(String(lb.data.extra_ports))];
    };
    const loadBalancers: {
      name: string;
      target: string;
      target_kind: "application" | "vms";
      ports: number[];
    }[] = [];
    for (const lb of lbs) {
      const tId = frontingTargetId(lb);
      if (!tId) continue;
      const name = lbFinalNameById.get(lb.id) as string;
      if (apps.some((a) => a.id === tId)) {
        const appPorts = appPortsById.get(tId) || [];
        loadBalancers.push({
          name,
          target: hostNameById.get(tId) as string,
          target_kind: "application",
          ports: appPorts.length ? appPorts : lbNodePorts(lb),
        });
      } else {
        loadBalancers.push({ name, target: "app", target_kind: "vms", ports: lbNodePorts(lb) });
      }
    }

    // Connections from the Set-of-VMs group to providers (vms_connect).
    const vmsOutgoing = edges.filter((e) => vmsNodes.some((v) => v.id === e.source));
    const vmsConnect = {
      clusters: uniq(vmsOutgoing.filter((e) => clusterNameById.has(e.target)).map((e) => clusterNameById.get(e.target) as string)),
      databases: uniq(vmsOutgoing.filter((e) => dbNameById.has(e.target)).map((e) => dbNameById.get(e.target) as string)),
      load_balancers: uniq(vmsOutgoing.filter((e) => lbFinalNameById.has(e.target)).map((e) => lbFinalNameById.get(e.target) as string)),
      apps: uniq(
        vmsOutgoing
          .filter((e) => hostNameById.has(e.target) && !vmsNodes.some((v) => v.id === e.target))
          .map((e) => hostNameById.get(e.target) as string),
      ),
      storage: uniq(
        vmsOutgoing.filter((e) => storageNameById.has(e.target)).map((e) => storageNameById.get(e.target) as string),
      ),
      pubsub: uniq(
        vmsOutgoing.filter((e) => pubsubNameById.has(e.target)).map((e) => pubsubNameById.get(e.target) as string),
      ),
      bigquery: uniq(
        vmsOutgoing.filter((e) => bigqueryNameById.has(e.target)).map((e) => bigqueryNameById.get(e.target) as string),
      ),
      sql: uniq(
        vmsOutgoing.filter((e) => cloudsqlNameById.has(e.target)).map((e) => cloudsqlNameById.get(e.target) as string),
      ),
    };

    Object.assign(base, {
      clustersize: first ? Number(first.data.nodes) : 0,
      machine_type: first?.data.machine_type || "",
      rof_nvme_disks: first ? Number(first.data.rof_nvme_disks) : 0,
      rs_version: first?.data.rs_version || "",
      clusters: clusterNodes.map((c, i) => ({
        name: c.data.name.trim() || undefined,
        nodes: Number(c.data.nodes),
        machine_type: c.data.machine_type,
        rof_nvme_disks: Number(c.data.rof_nvme_disks),
        rs_version: c.data.rs_version,
        license: c.data.license?.trim() || undefined,
        databases: databasesFor(c.id),
      })),
      RS_admin: settings.RS_admin,
      app: appCount,
      app_machine_types: appCount > 0 ? appMachineTypes : undefined,
      app_disk_gib: appCount > 0 ? appDiskGib : undefined,
      // Memviz and port exposure can be set directly on a Set-of-VMs node, and a
      // load balancer nested on VMs still contributes its ports (OR-combined).
      memviz_enabled: appCount > 0 && vmsNodes.some((v) => Boolean(v.data.memviz_enabled)),
      app_expose_http:
        appCount > 0 &&
        (vmsNodes.some((v) => Boolean(v.data.expose_http)) ||
          (vmsLb ? Boolean(vmsLb.data.expose_http) : false)),
      app_expose_https:
        appCount > 0 &&
        (vmsNodes.some((v) => Boolean(v.data.expose_https)) ||
          (vmsLb ? Boolean(vmsLb.data.expose_https) : false)),
      app_extra_ports:
        appCount > 0
          ? [
              ...vmsNodes.flatMap((v) => parsePorts(String(v.data.extra_ports || ""))),
              ...(vmsLb ? parsePorts(String(vmsLb.data.extra_ports || "")) : []),
            ]
              .filter((p, i, a) => a.indexOf(p) === i)
              .join(",") || undefined
          : undefined,
      dns_managed_zone: settings.dns_managed_zone,
      dns_zone_dns_name: settings.dns_zone_dns_name,
    });
    if (loadBalancers.length) base.load_balancers = loadBalancers;
    if (
      vmsConnect.clusters.length ||
      vmsConnect.databases.length ||
      vmsConnect.load_balancers.length ||
      vmsConnect.apps.length ||
      vmsConnect.storage.length ||
      vmsConnect.pubsub.length ||
      vmsConnect.bigquery.length ||
      vmsConnect.sql.length
    ) {
      base.vms_connect = vmsConnect;
    }
  } else {
    const root = nodes.find((n) => n.data.kind === "gke");
    const rootData = (root?.data as RootData | undefined) || undefined;
    const recSum = clusters.reduce((n, c) => n + Number(c.data.rec_nodes), 0);
    Object.assign(base, {
      gke_clustersize: Math.max(Number(rootData?.gke_clustersize) || 0, recSum, 1),
      gke_machine_type: rootData?.gke_machine_type || "",
      rec_nodes: clusters[0] ? Number(clusters[0].data.rec_nodes) : 3,
      operator_chart_version: settings.operator_chart_version,
      clusters: clusters.map((c) => ({
        name: c.data.name.trim() || undefined,
        rec_nodes: Number(c.data.rec_nodes),
        nodes: Number(c.data.rec_nodes),
        license: c.data.license?.trim() || undefined,
        databases: databasesFor(c.id),
      })),
    });
  }

  return base;
}

/** Root node id and size, shared with the designer page. */
export const ROOT_ID = "root";
export const ROOT_SIZE = { width: 960, height: 560 };
const DIAGRAM_DEFAULT_RS_VERSION = "8.2.0-46";

/**
 * Layout constants on the Redis 8px grid. `PAD` is the inner padding of a
 * container, `GAP` the space between siblings, and the header heights reserve
 * room for each container's own title, machine line, and capacity so child
 * boxes never overlap that chrome.
 */
export const LAYOUT = {
  PAD: 32,
  GAP: 24,
  CLUSTER_HEADER: 120,
  ROOT_HEADER: 64,
} as const;

/** Deterministic sizes for each node kind. Containers may grow past these. */
export const NODE_SIZE: Record<string, { width: number; height: number }> = {
  database: { width: 248, height: 192 },
  loadbalancer: { width: 200, height: 72 },
  cluster: { width: 312, height: 128 },
  vms: { width: 232, height: 120 },
  application: { width: 232, height: 120 },
  storage: { width: 232, height: 120 },
  pubsub: { width: 232, height: 120 },
  bigquery: { width: 232, height: 120 },
  cloudsql: { width: 232, height: 120 },
  rdi: { width: 232, height: 120 },
};

/** Initial style for a freshly dropped node, if the kind has a preset size. */
export function initialNodeStyle(kind: NodeKind): { width: number; height: number } | undefined {
  const s = NODE_SIZE[kind];
  return s ? { width: s.width, height: s.height } : undefined;
}

function styleNum(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Pure layout pass: returns a new nodes array with every node's `position`
 * (relative to its parent) and container `style` size recomputed so nested
 * nodes sit fully inside their parents with no overlap, and every container
 * grows to hold its children. Deterministic and idempotent: children keep
 * their insertion order, so re-running it never shuffles the diagram.
 */
export function layoutDiagram(nodes: DesignNode[]): DesignNode[] {
  const { PAD, GAP, CLUSTER_HEADER, ROOT_HEADER } = LAYOUT;
  const DB = NODE_SIZE.database;
  const CLUSTER_WIDTH = Math.max(NODE_SIZE.cluster.width, DB.width + 2 * PAD);

  // Clone so the input is never mutated.
  const out = nodes.map((n) => ({
    ...n,
    position: { ...(n.position ?? { x: 0, y: 0 }) },
    style: { ...(n.style ?? {}) },
  })) as DesignNode[];

  // 1) Fixed sizes for leaf and peer nodes (vms, application, loadbalancer, database).
  for (const n of out) {
    const kind = n.data.kind as string;
    if (kind === "cluster") continue; // clusters grow, handled below
    const preset = NODE_SIZE[kind];
    if (preset) n.style = { ...n.style, width: preset.width, height: preset.height };
  }

  // 2) Stack databases vertically inside each cluster and grow the cluster.
  for (const cluster of out) {
    if (cluster.data.kind !== "cluster") continue;
    const dbs = out.filter((n) => n.parentId === cluster.id && n.data.kind === "database");
    let y: number = CLUSTER_HEADER;
    for (const db of dbs) {
      db.position = { x: PAD, y };
      y += DB.height + GAP;
    }
    const count = dbs.length;
    const height =
      count > 0 ? CLUSTER_HEADER + count * DB.height + (count - 1) * GAP + PAD : NODE_SIZE.cluster.height;
    cluster.style = { ...cluster.style, width: CLUSTER_WIDTH, height };
  }

  // 3) Arrange every root child in a wrapping grid inside the root.
  const root = out.find((n) => n.id === ROOT_ID);
  if (root) {
    const children = out.filter((n) => n.parentId === ROOT_ID);
    const MAX_COLS = 3;
    let x: number = PAD;
    let y: number = ROOT_HEADER;
    let rowHeight = 0;
    let col = 0;
    let maxRight: number = PAD;
    for (const child of children) {
      const width = styleNum(child.style?.width, NODE_SIZE.cluster.width);
      const height = styleNum(child.style?.height, NODE_SIZE.cluster.height);
      const wouldOverflow = x + width > ROOT_SIZE.width - PAD;
      if (col > 0 && (col >= MAX_COLS || wouldOverflow)) {
        x = PAD;
        y += rowHeight + GAP;
        rowHeight = 0;
        col = 0;
      }
      child.position = { x, y };
      x += width + GAP;
      rowHeight = Math.max(rowHeight, height);
      maxRight = Math.max(maxRight, child.position.x + width);
      col += 1;
    }
    root.style = {
      ...root.style,
      width: Math.max(ROOT_SIZE.width, maxRight + PAD),
      height: Math.max(ROOT_SIZE.height, y + rowHeight + PAD),
    };
  }

  return out;
}

/** Root node for the given mode, matching the designer's own `rootNode`. */
export function rootNode(mode: "vm" | "gke", rootData?: Partial<RootData>): DesignNode {
  return {
    id: ROOT_ID,
    type: mode === "vm" ? "network" : "gke",
    position: { x: 0, y: 0 },
    data:
      mode === "vm"
        ? { kind: "network", label: "VPC network" }
        : {
            kind: "gke",
            label: "GKE cluster",
            gke_machine_type: rootData?.gke_machine_type ?? "",
            gke_clustersize: rootData?.gke_clustersize ?? 3,
          },
    draggable: false,
    selectable: true,
    deletable: false,
    style: { width: ROOT_SIZE.width, height: ROOT_SIZE.height },
  };
}

function dstr(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function dnum(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function databaseDataFromConfig(d: Record<string, unknown>): DatabaseData {
  return {
    kind: "database",
    name: dstr(d.name) || "db",
    memory_gb: dnum(d.memory_gb, 1),
    replication: d.replication === undefined ? true : Boolean(d.replication),
    sharding: Boolean(d.sharding),
    shards_count: dnum(d.shards_count, 2),
    eviction_policy: dstr(d.eviction_policy) || "noeviction",
    port: dnum(d.port, 12000),
    password: dstr(d.password),
    modules: Array.isArray(d.modules) ? (d.modules as unknown[]).map(String) : [],
    proxy_policy: d.proxy_policy === "all-master-shards" ? "all-master-shards" : "single",
    shards_placement: d.shards_placement === "sparse" ? "sparse" : "dense",
    oss_cluster: Boolean(d.oss_cluster),
    flex: Boolean(d.flex),
    ...(d.rdi_internal ? { rdiInternal: true } : {}),
  };
}

type StoredClusterCfg = {
  name?: string;
  nodes?: number;
  machine_type?: string;
  rof_nvme_disks?: number;
  rs_version?: string;
  rec_nodes?: number;
  license?: string;
  databases?: Record<string, unknown>[];
};

type StoredAppCfg = {
  name?: string;
  command?: string;
  ports?: unknown[];
  env?: Record<string, unknown>;
  connectClusters?: unknown[];
  connectDatabases?: unknown[];
  connectLoadBalancers?: unknown[];
  connectApps?: unknown[];
  connectStorage?: unknown[];
  connectPubsub?: unknown[];
  connectBigquery?: unknown[];
  connectSql?: unknown[];
  requirements?: unknown[];
  artifact?: { kind?: string; ref?: string; type?: string; branch?: string; runInDocker?: boolean };
  vm_count?: number;
  machine_type?: string;
  disk_gib?: number;
  image?: string;
  replicas?: number;
  expose?: string;
};

/**
 * Approximate inverse of `diagramToCreateInput`: rebuild a designer diagram from
 * a stored create-config so a destroyed instance can be reopened and modified.
 * Round-trips need not be byte-identical, but recreating an unmodified diagram
 * yields an equivalent deployment.
 */
export function createInputToDiagram(
  config: Record<string, unknown>,
  mode: "vm" | "gke",
): { nodes: DesignNode[]; edges: DesignEdge[] } {
  const cfg = config || {};
  let counter = 0;
  const nextId = (kind: NodeKind) => `${kind}-${(counter += 1)}`;

  const nodes: DesignNode[] = [];
  const edges: DesignEdge[] = [];

  nodes.push(
    rootNode(mode, {
      gke_machine_type: dstr(cfg.gke_machine_type),
      gke_clustersize: dnum(cfg.gke_clustersize, 3),
    }),
  );

  const rawClusters = Array.isArray(cfg.clusters) ? (cfg.clusters as StoredClusterCfg[]) : [];
  const redisOff = cfg.redis_enabled === false || (Array.isArray(cfg.clusters) && rawClusters.length === 0);
  const clusterCfgs: StoredClusterCfg[] = redisOff
    ? []
    : rawClusters.length
      ? rawClusters
      : [
          {
            nodes: dnum(cfg.clustersize, 3),
            machine_type: dstr(cfg.machine_type),
            rof_nvme_disks: dnum(cfg.rof_nvme_disks, 0),
            rs_version: dstr(cfg.rs_version),
            rec_nodes: dnum(cfg.rec_nodes, 3),
          },
        ];

  const clusterIds: string[] = [];
  clusterCfgs.forEach((c, i) => {
    const clusterId = nextId("cluster");
    clusterIds.push(clusterId);
    nodes.push({
      id: clusterId,
      type: "cluster",
      parentId: ROOT_ID,
      extent: "parent",
      position: { x: 24 + i * 290, y: 56 },
      style: { width: NODE_SIZE.cluster.width, height: NODE_SIZE.cluster.height },
      data: {
        kind: "cluster",
        name: c.name || "",
        nodes: dnum(c.nodes ?? c.rec_nodes, 3),
        machine_type: dstr(c.machine_type),
        rof_nvme_disks: dnum(c.rof_nvme_disks, 0),
        rs_version: dstr(c.rs_version) || DIAGRAM_DEFAULT_RS_VERSION,
        rec_nodes: dnum(c.rec_nodes ?? c.nodes, 3),
        license: c.license || "",
      },
    });
    const dbs = Array.isArray(c.databases) ? c.databases : [];
    dbs.forEach((d, j) => {
      const data = databaseDataFromConfig(d || {});
      nodes.push({
        id: nextId("database"),
        type: "database",
        parentId: clusterId,
        extent: "parent",
        // The RDI state database is tool-managed, not user-deletable.
        ...(data.rdiInternal ? { deletable: false } : {}),
        position: { x: 16, y: 40 + j * 44 },
        style: { width: NODE_SIZE.database.width, height: NODE_SIZE.database.height },
        data,
      });
    });
  });

  // Set of App VMs (VM mode only).
  const appCount = dnum(cfg.app, 0);
  let vmsId: string | null = null;
  if (mode === "vm" && appCount > 0) {
    vmsId = nextId("vms");
    const machineTypes = Array.isArray(cfg.app_machine_types) ? (cfg.app_machine_types as unknown[]) : [];
    const diskGib = Array.isArray(cfg.app_disk_gib) ? (cfg.app_disk_gib as unknown[]) : [];
    nodes.push({
      id: vmsId,
      type: "vms",
      parentId: ROOT_ID,
      extent: "parent",
      position: { x: 24, y: 300 },
      style: { width: NODE_SIZE.vms.width, height: NODE_SIZE.vms.height },
      data: {
        kind: "vms",
        name: "",
        count: appCount,
        machine_type: machineTypes[0] !== undefined ? String(machineTypes[0]) : "",
        disk_gib: diskGib[0] !== undefined ? Number(diskGib[0]) || 0 : 0,
        memviz_enabled: Boolean((cfg as Record<string, unknown>).memviz_enabled),
        expose_http: Boolean((cfg as Record<string, unknown>).app_expose_http),
        expose_https: Boolean((cfg as Record<string, unknown>).app_expose_https),
        extra_ports: (() => {
          const ep = (cfg as Record<string, unknown>).app_extra_ports;
          if (Array.isArray(ep)) return ep.join(", ");
          return typeof ep === "string" ? ep : "";
        })(),
      },
    });
  }

  // Storage buckets (both modes) — full array rebuild so reopened instances show them.
  const storageCfgs = Array.isArray(cfg.storage_buckets)
    ? (cfg.storage_buckets as Record<string, unknown>[])
    : [];
  const storageNameToId = new Map<string, string>();
  storageCfgs.forEach((s, i) => {
    const id = nextId("storage");
    const name = dstr(s.name);
    const cls = dstr(s.storage_class);
    nodes.push({
      id,
      type: "storage",
      parentId: ROOT_ID,
      extent: "parent",
      position: { x: 520 + i * 220, y: 300 },
      style: { width: NODE_SIZE.storage.width, height: NODE_SIZE.storage.height },
      data: {
        kind: "storage",
        name,
        location: dstr(s.location),
        storage_class: (["STANDARD", "NEARLINE", "COLDLINE", "ARCHIVE"].includes(cls)
          ? cls
          : "STANDARD") as StorageData["storage_class"],
        versioning: Boolean(s.versioning),
        force_destroy: s.force_destroy === undefined ? true : Boolean(s.force_destroy),
        access: s.access === "read" ? "read" : "readwrite",
      },
    });
    if (name) storageNameToId.set(name, id);
  });

  // Pub/Sub topics (both modes).
  const pubsubCfgs = Array.isArray(cfg.pubsub_topics)
    ? (cfg.pubsub_topics as Record<string, unknown>[])
    : [];
  const pubsubNameToId = new Map<string, string>();
  pubsubCfgs.forEach((p, i) => {
    const id = nextId("pubsub");
    const name = dstr(p.name);
    nodes.push({
      id,
      type: "pubsub",
      parentId: ROOT_ID,
      extent: "parent",
      position: { x: 520 + i * 220, y: 460 },
      style: { width: NODE_SIZE.pubsub.width, height: NODE_SIZE.pubsub.height },
      data: {
        kind: "pubsub",
        name,
        create_subscription: Boolean(p.create_subscription),
        role: p.role === "publish" || p.role === "subscribe" ? p.role : "both",
      },
    });
    if (name) pubsubNameToId.set(name, id);
  });

  // BigQuery datasets (both modes).
  const bigqueryCfgs = Array.isArray(cfg.bigquery_datasets)
    ? (cfg.bigquery_datasets as Record<string, unknown>[])
    : [];
  const bigqueryNameToId = new Map<string, string>();
  bigqueryCfgs.forEach((b, i) => {
    const id = nextId("bigquery");
    const name = dstr(b.name);
    nodes.push({
      id,
      type: "bigquery",
      parentId: ROOT_ID,
      extent: "parent",
      position: { x: 760 + i * 220, y: 300 },
      style: { width: NODE_SIZE.bigquery.width, height: NODE_SIZE.bigquery.height },
      data: {
        kind: "bigquery",
        name,
        location: dstr(b.location),
        access: b.access === "read" ? "read" : "readwrite",
      },
    });
    if (name) bigqueryNameToId.set(name, id);
  });

  // Cloud SQL instances (both modes).
  const cloudsqlCfgs = Array.isArray(cfg.cloud_sql_instances)
    ? (cfg.cloud_sql_instances as Record<string, unknown>[])
    : [];
  const cloudsqlNameToId = new Map<string, string>();
  cloudsqlCfgs.forEach((s, i) => {
    const id = nextId("cloudsql");
    const name = dstr(s.name);
    const conn = dstr(s.connectivity);
    nodes.push({
      id,
      type: "cloudsql",
      parentId: ROOT_ID,
      extent: "parent",
      position: { x: 760 + i * 220, y: 460 },
      style: { width: NODE_SIZE.cloudsql.width, height: NODE_SIZE.cloudsql.height },
      data: {
        kind: "cloudsql",
        name,
        engine: s.engine === "mysql" ? "mysql" : "postgres",
        tier: dstr(s.tier) || "db-f1-micro",
        db_name: dstr(s.db_name) || "appdb",
        db_user: dstr(s.db_user) || "appuser",
        connectivity: conn === "proxy" || conn === "public" ? conn : "private",
      },
    });
    if (name) cloudsqlNameToId.set(name, id);
  });

  // Custom application workloads.
  const apps = Array.isArray(cfg.applications) ? (cfg.applications as StoredAppCfg[]) : [];
  const arr = (x: unknown): string[] => (Array.isArray(x) ? x.map(String) : []);
  const appIdByName = new Map<string, string>();
  const appConnects: {
    sourceId: string;
    sel: {
      clusters: string[];
      databases: string[];
      load_balancers: string[];
      apps: string[];
      storage: string[];
      pubsub: string[];
      bigquery: string[];
      sql: string[];
    };
  }[] = [];
  apps.forEach((a, k) => {
    const appId = nextId("application");
    appIdByName.set(dstr(a.name), appId);
    const env =
      a.env && typeof a.env === "object"
        ? Object.entries(a.env).map(([key, value]) => ({ key, value: String(value) }))
        : [];
    nodes.push({
      id: appId,
      type: "application",
      parentId: ROOT_ID,
      extent: "parent",
      position: { x: 280 + k * 240, y: 300 },
      style: { width: NODE_SIZE.application.width, height: NODE_SIZE.application.height },
      data: {
        kind: "application",
        name: dstr(a.name),
        command: dstr(a.command),
        ports: Array.isArray(a.ports) ? a.ports.map(String).join(", ") : "",
        env,
        requirements: Array.isArray(a.requirements) ? a.requirements.map(String) : [],
        artifact: {
          kind: (a.artifact?.kind as ArtifactSource["kind"]) || "upload",
          ref: dstr(a.artifact?.ref),
          type: (a.artifact?.type as ArtifactSource["type"]) || "jar",
          branch: dstr(a.artifact?.branch),
          runInDocker: Boolean(a.artifact?.runInDocker),
        },
        vm_count: dnum(a.vm_count, 1),
        machine_type: dstr(a.machine_type),
        disk_gib: dnum(a.disk_gib, 0),
        image: dstr(a.image),
        replicas: dnum(a.replicas, 1),
        expose: a.expose === "lb" ? "lb" : "none",
      },
    });
    appConnects.push({
      sourceId: appId,
      sel: {
        clusters: arr(a.connectClusters),
        databases: arr(a.connectDatabases),
        load_balancers: arr(a.connectLoadBalancers),
        apps: arr(a.connectApps),
        storage: arr(a.connectStorage),
        pubsub: arr(a.connectPubsub),
        bigquery: arr(a.connectBigquery),
        sql: arr(a.connectSql),
      },
    });
  });

  // Name -> id maps for rebuilding consumer edges.
  const clusterNameToId = new Map<string, string>();
  clusterCfgs.forEach((c, i) => {
    clusterNameToId.set(clusterSlug(c.name || "") || `cluster${i + 1}`, clusterIds[i]);
  });
  const dbNameToId = new Map<string, string>();
  nodes.forEach((n) => {
    if (n.data.kind === "database") dbNameToId.set((n.data as DatabaseData).name, n.id);
  });
  const hostNameToId = new Map<string, string>();
  appIdByName.forEach((id, name) => hostNameToId.set(name, id));
  if (vmsId) hostNameToId.set("app", vmsId);
  let edgeCounter = 0;

  // Load balancer on the Set of VMs when VM app exposure is configured.
  const exposeHttp = Boolean(cfg.app_expose_http);
  const exposeHttps = Boolean(cfg.app_expose_https);
  const extraPortsStr =
    typeof cfg.app_extra_ports === "string"
      ? cfg.app_extra_ports
      : Array.isArray(cfg.app_extra_ports)
        ? (cfg.app_extra_ports as unknown[]).join(", ")
        : "";
  const lbNameToId = new Map<string, string>();
  if (vmsId && (exposeHttp || exposeHttps || extraPortsStr.trim())) {
    const lbId = nextId("loadbalancer");
    // The load balancer is a root peer, linked to its target by a fronting edge.
    nodes.push({
      id: lbId,
      type: "loadbalancer",
      parentId: ROOT_ID,
      extent: "parent",
      position: { x: 24, y: 460 },
      style: { width: NODE_SIZE.loadbalancer.width, height: NODE_SIZE.loadbalancer.height },
      data: {
        kind: "loadbalancer",
        name: "",
        expose_http: exposeHttp,
        expose_https: exposeHttps,
        extra_ports: extraPortsStr,
      },
    });
    // The Set-of-VMs LB is named "app-lb" by diagramToCreateInput; map both so
    // consumer references (connectLoadBalancers) reconnect.
    lbNameToId.set("app-lb", lbId);
    edgeCounter += 1;
    edges.push({
      id: `edge-${edgeCounter}`,
      source: lbId,
      target: vmsId,
      animated: true,
      className: "design-edge-lb",
    });
  }

  // Rebuild consumer edges (consumer source -> provider target) for every
  // connection reference recorded on apps and the Set-of-VMs group.
  const addConsumerEdges = (
    sourceId: string,
    sel: {
      clusters: string[];
      databases: string[];
      load_balancers: string[];
      apps: string[];
      storage: string[];
      pubsub: string[];
      bigquery: string[];
      sql: string[];
    },
  ) => {
    const push = (targetId: string | undefined, isLb = false) => {
      if (!targetId || targetId === sourceId) return;
      edgeCounter += 1;
      edges.push({
        id: `edge-${edgeCounter}`,
        source: sourceId,
        target: targetId,
        animated: true,
        ...(isLb ? { className: "design-edge-lb" } : {}),
      });
    };
    sel.clusters.forEach((n) => push(clusterNameToId.get(n)));
    sel.databases.forEach((n) => push(dbNameToId.get(n)));
    sel.load_balancers.forEach((n) => push(lbNameToId.get(n), true));
    sel.apps.forEach((n) => push(hostNameToId.get(n)));
    sel.storage.forEach((n) => push(storageNameToId.get(n)));
    sel.pubsub.forEach((n) => push(pubsubNameToId.get(n)));
    sel.bigquery.forEach((n) => push(bigqueryNameToId.get(n)));
    sel.sql.forEach((n) => push(cloudsqlNameToId.get(n)));
  };
  for (const { sourceId, sel } of appConnects) addConsumerEdges(sourceId, sel);
  const vc = cfg.vms_connect as
    | {
        clusters?: unknown;
        databases?: unknown;
        load_balancers?: unknown;
        apps?: unknown;
        storage?: unknown;
        pubsub?: unknown;
        bigquery?: unknown;
        sql?: unknown;
      }
    | undefined;
  if (vmsId && vc) {
    addConsumerEdges(vmsId, {
      clusters: arr(vc.clusters),
      databases: arr(vc.databases),
      load_balancers: arr(vc.load_balancers),
      apps: arr(vc.apps),
      storage: arr(vc.storage),
      pubsub: arr(vc.pubsub),
      bigquery: arr(vc.bigquery),
      sql: arr(vc.sql),
    });
  }

  // RDI (one per deployment): rebuild the node, its source/target edges, and the
  // distinct link to the already-recreated pipeline-state database.
  const rdiCfg = cfg.rdi as
    | { name?: unknown; machine_type?: unknown; target?: unknown; pipelines?: unknown }
    | undefined;
  if (rdiCfg && dstr(rdiCfg.name)) {
    const rdiId = nextId("rdi");
    const pipelines = Array.isArray(rdiCfg.pipelines)
      ? (rdiCfg.pipelines as Record<string, unknown>[]).map((p) => ({
          source: dstr(p.source),
          tables: Array.isArray(p.tables)
            ? (p.tables as Record<string, unknown>[]).map((t) => ({
                table: dstr(t.table),
                key_prefix: dstr(t.key_prefix) || undefined,
              }))
            : undefined,
        }))
      : undefined;
    nodes.push({
      id: rdiId,
      type: "rdi",
      parentId: ROOT_ID,
      extent: "parent",
      position: { x: 520, y: 460 },
      style: { width: NODE_SIZE.rdi.width, height: NODE_SIZE.rdi.height },
      data: {
        kind: "rdi",
        name: dstr(rdiCfg.name),
        machine_type: dstr(rdiCfg.machine_type) || "n2-standard-4",
        ...(pipelines && pipelines.length ? { pipelines } : {}),
      },
    });
    for (const p of pipelines || []) {
      const sid = cloudsqlNameToId.get(p.source);
      if (sid) {
        edgeCounter += 1;
        edges.push({ id: `edge-${edgeCounter}`, source: rdiId, target: sid, animated: true });
      }
    }
    const target = dstr(rdiCfg.target);
    const targetDbId = target ? dbNameToId.get(target) : undefined;
    if (targetDbId) {
      edgeCounter += 1;
      edges.push({ id: `edge-${edgeCounter}`, source: rdiId, target: targetDbId, animated: true });
      const targetNode = nodes.find((n) => n.id === targetDbId);
      const stateNode = nodes.find(
        (n) => n.parentId === targetNode?.parentId && n.data.kind === "database" && (n.data as DatabaseData).rdiInternal,
      );
      if (stateNode) {
        edges.push({
          id: `edge-rdiint-${rdiId}`,
          source: rdiId,
          target: stateNode.id,
          animated: true,
          className: "design-edge-rdi",
        });
      }
    }
  }

  return { nodes: layoutDiagram(nodes), edges };
}
