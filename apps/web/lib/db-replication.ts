/** Redis Enterprise replica shards need at least two nodes in the same cluster. */

export function canEnableDbReplication(clusterNodes: number): boolean {
  return Number(clusterNodes) >= 2;
}

export function effectiveDbReplication(wanted: boolean, clusterNodes: number): boolean {
  return Boolean(wanted) && canEnableDbReplication(clusterNodes);
}

export function clusterRedisNodeCount(
  cluster: { nodes?: number; rec_nodes?: number } | undefined,
  mode: "vm" | "gke",
): number {
  if (!cluster) return 0;
  const n = mode === "gke" ? cluster.rec_nodes : cluster.nodes;
  const parsed = Number(n);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

export function dbReplicationHint(clusterNodes: number): string {
  if (canEnableDbReplication(clusterNodes)) return "";
  return "Replication needs at least 2 nodes in this cluster.";
}
