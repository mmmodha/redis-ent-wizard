import type { AuthUser } from "./auth.js";
import { dbReadInstances } from "./db.js";
import type { CreateInstanceInput, InstanceStatus } from "./types.js";

export type QuotaLimits = {
  maxLiveClusters: number;
  maxNodesPerCluster: number;
  maxNvmePerNode: number;
  maxConcurrentJobs: number;
};

const DEFAULTS: QuotaLimits = {
  maxLiveClusters: Number(process.env.QUOTA_MAX_LIVE_CLUSTERS || 5),
  maxNodesPerCluster: Number(process.env.QUOTA_MAX_NODES || 7),
  maxNvmePerNode: Number(process.env.QUOTA_MAX_NVME || 8),
  maxConcurrentJobs: Number(process.env.QUOTA_MAX_CONCURRENT_JOBS || 2),
};

const LIVE: InstanceStatus[] = ["pending", "applying", "bootstrapping", "ready", "degraded", "failed", "destroying"];

export function getQuotaLimits(): QuotaLimits {
  return { ...DEFAULTS };
}

export async function checkCreateQuota(
  user: AuthUser,
  input: CreateInstanceInput,
): Promise<{ ok: boolean; errors: string[] }> {
  const limits = getQuotaLimits();
  const errors: string[] = [];
  const all = await dbReadInstances();
  const mine = all.filter(
    (i) => (i.ownerSub === user.sub || i.ownerEmail === user.email) && LIVE.includes(i.status) && i.status !== "destroyed",
  );
  const live = mine.filter((i) => i.status !== "destroyed" && i.status !== "failed");
  if (live.length >= limits.maxLiveClusters && user.role !== "admin") {
    errors.push(
      `Quota: you already have ${live.length} live cluster(s); limit is ${limits.maxLiveClusters}. Destroy one first.`,
    );
  }

  const nodes =
    input.mode === "gke" ? (input.gke_clustersize ?? 3) : (input.clustersize ?? 3);
  if (nodes > limits.maxNodesPerCluster) {
    errors.push(`Quota: max ${limits.maxNodesPerCluster} nodes per cluster (requested ${nodes})`);
  }

  const nvme = input.rof_nvme_disks ?? 0;
  if (nvme > limits.maxNvmePerNode) {
    errors.push(`Quota: max ${limits.maxNvmePerNode} NVMe disks per node (requested ${nvme})`);
  }

  return { ok: errors.length === 0, errors };
}

/** Map raw GCP permission errors to actionable least-privilege hints. */
export function iamHint(message: string): string | undefined {
  const m = message.toLowerCase();
  if (m.includes("container.clusters.get") || (m.includes("container.clusters") && m.includes("403"))) {
    return (
      "Missing GKE permission. For preflight grant roles/container.clusterViewer; " +
      "to create clusters grant roles/container.clusterAdmin plus roles/iam.serviceAccountUser " +
      "on the node service account (not project-wide)."
    );
  }
  if (m.includes("serviceusage") && (m.includes("403") || m.includes("permission"))) {
    return "Missing Service Usage permission. Grant roles/serviceusage.serviceUsageConsumer on the project.";
  }
  if (m.includes("compute.networks.") || (m.includes("compute.firewalls.") && m.includes("403"))) {
    return "Missing Compute network permission. Grant roles/compute.networkAdmin (not compute.admin).";
  }
  if (m.includes("compute.instances.") || m.includes("compute.disks.")) {
    return "Missing Compute instance/disk permission. Grant roles/compute.instanceAdmin.v1 (not compute.admin).";
  }
  if (m.includes("dns.") && m.includes("403")) {
    return "Missing Cloud DNS permission. Grant roles/dns.admin for record create (roles/dns.reader is read-only).";
  }
  if (m.includes("403") || m.includes("permission")) {
    return "GCP returned a permission error. Grant the least-privilege role for that API (see Credentials → Verify).";
  }
  return undefined;
}
