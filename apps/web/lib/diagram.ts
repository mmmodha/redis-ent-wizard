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
  | "loadbalancer";

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

export type DesignNodeData =
  | RootData
  | ClusterData
  | DatabaseData
  | VmsData
  | ApplicationData
  | LoadBalancerData;

export type DesignNode = Node<DesignNodeData>;
export type DesignEdge = Edge;

export type DesignSettings = {
  name: string;
  env: string;
  folder: string;
  youremail: string;
  skip_deletion: boolean;
  redis_enabled: boolean;
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
  const databases = nodes.filter(isDatabase);
  const vmsNodes = nodes.filter(isVms);
  const apps = nodes.filter(isApplication);
  const lbs = nodes.filter(isLoadBalancer);

  const clusterNameById = new Map<string, string>();
  clusters.forEach((c, i) => clusterNameById.set(c.id, clusterName(c, i)));

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
    const connectClusters = edges
      .filter((e) => e.source === a.id && clusterNameById.has(e.target))
      .map((e) => clusterNameById.get(e.target) as string);
    const common: Record<string, unknown> = {
      name: a.data.name.trim() || "app",
    };
    if (a.data.command.trim()) common.command = a.data.command.trim();
    const ports = parsePorts(a.data.ports);
    if (ports.length) common.ports = ports;
    const env = envToRecord(a.data.env);
    if (Object.keys(env).length) common.env = env;
    if (connectClusters.length) common.connectClusters = connectClusters;
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
    redis_enabled: settings.mode === "vm" ? settings.redis_enabled !== false : true,
    project: settings.project,
    credentialsFile: settings.credentialsFile,
    region_name: settings.region_name,
    env: settings.env,
    folder: settings.folder.trim() || undefined,
    region_zones: settings.region_zones,
    applications,
  };

  if (settings.mode === "vm") {
    const redisOn = settings.redis_enabled !== false;
    const clusterNodes = redisOn ? clusters : [];
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
    // A load balancer nested on (or edged to) a Set-of-VMs node opens its ports.
    const vmsLb = lbs.find((lb) => {
      if (lb.parentId && vmsNodes.some((v) => v.id === lb.parentId)) return true;
      return edges.some(
        (e) =>
          (e.source === lb.id && vmsNodes.some((v) => v.id === e.target)) ||
          (e.target === lb.id && vmsNodes.some((v) => v.id === e.source)),
      );
    });

    // Internal LB spec: each load balancer node fronts either an application
    // node or a Set-of-VMs node, detected by parentId or a connecting edge
    // (mirrors the vmsLb detection). Ports come from the target application when
    // known, otherwise from the load balancer node's own exposure settings.
    const appNameById = new Map<string, string>();
    apps.forEach((a) => appNameById.set(a.id, a.data.name.trim() || "app"));
    const appPortsById = new Map<string, number[]>();
    apps.forEach((a) => appPortsById.set(a.id, parsePorts(a.data.ports)));
    const lbNodePorts = (lb: Node<LoadBalancerData>): number[] => {
      const ports: number[] = [];
      if (lb.data.expose_http) ports.push(80);
      if (lb.data.expose_https) ports.push(443);
      return [...ports, ...parsePorts(String(lb.data.extra_ports))];
    };
    const attachedNodeId = (lb: Node<LoadBalancerData>, ids: string[]): string | undefined => {
      if (lb.parentId && ids.includes(lb.parentId)) return lb.parentId;
      for (const e of edges) {
        if (e.source === lb.id && ids.includes(e.target)) return e.target;
        if (e.target === lb.id && ids.includes(e.source)) return e.source;
      }
      return undefined;
    };
    const appIds = apps.map((a) => a.id);
    const vmsIds = vmsNodes.map((v) => v.id);
    const loadBalancers: {
      name: string;
      target: string;
      target_kind: "application" | "vms";
      ports: number[];
    }[] = [];
    for (const lb of lbs) {
      const lbName = lb.data.name.trim();
      const appId = attachedNodeId(lb, appIds);
      if (appId) {
        const appName = appNameById.get(appId) as string;
        const appPorts = appPortsById.get(appId) as number[];
        loadBalancers.push({
          name: lbName || `${appName}-lb`,
          target: appName,
          target_kind: "application",
          ports: appPorts.length ? appPorts : lbNodePorts(lb),
        });
        continue;
      }
      const vmsId = attachedNodeId(lb, vmsIds);
      if (vmsId) {
        loadBalancers.push({
          name: lbName || "app-lb",
          target: "app",
          target_kind: "vms",
          ports: lbNodePorts(lb),
        });
      }
    }

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
      nodes.push({
        id: nextId("database"),
        type: "database",
        parentId: clusterId,
        extent: "parent",
        position: { x: 16, y: 40 + j * 44 },
        style: { width: NODE_SIZE.database.width, height: NODE_SIZE.database.height },
        data: databaseDataFromConfig(d || {}),
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

  // Custom application workloads.
  const apps = Array.isArray(cfg.applications) ? (cfg.applications as StoredAppCfg[]) : [];
  const appConnects: { appId: string; connect: string[] }[] = [];
  apps.forEach((a, k) => {
    const appId = nextId("application");
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
    if (Array.isArray(a.connectClusters) && a.connectClusters.length) {
      appConnects.push({ appId, connect: a.connectClusters.map(String) });
    }
  });

  // Edges: application -> cluster, matched by the cluster's slug name.
  const clusterNameToId = new Map<string, string>();
  clusterCfgs.forEach((c, i) => {
    clusterNameToId.set(clusterSlug(c.name || "") || `cluster${i + 1}`, clusterIds[i]);
  });
  let edgeCounter = 0;
  for (const { appId, connect } of appConnects) {
    for (const cn of connect) {
      const targetId = clusterNameToId.get(cn);
      if (targetId) {
        edgeCounter += 1;
        edges.push({ id: `edge-${edgeCounter}`, source: appId, target: targetId, animated: true });
      }
    }
  }

  // Load balancer on the Set of VMs when VM app exposure is configured.
  const exposeHttp = Boolean(cfg.app_expose_http);
  const exposeHttps = Boolean(cfg.app_expose_https);
  const extraPortsStr =
    typeof cfg.app_extra_ports === "string"
      ? cfg.app_extra_ports
      : Array.isArray(cfg.app_extra_ports)
        ? (cfg.app_extra_ports as unknown[]).join(", ")
        : "";
  if (vmsId && (exposeHttp || exposeHttps || extraPortsStr.trim())) {
    const lbId = nextId("loadbalancer");
    // The load balancer is a root peer, linked to its target by an edge.
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
    edgeCounter += 1;
    edges.push({
      id: `edge-${edgeCounter}`,
      source: lbId,
      target: vmsId,
      animated: true,
      className: "design-edge-lb",
    });
  }

  return { nodes: layoutDiagram(nodes), edges };
}
