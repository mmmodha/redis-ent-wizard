import {
  GcpApiError,
  gcpGet,
  gcpGetAll,
  gcpGetAggregated,
  listDnsZones,
} from "./gcp.js";
import { mapWithConcurrency, withRetry } from "./async-util.js";

/** A single live GCP resource, normalized across services. */
export interface LiveResource {
  /** e.g. "compute.instance", "sql.instance", "gke.cluster", "storage.bucket". */
  kind: string;
  /** Short resource name (last path segment), used for attribution + display. */
  name: string;
  /** Zone / region / multi-region the resource lives in ("global" when none). */
  location: string;
  status?: string;
  /** RFC3339 creation time when the API exposes one (drives cost-so-far). */
  creationTimestamp?: string;
  labels?: Record<string, string>;
  /** Pricing-relevant attributes (machineType, sizeGb, tier, …). */
  attrs: Record<string, unknown>;
  /** Owning instance id, filled by attribution (undefined = unowned). */
  instanceId?: string;
  /** owner / created_by label value (a person handle), for corroboration + UI. */
  owner?: string;
  /** Filled by pricing; undefined = could not price (shown as "—"). */
  costPerHour?: number;
  costSoFar?: number;
  currency?: string;
}

/** Last path segment of a selfLink or `zones/x/…/name` reference. */
export function tail(ref: string | undefined): string {
  if (!ref) return "";
  const clean = ref.split("?")[0];
  return clean.split("/").pop() || "";
}

/** Region for a zone, e.g. "europe-west1-b" → "europe-west1". */
export function regionFromZone(zone: string): string {
  return zone.replace(/-[a-z]$/, "");
}

function ownerFromLabels(labels?: Record<string, string>): string | undefined {
  return labels?.owner || labels?.created_by || undefined;
}

// ---------------------------------------------------------------------------
// Pure raw → LiveResource mappers (one per resource type). Unit-tested against
// canned API JSON; no I/O here.
// ---------------------------------------------------------------------------

export function mapComputeInstance(raw: {
  name: string;
  zone?: string;
  status?: string;
  creationTimestamp?: string;
  machineType?: string;
  labels?: Record<string, string>;
  disks?: unknown[];
}): LiveResource {
  const zone = tail(raw.zone);
  return {
    kind: "compute.instance",
    name: raw.name,
    location: zone,
    status: raw.status,
    creationTimestamp: raw.creationTimestamp,
    labels: raw.labels,
    owner: ownerFromLabels(raw.labels),
    attrs: { machineType: tail(raw.machineType), zone },
  };
}

export function mapDisk(raw: {
  name: string;
  zone?: string;
  region?: string;
  status?: string;
  creationTimestamp?: string;
  sizeGb?: string | number;
  type?: string;
  labels?: Record<string, string>;
  users?: string[];
}): LiveResource {
  const zone = tail(raw.zone);
  const location = zone || tail(raw.region) || "global";
  return {
    kind: "compute.disk",
    name: raw.name,
    location,
    status: raw.status,
    creationTimestamp: raw.creationTimestamp,
    labels: raw.labels,
    owner: ownerFromLabels(raw.labels),
    attrs: {
      sizeGb: Number(raw.sizeGb) || 0,
      diskType: tail(raw.type),
      zone: zone || undefined,
      region: tail(raw.region) || undefined,
    },
  };
}

export function mapAddress(raw: {
  name: string;
  region?: string;
  status?: string;
  creationTimestamp?: string;
  address?: string;
  addressType?: string;
}): LiveResource {
  return {
    kind: "compute.address",
    name: raw.name,
    location: tail(raw.region) || "global",
    status: raw.status,
    creationTimestamp: raw.creationTimestamp,
    attrs: { address: raw.address, addressType: raw.addressType },
  };
}

