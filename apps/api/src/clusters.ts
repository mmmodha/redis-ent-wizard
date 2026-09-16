import type { CreateInstanceInput, DatabaseSpec, DeploymentMode } from "./types.js";
import { DEFAULT_RS_VERSION, resolveVmRelease } from "./rs-releases.js";

export const MAX_CLUSTERS = 3;
const DEFAULT_VM_MACHINE = "e2-standard-2";
const DEFAULT_NODES = 3;

const DEFAULT_RS_ADMIN = "admin@redis.io";

export type ClusterSpec = {
  name: string;
  nodes: number;
  machine_type: string;
  rof_nvme_disks: number;
  rs_version: string;
  RS_release: string;
  rec_nodes: number;
  /** Redis Enterprise admin username for this cluster (VM mode). */
  RS_admin: string;
  /** GKE only: name of the operator that owns this cluster (REC). */
  operator?: string;
  /** Non-Terraform metadata: databases created via the REST API after bootstrap. */
  databases?: DatabaseSpec[];
  /** Non-Terraform metadata: license applied via the REST API after bootstrap. */
  license?: string;
};

export type ClusterInput = {
  name?: string;
  nodes?: number;
  machine_type?: string;
  rof_nvme_disks?: number;
  rs_version?: string;
  RS_release?: string;
  rec_nodes?: number;
  RS_admin?: string;
  operator?: string;
  databases?: DatabaseSpec[];
  license?: string;
};

const RESERVED_CLUSTER_NAMES = new Set(["app", "gke"]);
const MAX_CLUSTER_NAME_LEN = 20;

export function normalizeClusterName(raw: unknown): string {
  const slug = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_CLUSTER_NAME_LEN)
    .replace(/-+$/g, "");
  if (!slug) return "";
  if (!/^[a-z]/.test(slug)) {
    throw new Error("Cluster names must start with a letter");
  }
  if (RESERVED_CLUSTER_NAMES.has(slug)) {
    throw new Error(`Cluster name "${slug}" is reserved`);
  }
  return slug;
}

function clampNodes(n: number | undefined, fallback: number): number {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1) return fallback;
  return Math.min(9, Math.floor(v));
}

function resolveRelease(c: ClusterInput, fallbackUrl?: string): { rs_version: string; RS_release: string } {
  const raw = c.RS_release || c.rs_version || fallbackUrl || DEFAULT_RS_VERSION;
  const rel = resolveVmRelease(raw);
  return { rs_version: rel.id, RS_release: rel.url };
}

export function normalizeClusters(input: {
  mode?: DeploymentMode;
  clusters?: ClusterInput[];
  clustersize?: number;
  machine_type?: string;
  rof_nvme_disks?: number;
  RS_release?: string;
  rec_nodes?: number;
  redis_enabled?: boolean;
  /** Deployment-wide admin username; the per-cluster fallback. */
  RS_admin?: string;
}): ClusterSpec[] {
  const mode = input.mode || "vm";
  if (input.redis_enabled === false) return [];
  const listed = input.clusters;
  if (Array.isArray(listed) && listed.length === 0) return [];
  if (listed && listed.length > MAX_CLUSTERS) {
    throw new Error("A deployment can have at most 3 Redis clusters");
  }

  const sources: ClusterInput[] =
    listed && listed.length
      ? listed
      : [
          {
            nodes: mode === "gke" ? input.rec_nodes ?? DEFAULT_NODES : input.clustersize ?? DEFAULT_NODES,
            machine_type: input.machine_type,
            rof_nvme_disks: input.rof_nvme_disks,
            RS_release: input.RS_release,
            rec_nodes: input.rec_nodes,
          },
        ];

  const fallbackMachine = (input.machine_type || DEFAULT_VM_MACHINE).trim() || DEFAULT_VM_MACHINE;
  const fallbackNvme = input.rof_nvme_disks ?? 0;

  const seen = new Set<string>();
  return sources.map((c) => {
    const name = normalizeClusterName(c.name);
    if (name) {
      if (seen.has(name)) throw new Error(`Cluster names must be unique (${name})`);
      seen.add(name);
    }
    const nodes = clampNodes(
      c.nodes ?? (mode === "gke" ? c.rec_nodes : undefined),
      mode === "gke" ? clampNodes(input.rec_nodes, DEFAULT_NODES) : clampNodes(input.clustersize, DEFAULT_NODES),
    );
    const recNodes = clampNodes(c.rec_nodes ?? c.nodes, nodes);
    const release = resolveRelease(c, input.RS_release);
    return {
      name,
      nodes,
      machine_type: (c.machine_type || fallbackMachine).trim() || DEFAULT_VM_MACHINE,
      rof_nvme_disks: Number.isFinite(Number(c.rof_nvme_disks))
        ? Math.max(0, Math.floor(Number(c.rof_nvme_disks)))
        : fallbackNvme,
      rs_version: release.rs_version,
      RS_release: release.RS_release,
      rec_nodes: recNodes,
      RS_admin: (c.RS_admin || input.RS_admin || DEFAULT_RS_ADMIN).trim() || DEFAULT_RS_ADMIN,
      // Carry non-Terraform metadata through so it survives the create handler
      // overwriting input.clusters with the normalized specs.
      ...(typeof c.operator === "string" && c.operator.trim() ? { operator: c.operator.trim() } : {}),
      ...(Array.isArray(c.databases) && c.databases.length ? { databases: c.databases } : {}),
      ...(typeof c.license === "string" && c.license.trim() ? { license: c.license } : {}),
    };
  });
}

