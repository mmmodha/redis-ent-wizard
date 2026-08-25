/** Redis Enterprise Software trial license: 4 shards per cluster. */

export const TRIAL_SHARD_LIMIT = 4;

export type DbShardInput = {
  name?: string;
  sharding?: boolean;
  shards_count?: number;
  replication?: boolean;
};

export function shardsForDatabase(db: DbShardInput, clusterNodes?: number): number {
  const masters = db.sharding ? Math.max(1, Math.floor(Number(db.shards_count) || 1)) : 1;
  const ha = Boolean(db.replication) && (clusterNodes === undefined || clusterNodes >= 2);
  return masters * (ha ? 2 : 1);
}

export type TrialShardGate = {
  blocked: boolean;
  shards: number;
  limit: number;
  message: string;
};

export function clusterTrialShardGate(input: {
  name?: string;
  license?: string;
  databases?: DbShardInput[];
  nodes?: number;
}): TrialShardGate {
  const dbs = input.databases || [];
  const shards = dbs.reduce((sum, db) => sum + shardsForDatabase(db, input.nodes), 0);
  const licensed = Boolean(String(input.license || "").trim());
  if (!dbs.length || licensed || shards <= TRIAL_SHARD_LIMIT) {
    return { blocked: false, shards, limit: TRIAL_SHARD_LIMIT, message: "" };
  }
  const parts = dbs.map((db) => `${db.name?.trim() || "db"}: ${shardsForDatabase(db, input.nodes)}`);
  const cluster = input.name?.trim() || "This cluster";
  return {
    blocked: true,
    shards,
    limit: TRIAL_SHARD_LIMIT,
    message: `${cluster} would use ${shards} shards (${parts.join(", ")}). A trial license allows ${TRIAL_SHARD_LIMIT}. Add a Redis Enterprise license, reduce shards or turn off HA, or deploy the cluster without databases and create them after you apply a license.`,
  };
}
