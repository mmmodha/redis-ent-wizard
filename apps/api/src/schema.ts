import { z } from "zod";
import { CREATED_BY_ERROR, isValidCreatedBy } from "./created-by.js";

/**
 * Zod schemas for the create-config (`CreateInstanceInput`). Extracted from the
 * API route handlers so they can be shared: the HTTP routes validate with
 * `createSchema`, and the MCP "define" surface reuses the same schema (and its
 * JSON-Schema projection) so AI tools define infrastructure against one source
 * of truth. Pure and network-free.
 */

export const databaseSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9-]*$/, "database name must be lowercase alphanumeric/hyphen"),
  memory_gb: z.number().positive().max(1024),
  replication: z.boolean().optional(),
  sharding: z.boolean().optional(),
  shards_count: z.number().int().min(1).max(512).optional(),
  eviction_policy: z.string().max(40).optional(),
  port: z.number().int().min(1024).max(65535).optional(),
  password: z.string().max(256).optional(),
  modules: z.array(z.string().min(1).max(40)).max(16).optional(),
  proxy_policy: z.enum(["single", "all-master-shards"]).optional(),
  shards_placement: z.enum(["dense", "sparse"]).optional(),
  oss_cluster: z.boolean().optional(),
  flex: z.boolean().optional(),
});

export const applicationSchema = z.object({
  name: z.string().min(1).max(24),
  command: z.string().max(2048).optional(),
  ports: z.array(z.number().int().min(1).max(65535)).max(16).optional(),
  env: z.record(z.string()).optional(),
  connectClusters: z.array(z.string().max(40)).max(3).optional(),
  connectDatabases: z.array(z.string().max(40)).max(16).optional(),
  connectLoadBalancers: z.array(z.string().max(40)).max(8).optional(),
  connectApps: z.array(z.string().max(40)).max(8).optional(),
  connectStorage: z.array(z.string().max(40)).max(8).optional(),
  connectPubsub: z.array(z.string().max(40)).max(8).optional(),
  connectBigquery: z.array(z.string().max(40)).max(8).optional(),
  connectSql: z.array(z.string().max(40)).max(8).optional(),
  artifact: z
    .object({
      kind: z.enum(["upload", "url", "gcs", "git"]),
      ref: z.string().min(1).max(2048),
      type: z.enum(["jar", "binary"]),
      branch: z.string().max(200).optional(),
      runInDocker: z.boolean().optional(),
    })
    .optional(),
  vm_count: z.number().int().min(1).max(10).optional(),
  machine_type: z.string().optional(),
  disk_gib: z.number().int().min(0).max(65536).optional(),
  image: z.string().max(512).optional(),
  replicas: z.number().int().min(1).max(20).optional(),
  expose: z.enum(["none", "http", "https", "lb"]).optional(),
  requirements: z.array(z.string().min(1).max(40)).max(20).optional(),
});

export const loadBalancerSchema = z.object({
  name: z.string().min(1).max(40),
  target: z.string().min(1).max(40),
  target_kind: z.enum(["application", "vms"]),
  ports: z.array(z.number().int().min(1).max(65535)).min(1).max(16),
});

export const cloudSqlSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9-]*$/, "instance name must be lowercase alphanumeric/hyphen"),
  engine: z.enum(["postgres", "mysql"]).optional(),
  tier: z.string().max(60).optional(),
  db_name: z.string().max(60).optional(),
  db_user: z.string().max(60).optional(),
  connectivity: z.enum(["private", "proxy", "public"]).optional(),
  cdc_enabled: z.boolean().optional(),
});

export const bigquerySchema = z.object({
  name: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/, "dataset name must be lowercase alphanumeric/underscore"),
  location: z.string().max(40).optional(),
  access: z.enum(["read", "readwrite"]).optional(),
});

export const rdiTableSchema = z.object({
  table: z.string().min(1).max(128),
  key_prefix: z.string().max(128).optional(),
});

export const rdiPipelineSchema = z.object({
  source: z.string().min(1).max(40),
  tables: z.array(rdiTableSchema).max(100).optional(),
});

export const rdiSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9-]*$/, "RDI name must be lowercase alphanumeric/hyphen"),
  machine_type: z.string().max(60).optional(),
  target: z.string().max(40).optional(),
  pipelines: z.array(rdiPipelineSchema).max(8).optional(),
});

export const pubsubSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9-]*$/, "topic name must be lowercase alphanumeric/hyphen"),
  create_subscription: z.boolean().optional(),
  role: z.enum(["publish", "subscribe", "both"]).optional(),
});

export const storageBucketSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9-]*$/, "bucket name must be lowercase alphanumeric/hyphen"),
  location: z.string().max(40).optional(),
  storage_class: z.enum(["STANDARD", "NEARLINE", "COLDLINE", "ARCHIVE"]).optional(),
  versioning: z.boolean().optional(),
  force_destroy: z.boolean().optional(),
  access: z.enum(["read", "readwrite"]).optional(),
});