export function mapForwardingRule(raw: {
  name: string;
  region?: string;
  creationTimestamp?: string;
  IPAddress?: string;
  loadBalancingScheme?: string;
}): LiveResource {
  return {
    kind: "compute.forwardingRule",
    name: raw.name,
    location: tail(raw.region) || "global",
    creationTimestamp: raw.creationTimestamp,
    attrs: { ipAddress: raw.IPAddress, scheme: raw.loadBalancingScheme },
  };
}

export function mapNetwork(raw: { name: string; creationTimestamp?: string }): LiveResource {
  return {
    kind: "compute.network",
    name: raw.name,
    location: "global",
    creationTimestamp: raw.creationTimestamp,
    attrs: {},
  };
}

export function mapSubnetwork(raw: {
  name: string;
  region?: string;
  creationTimestamp?: string;
  ipCidrRange?: string;
}): LiveResource {
  return {
    kind: "compute.subnetwork",
    name: raw.name,
    location: tail(raw.region) || "global",
    creationTimestamp: raw.creationTimestamp,
    attrs: { cidr: raw.ipCidrRange },
  };
}

export function mapFirewall(raw: {
  name: string;
  creationTimestamp?: string;
  network?: string;
}): LiveResource {
  return {
    kind: "compute.firewall",
    name: raw.name,
    location: "global",
    creationTimestamp: raw.creationTimestamp,
    attrs: { network: tail(raw.network) },
  };
}

export function mapSqlInstance(raw: {
  name: string;
  region?: string;
  state?: string;
  createTime?: string;
  databaseVersion?: string;
  settings?: { tier?: string; dataDiskSizeGb?: string | number; dataDiskType?: string };
  userLabels?: Record<string, string>;
  settingsUserLabels?: Record<string, string>;
}): LiveResource {
  const labels = raw.userLabels || raw.settingsUserLabels;
  return {
    kind: "sql.instance",
    name: raw.name,
    location: raw.region || "global",
    status: raw.state,
    creationTimestamp: raw.createTime,
    labels,
    owner: ownerFromLabels(labels),
    attrs: {
      tier: raw.settings?.tier,
      dataDiskSizeGb: Number(raw.settings?.dataDiskSizeGb) || undefined,
      dataDiskType: raw.settings?.dataDiskType,
      databaseVersion: raw.databaseVersion,
    },
  };
}

export function mapGkeCluster(raw: {
  name: string;
  location?: string;
  status?: string;
  createTime?: string;
  currentNodeCount?: number;
  nodePools?: Array<{
    name: string;
    config?: { machineType?: string };
    initialNodeCount?: number;
    autoscaling?: { enabled?: boolean; minNodeCount?: number; maxNodeCount?: number };
  }>;
  resourceLabels?: Record<string, string>;
}): LiveResource {
  return {
    kind: "gke.cluster",
    name: raw.name,
    location: raw.location || "global",
    status: raw.status,
    creationTimestamp: raw.createTime,
    labels: raw.resourceLabels,
    owner: ownerFromLabels(raw.resourceLabels),
    attrs: {
      nodeCount: raw.currentNodeCount,
      nodePools: (raw.nodePools || []).map((p) => ({
        name: p.name,
        machineType: p.config?.machineType,
        nodeCount: p.initialNodeCount,
      })),
    },
  };
}

export function mapBucket(raw: {
  name: string;
  location?: string;
  storageClass?: string;
  timeCreated?: string;
  labels?: Record<string, string>;
}): LiveResource {
  return {
    kind: "storage.bucket",
    name: raw.name,
    location: raw.location || "global",
    creationTimestamp: raw.timeCreated,
    labels: raw.labels,
    owner: ownerFromLabels(raw.labels),
    attrs: { storageClass: raw.storageClass },
  };
}

export function mapPubsubTopic(raw: { name: string; labels?: Record<string, string> }): LiveResource {
  return {
    kind: "pubsub.topic",
    name: tail(raw.name),
    location: "global",
    labels: raw.labels,
    owner: ownerFromLabels(raw.labels),
    attrs: {},
  };
}

