import type { LiveResource } from "./gcp-inventory.js";

/**
 * Map live resources back to the instance (deployment) that created them.
 *
 * The reliable signal is the Terraform `name_prefix` == instance id
 * (`{name}-{env}`), which is embedded at the start of nearly every resource
 * name. Labels (`owner`/`created_by`) only identify a person, so they are used
 * only for display/corroboration, never as the primary key. A resource matching
 * no known instance prefix is "unowned".
 */

export const UNOWNED = "__unowned__";

/** BigQuery names use underscores; normalize so a prefix compare works. */
function normalize(s: string): string {
  return s.replace(/_/g, "-");
}

/**
 * Does `name` belong to `instanceId`? True when the (underscore-normalized)
 * name equals the id or begins with `id` followed by a `-` boundary. GKE node
 * VMs are GCP-named `gke-{clusterName}-…` where the cluster is `{id}-gke`, so
 * `gke-{id}-gke-*` also matches.
 */
export function nameMatchesInstance(name: string, instanceId: string): boolean {
  const n = normalize(name);
  const id = normalize(instanceId);
  if (n === id) return true;
  if (n.startsWith(`${id}-`)) return true;
  if (n.startsWith(`gke-${id}-gke`)) return true;
  return false;
}

/** The best (longest) matching instance id for a resource, or undefined. */
export function attributeOne(resource: LiveResource, instanceIds: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const id of instanceIds) {
    if (!nameMatchesInstance(resource.name, id)) continue;
    if (!best || id.length > best.length) best = id;
  }
  return best;
}

export interface AttributedResource extends LiveResource {
  /** Owning instance id, or undefined when unowned. */
  instanceId?: string;
}

export interface AttributionGroups {
  /** instanceId → resources; the unowned bucket is keyed by {@link UNOWNED}. */
  byInstance: Map<string, AttributedResource[]>;
}

/**
 * Assign every resource to its owning instance id (longest-prefix match) or to
 * the {@link UNOWNED} bucket. `instanceIds` is the set of known deployment ids.
 */
export function attributeResources(
  resources: readonly LiveResource[],
  instanceIds: readonly string[],
): AttributionGroups {
  const byInstance = new Map<string, AttributedResource[]>();
  for (const resource of resources) {
    const instanceId = attributeOne(resource, instanceIds);
    const key = instanceId || UNOWNED;
    const attributed: AttributedResource = { ...resource, instanceId };
    const list = byInstance.get(key);
    if (list) list.push(attributed);
    else byInstance.set(key, [attributed]);
  }
  return { byInstance };
}

// ---------------------------------------------------------------------------
// Response shaping (pure): turn attribution groups + instance metadata into the
// ordered group list and totals the API returns.
// ---------------------------------------------------------------------------

export interface InstanceMeta {
  id: string;
  name: string;
  status: string;
  mode: string;
  /** Whether the requesting user may see this instance's identity. */
  canView: boolean;
}

export interface ResourceGroupSummary {
  /** null for the unowned group. */
  instanceId: string | null;
  instanceName?: string;
  status?: string;
  mode?: string;
  /** Present only when the id matched no current registry record. */
  orphaned?: boolean;
  resourceCount: number;
  /** Sum of priced resources; undefined when none in the group are priced. */
  costPerHour?: number;
  costSoFar?: number;
  resources: AttributedResource[];
}

export interface ScanTotals {
  costPerHour: number;
  costSoFar: number;
  /** Resources that could not be priced (contribute nothing to the totals). */
  unpriced: number;
  resourceCount: number;
}

function sumField(resources: readonly AttributedResource[], field: "costPerHour" | "costSoFar"): number | undefined {
  let sum = 0;
  let any = false;
  for (const r of resources) {
    const v = r[field];
    if (typeof v === "number") {
      sum += v;
      any = true;
    }
  }
  return any ? sum : undefined;
}

/**
 * Build the ordered group summaries + overall totals. Known instances come
 * first (by name/id), then any owned-but-not-in-registry ids (orphaned), then
 * the unowned bucket last.
 */
export function summarize(
  groups: AttributionGroups,
  metaById: Map<string, InstanceMeta>,
): { groups: ResourceGroupSummary[]; totals: ScanTotals } {
  const summaries: ResourceGroupSummary[] = [];
  const totals: ScanTotals = { costPerHour: 0, costSoFar: 0, unpriced: 0, resourceCount: 0 };

  for (const [key, resources] of groups.byInstance) {
    totals.resourceCount += resources.length;
    for (const r of resources) {
      if (typeof r.costPerHour === "number") totals.costPerHour += r.costPerHour;
      if (typeof r.costSoFar === "number") totals.costSoFar += r.costSoFar;
      if (typeof r.costPerHour !== "number" && typeof r.costSoFar !== "number") totals.unpriced += 1;
    }

    if (key === UNOWNED) {
      summaries.push({
        instanceId: null,
        resourceCount: resources.length,
        costPerHour: sumField(resources, "costPerHour"),
        costSoFar: sumField(resources, "costSoFar"),
        resources,
      });
      continue;
    }

    const meta = metaById.get(key);
    summaries.push({
      instanceId: key,
      instanceName: meta?.canView ? meta.name : undefined,
      status: meta?.canView ? meta.status : undefined,
      mode: meta?.canView ? meta.mode : undefined,
      orphaned: !meta,
      resourceCount: resources.length,
      costPerHour: sumField(resources, "costPerHour"),
      costSoFar: sumField(resources, "costSoFar"),
      resources,
    });
  }

  summaries.sort((a, b) => {
    // Unowned always last.
    if (a.instanceId === null) return 1;
    if (b.instanceId === null) return -1;
    const an = a.instanceName || a.instanceId;
    const bn = b.instanceName || b.instanceId;
    return an.localeCompare(bn);
  });

  return { groups: summaries, totals };
}