export const createSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[a-z][a-z0-9-]*$/, "name must be lowercase alphanumeric/hyphen"),
  mode: z.enum(["vm", "gke"]),
  youremail: z
    .string()
    .trim()
    .max(63)
    .refine((v) => isValidCreatedBy(v), { message: CREATED_BY_ERROR }),
  skip_deletion: z.boolean().optional(),
  redis_enabled: z.boolean().optional(),
  project: z.string().min(1),
  credentialsFile: z.string().min(1),
  region_name: z.string().optional(),
  env: z.string().optional(),
  folder: z.string().max(60).optional(),
  clustersize: z.number().int().min(0).max(9).optional(),
  machine_type: z.string().optional(),
  RS_release: z.string().optional(),
  RS_admin: z.string().optional(),
  app: z.number().int().min(0).max(5).optional(),
  app_machine_types: z.array(z.string().min(1)).max(5).optional(),
  app_machine_type: z.string().optional(),
  memviz_enabled: z.boolean().optional(),
  memviz_port: z.number().optional(),
  app_expose_http: z.boolean().optional(),
  app_expose_https: z.boolean().optional(),
  app_disk_gib: z.array(z.number().int()).max(5).optional(),
  app_extra_ports: z.union([z.string(), z.array(z.number().int())]).optional(),
  rof_nvme_disks: z.number().int().min(0).max(24).optional(),
  gke_clustersize: z.number().int().min(1).max(10).optional(),
  gke_machine_type: z.string().optional(),
  rec_nodes: z.number().int().min(1).max(9).optional(),
  // Deployment-wide operator chart version. Kept as a back-compat fallback for
  // configs that predate per-operator `operators[]`; new GKE configs carry the
  // version on each operator instead.
  operator_chart_version: z.string().optional(),
  // GKE Redis Operators. Each installs one operator Helm release into its own
  // namespace and owns the clusters (RECs) that reference it by name.
  operators: z
    .array(
      z.object({
        name: z.string().max(40).optional(),
        operator_chart_version: z.string().optional(),
      }),
    )
    .min(0)
    .max(3)
    .optional(),
  rs_version: z.string().optional(),
  clusters: z
    .array(
      z.object({
        name: z.string().max(40).optional(),
        nodes: z.number().int().min(1).max(9).optional(),
        machine_type: z.string().optional(),
        rof_nvme_disks: z.number().int().min(0).max(24).optional(),
        rs_version: z.string().optional(),
        RS_release: z.string().optional(),
        rec_nodes: z.number().int().min(1).max(9).optional(),
        RS_admin: z.string().max(128).optional(),
        // GKE only: the name of the operator that owns this cluster (REC).
        operator: z.string().max(40).optional(),
        databases: z.array(databaseSchema).max(16).optional(),
        license: z.string().max(20000).optional(),
      }),
    )
    .min(0)
    .max(3)
    .optional(),
  applications: z.array(applicationSchema).max(8).optional(),
  load_balancers: z.array(loadBalancerSchema).max(8).optional(),
  storage_buckets: z.array(storageBucketSchema).max(8).optional(),
  pubsub_topics: z.array(pubsubSchema).max(8).optional(),
  bigquery_datasets: z.array(bigquerySchema).max(8).optional(),
  cloud_sql_instances: z.array(cloudSqlSchema).max(8).optional(),
  rdi: rdiSchema.optional(),
  vms_connect: z
    .object({
      clusters: z.array(z.string().max(40)).max(3).optional(),
      databases: z.array(z.string().max(40)).max(16).optional(),
      load_balancers: z.array(z.string().max(40)).max(8).optional(),
      apps: z.array(z.string().max(40)).max(8).optional(),
      storage: z.array(z.string().max(40)).max(8).optional(),
      pubsub: z.array(z.string().max(40)).max(8).optional(),
      bigquery: z.array(z.string().max(40)).max(8).optional(),
      sql: z.array(z.string().max(40)).max(8).optional(),
    })
    .optional(),
  dns_managed_zone: z.string().optional(),
  dns_zone_dns_name: z.string().optional(),
  rs_private_subnet: z.string().optional(),
  rs_public_subnet: z.string().optional(),
  region_zones: z.array(z.string()).optional(),
});

/** Preflight accepts a config with `project` optional (falls back to the key's project). */
export const preflightSchema = createSchema.partial({ project: true }).extend({
  project: z.string().optional(),
});

/**
 * The create-config as an AI tool *defines* it (the MCP "design" surface).
 * `credentialsFile` and `project` are picked by the human at apply time — or by
 * the model via the discovery tools when it can — so they are optional here.
 * This avoids the model inventing placeholder credentials/projects that the
 * wizard can't resolve on review.
 */
export const designSchema = createSchema.extend({
  // Optional AND allowed to be blank — the web sends "" for an unset picker,
  // the MCP omits them entirely; both mean "the human picks it at apply time".
  credentialsFile: z.string().optional(),
  project: z.string().optional(),
});