export function mapPubsubSubscription(raw: {
  name: string;
  topic?: string;
  labels?: Record<string, string>;
}): LiveResource {
  return {
    kind: "pubsub.subscription",
    name: tail(raw.name),
    location: "global",
    labels: raw.labels,
    owner: ownerFromLabels(raw.labels),
    attrs: { topic: tail(raw.topic) },
  };
}

export function mapBigqueryDataset(raw: {
  datasetReference?: { datasetId?: string };
  id?: string;
  location?: string;
  labels?: Record<string, string>;
}): LiveResource {
  return {
    kind: "bigquery.dataset",
    name: raw.datasetReference?.datasetId || tail(raw.id),
    location: raw.location || "global",
    labels: raw.labels,
    owner: ownerFromLabels(raw.labels),
    attrs: {},
  };
}

export function mapDnsRecord(
  raw: { name: string; type?: string; ttl?: number },
  zone: string,
): LiveResource {
  return {
    kind: "dns.record",
    name: raw.name.replace(/\.$/, ""),
    location: zone,
    attrs: { type: raw.type, ttl: raw.ttl },
  };
}

// ---------------------------------------------------------------------------
// Enumeration orchestrator (I/O). Resilient: a per-source failure (e.g. a
// missing *.list permission, 403) is recorded and skipped, never fatal.
// ---------------------------------------------------------------------------

export interface InventoryResult {
  resources: LiveResource[];
  /** IAM permissions the SA appears to lack (from 403s). */
  missingPermissions: string[];
  /** Non-fatal problems encountered per source. */
  warnings: string[];
}

interface Source {
  key: string;
  /** The IAM permission a 403 here most likely means is missing. */
  permission: string;
  fetch: (cred: string, project: string) => Promise<LiveResource[]>;
}

const C = "https://compute.googleapis.com/compute/v1/projects";