/** The synthesized default operator's name, used for back-compat single-operator configs. */
export const DEFAULT_OPERATOR_NAME = "operator";
/** Namespace the default operator installs into (the legacy single-operator namespace). */
export const GKE_REC_NAMESPACE = "rec-ns";
export const MAX_OPERATORS = 3;

export type OperatorInput = { name?: string; operator_chart_version?: string };

export type OperatorSpec = {
  /** Slugged operator name (e.g. "operator", "search-ops"). */
  name: string;
  /** Kubernetes namespace this operator installs into. */
  namespace: string;
  /** Raw chart version id ("latest"/"" or a known release id); resolved at render time. */
  operator_chart_version: string;
};

/** Slug an operator name, defaulting to a stable per-index name when blank. */
export function normalizeOperatorName(raw: unknown, index: number): string {
  const slug = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_CLUSTER_NAME_LEN)
    .replace(/-+$/g, "");
  if (slug) {
    if (!/^[a-z]/.test(slug)) throw new Error("Operator names must start with a letter");
    return slug;
  }
  return index <= 0 ? DEFAULT_OPERATOR_NAME : `${DEFAULT_OPERATOR_NAME}-${index + 1}`;
}

/** The namespace for an operator: the legacy `rec-ns` for the default, else `rec-ns-<slug>`. */
export function operatorNamespace(slug: string): string {
  return slug === DEFAULT_OPERATOR_NAME ? GKE_REC_NAMESPACE : `${GKE_REC_NAMESPACE}-${slug}`;
}

/**
 * Resolve the GKE operators for a deployment. If `operators` is listed, use it
 * (slugged, unique); otherwise synthesize a single default operator from the
 * deployment-wide `operator_chart_version` so pre-operator configs still render.
 */
export function normalizeOperators(input: {
  operators?: OperatorInput[];
  operator_chart_version?: string;
}): OperatorSpec[] {
  const listed = input.operators;
  const sources: OperatorInput[] =
    listed && listed.length
      ? listed
      : [{ name: DEFAULT_OPERATOR_NAME, operator_chart_version: input.operator_chart_version }];
  if (sources.length > MAX_OPERATORS) {
    throw new Error(`A deployment can have at most ${MAX_OPERATORS} Redis operators`);
  }
  const seen = new Set<string>();
  return sources.map((op, i) => {
    const name = normalizeOperatorName(op.name, i);
    if (seen.has(name)) throw new Error(`Operator names must be unique (${name})`);
    seen.add(name);
    return {
      name,
      namespace: operatorNamespace(name),
      operator_chart_version: (op.operator_chart_version || "").trim(),
    };
  });
}

/** The operator that owns a cluster: matched by (slugged) `cluster.operator`, else the first. */
export function operatorForCluster(
  cluster: { operator?: string },
  operators: OperatorSpec[],
): OperatorSpec {
  const want = String(cluster.operator ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return operators.find((o) => o.name === want) || operators[0];
}

export function clusterNamePrefix(deploymentPrefix: string, index: number, name = ""): string {
  const slug = name.trim();
  if (slug) return `${deploymentPrefix}-${slug}`;
  if (index <= 0) return deploymentPrefix;
  return `${deploymentPrefix}-c${index + 1}`;
}

export function plannedDnsNames(opts: {
  deploymentPrefix: string;
  dnsZone: string;
  clusters: Array<{ name?: string; nodes: number }>;
  appCount?: number;
}): string[] {
  const zone = opts.dnsZone.replace(/\.$/, "");
  const names: string[] = [];
  opts.clusters.forEach((c, i) => {
    const prefix = clusterNamePrefix(opts.deploymentPrefix, i, c.name || "");
    names.push(`cluster.${prefix}.${zone}`);
    const nodes = Math.max(1, Math.min(9, Math.floor(c.nodes) || 1));
    for (let n = 1; n <= nodes; n++) {
      names.push(`node${n}.${prefix}.${zone}`);
    }
  });
  const apps = Math.max(0, Math.floor(opts.appCount || 0));
  if (apps > 0) {
    names.push(`app.${opts.deploymentPrefix}.${zone}`);
    for (let i = 1; i < apps; i++) {
      names.push(`app.${opts.deploymentPrefix}-${i}.${zone}`);
    }
  }
  return names;
}

export function totalClusterNodes(clusters: ClusterSpec[]): number {
  return clusters.reduce((sum, c) => sum + c.nodes, 0);
}

export function hasAppCompute(input: { app?: number; applications?: unknown[] }): boolean {
  const companion = Math.max(0, Math.floor(Number(input.app) || 0));
  const named = Array.isArray(input.applications) ? input.applications.length : 0;
  return companion > 0 || named > 0;
}

export function countRedisClusters(
  input: Pick<CreateInstanceInput, "mode" | "clusters" | "clustersize" | "rec_nodes" | "redis_enabled">,
): number {
  try {
    return normalizeClusters(input).length;
  } catch {
    return 1;
  }
}

export function summarizeClusters(clusters: ClusterSpec[]): string {
  if (!clusters.length) return "None";
  return clusters
    .map((c, i) => {
      const label = c.name || (clusters.length > 1 ? `C${i + 1}` : "");
      return `${label ? `${label} ` : ""}${c.nodes} × ${c.machine_type}`;
    })
    .join(", ");
}