const SOURCES: Source[] = [
  {
    key: "compute.instances",
    permission: "compute.instances.list",
    fetch: async (c, p) =>
      (await gcpGetAggregated<Parameters<typeof mapComputeInstance>[0]>(c, `${C}/${p}/aggregated/instances`, "instances")).map(mapComputeInstance),
  },
  {
    key: "compute.disks",
    permission: "compute.disks.list",
    fetch: async (c, p) =>
      (await gcpGetAggregated<Parameters<typeof mapDisk>[0]>(c, `${C}/${p}/aggregated/disks`, "disks")).map(mapDisk),
  },
  {
    key: "compute.addresses",
    permission: "compute.addresses.list",
    fetch: async (c, p) =>
      (await gcpGetAggregated<Parameters<typeof mapAddress>[0]>(c, `${C}/${p}/aggregated/addresses`, "addresses")).map(mapAddress),
  },
  {
    key: "compute.forwardingRules",
    permission: "compute.forwardingRules.list",
    fetch: async (c, p) =>
      (await gcpGetAggregated<Parameters<typeof mapForwardingRule>[0]>(c, `${C}/${p}/aggregated/forwardingRules`, "forwardingRules")).map(mapForwardingRule),
  },
  {
    key: "compute.subnetworks",
    permission: "compute.subnetworks.list",
    fetch: async (c, p) =>
      (await gcpGetAggregated<Parameters<typeof mapSubnetwork>[0]>(c, `${C}/${p}/aggregated/subnetworks`, "subnetworks")).map(mapSubnetwork),
  },
  {
    key: "compute.networks",
    permission: "compute.networks.list",
    fetch: async (c, p) =>
      (await gcpGetAll<Parameters<typeof mapNetwork>[0]>(c, `${C}/${p}/global/networks`)).map(mapNetwork),
  },
  {
    key: "compute.firewalls",
    permission: "compute.firewalls.list",
    fetch: async (c, p) =>
      (await gcpGetAll<Parameters<typeof mapFirewall>[0]>(c, `${C}/${p}/global/firewalls`)).map(mapFirewall),
  },
  {
    key: "sql.instances",
    permission: "cloudsql.instances.list",
    fetch: async (c, p) =>
      (await gcpGetAll<Parameters<typeof mapSqlInstance>[0]>(c, `https://sqladmin.googleapis.com/v1/projects/${p}/instances`)).map(mapSqlInstance),
  },
  {
    key: "gke.clusters",
    permission: "container.clusters.list",
    fetch: async (c, p) =>
      (await gcpGetAll<Parameters<typeof mapGkeCluster>[0]>(c, `https://container.googleapis.com/v1/projects/${p}/locations/-/clusters`, "clusters")).map(mapGkeCluster),
  },
  {
    key: "storage.buckets",
    permission: "storage.buckets.list",
    fetch: async (c, p) =>
      (await gcpGetAll<Parameters<typeof mapBucket>[0]>(c, `https://storage.googleapis.com/storage/v1/b?project=${encodeURIComponent(p)}`)).map(mapBucket),
  },
  {
    key: "pubsub.topics",
    permission: "pubsub.topics.list",
    fetch: async (c, p) =>
      (await gcpGetAll<Parameters<typeof mapPubsubTopic>[0]>(c, `https://pubsub.googleapis.com/v1/projects/${p}/topics`, "topics")).map(mapPubsubTopic),
  },
  {
    key: "pubsub.subscriptions",
    permission: "pubsub.subscriptions.list",
    fetch: async (c, p) =>
      (await gcpGetAll<Parameters<typeof mapPubsubSubscription>[0]>(c, `https://pubsub.googleapis.com/v1/projects/${p}/subscriptions`, "subscriptions")).map(mapPubsubSubscription),
  },
  {
    key: "bigquery.datasets",
    permission: "bigquery.datasets.list",
    fetch: async (c, p) =>
      (await gcpGetAll<Parameters<typeof mapBigqueryDataset>[0]>(c, `https://bigquery.googleapis.com/bigquery/v2/projects/${p}/datasets`, "datasets")).map(mapBigqueryDataset),
  },
  {
    key: "dns.records",
    permission: "dns.resourceRecordSets.list",
    fetch: fetchDnsRecords,
  },
];

/** A/CNAME records across all managed zones — the tool's DNS entries plus noise. */
async function fetchDnsRecords(cred: string, project: string): Promise<LiveResource[]> {
  const zones = await listDnsZones(cred, project);
  const perZone = await mapWithConcurrency(zones, 4, async (z) => {
    const rrsets = await gcpGetAll<{ name: string; type?: string; ttl?: number }>(
      cred,
      `https://dns.googleapis.com/dns/v1/projects/${encodeURIComponent(project)}/managedZones/${encodeURIComponent(z.name)}/rrsets`,
      "rrsets",
    );
    return rrsets
      .filter((r) => r.type === "A" || r.type === "CNAME")
      .map((r) => mapDnsRecord(r, z.name));
  });
  return perZone.flat();
}

/** Enumerate every live resource the tool could have created in `project`. */
export async function enumerateResources(
  credentialsFile: string,
  project: string,
): Promise<InventoryResult> {
  const missingPermissions = new Set<string>();
  const warnings: string[] = [];

  const perSource = await mapWithConcurrency(SOURCES, 4, async (src) => {
    try {
      return await withRetry(() => src.fetch(credentialsFile, project), {
        shouldRetry: (err) =>
          err instanceof GcpApiError && (err.status === 429 || err.status >= 500),
      });
    } catch (err) {
      if (err instanceof GcpApiError && (err.status === 403 || err.status === 401)) {
        missingPermissions.add(src.permission);
      } else {
        warnings.push(`${src.key}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return [] as LiveResource[];
    }
  });

  return {
    resources: perSource.flat(),
    missingPermissions: [...missingPermissions].sort(),
    warnings,
  };
}
