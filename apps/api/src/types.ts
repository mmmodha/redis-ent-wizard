export type InstanceStatus =
  | "pending"
  | "applying"
  /** Terraform finished; Redis Enterprise is still installing/forming the cluster. */
  | "bootstrapping"
  | "ready"
  /** Resources exist but the cluster never fully formed. */
  | "degraded"
  | "failed"
  | "destroying"
  | "destroyed";

export interface ClusterHealth {
  state: "installing" | "bootstrapping" | "ready" | "unknown";
  nodesActive: number;
  nodesExpected: number;
  uiReachable: boolean;
  checkedAt: string;
  detail: string;
}

export type DeploymentMode = "vm" | "gke";

/** A database hosted on a Redis cluster, created post-bootstrap via the RE REST API. */
export interface DatabaseSpec {
  name: string;
  /** Dataset memory limit in GB (per the bdb `memory_size`, before replication). */
  memory_gb: number;
  replication?: boolean;
  sharding?: boolean;
  shards_count?: number;
  eviction_policy?: string;
  port?: number;
  password?: string;
  /** RE module names, e.g. "search", "ReJSON", "timeseries", "bf". */
  modules?: string[];
  /** Proxy policy: "single" (one endpoint) or "all-master-shards" (all primary shards). */
  proxy_policy?: "single" | "all-master-shards";
  /** Shard placement across nodes: "dense" (pack) or "sparse" (spread). */
  shards_placement?: "dense" | "sparse";
  /** Enable the OSS Cluster API (Redis Cluster protocol). Forces all-master-shards proxy. */
  oss_cluster?: boolean;
  /** Redis on Flash (Auto Tiering) — needs NVMe disks on the cluster. */
  flex?: boolean;
  /**
   * Marks a database that the tool synthesizes as the RDI pipeline state store.
   * Set only by `withRdiInternalDatabases`; never authored by the user.
   */
  rdi_internal?: boolean;
}

export type ArtifactKind = "upload" | "url" | "gcs" | "git";

export interface ApplicationArtifact {
  kind: ArtifactKind;
  /** Upload id, https URL, gs:// path, or GitHub repo URL depending on kind. */
  ref: string;
  type: "jar" | "binary";
  /** Optional git branch or tag; used when kind is git. */
  branch?: string;
  /** When kind is git, install Docker on the VM and run the command with it. */
  runInDocker?: boolean;
}

/**
 * A custom workload. On VM it provisions its own VM group and (optionally) runs
 * the artifact as a systemd service; on GKE it deploys a container image.
 */
/** A load balancer fronting an application or Set-of-VMs group. */
export interface LoadBalancerSpec {
  name: string;
  /** Name of the target application, or "app" for the Set-of-VMs group. */
  target: string;
  target_kind: "application" | "vms";
  /** Ports the load balancer forwards to the target VMs. */
  ports: number[];
}

/** A Cloud SQL instance (Postgres or MySQL) available to workloads. */
export interface CloudSqlSpec {
  /** Short name; the actual instance is `<deploymentPrefix>-<slug>`. */
  name: string;
  engine?: "postgres" | "mysql";
  /** Machine tier, e.g. db-f1-micro, db-custom-1-3840. */
  tier?: string;
  /** Application database created on the instance. */
  db_name?: string;
  /** Application database user (password is auto-generated). */
  db_user?: string;
  /** How consumers reach the instance. */
  connectivity?: "private" | "proxy" | "public";
  /**
   * Enable change-data-capture prerequisites (Postgres logical decoding /
   * MySQL binlog). Set automatically when the instance is wired as an RDI
   * source; may force an instance restart.
   */
  cdc_enabled?: boolean;
}

/** One source table in an RDI pipeline and how its rows land in Redis. */
export interface RdiTableSpec {
  /** Source table, optionally schema-qualified (e.g. public.orders). */
  table: string;
  /** Target Redis key prefix for rows from this table (defaults to the table name). */
  key_prefix?: string;
}

/** One RDI pipeline: change data from a single Cloud SQL source. */
export interface RdiPipelineSpec {
  /** Cloud SQL source instance short-name — a wired RDI→Cloud SQL edge. */
  source: string;
  /** Tables to ingest; empty means "all tables" (RDI default). */
  tables?: RdiTableSpec[];
}

/**
 * Redis Data Integration: a connector that ingests change data from one or
 * more Cloud SQL sources into a target Redis database. One RDI per deployment.
 */
export interface RdiSpec {
  /** Short name; the runtime is `<deploymentPrefix>-<slug>`. */
  name: string;
  /** VM-mode machine type for the dedicated RDI VM. */
  machine_type?: string;
  /** Target Redis database short-name — a wired RDI→database edge. */
  target?: string;
  /** One pipeline per wired Cloud SQL source. */
  pipelines?: RdiPipelineSpec[];
}

/** A BigQuery dataset available to workloads. */
export interface BigquerySpec {
  /** Short name; the actual dataset id is `<deploymentPrefix>_<slug>` (underscores). */
  name: string;
  /** BigQuery location: a region (e.g. europe-west1) or a multi-region (US/EU). Defaults to the deployment region. */
  location?: string;
  /** Access granted to a connected consumer's SA on the dataset. */
  access?: "read" | "readwrite";
}

/** A Pub/Sub topic (with an optional subscription) available to workloads. */
export interface PubsubSpec {
  /** Short name; the actual topic is `<deploymentPrefix>-<slug>`. */
  name: string;
  /** Also create a pull subscription `<topic>-sub`. */
  create_subscription?: boolean;
  /** Which IAM roles a connected consumer's SA gets on the topic/subscription. */
  role?: "publish" | "subscribe" | "both";
}

/** A Google Cloud Storage bucket available as object storage to workloads. */
export interface StorageBucketSpec {
  /** Short name; the actual bucket is `<deploymentPrefix>-<slug>`. */
  name: string;
  /** GCS location: a region (e.g. europe-west1) or a multi-region (US/EU/ASIA). Defaults to the deployment region. */
  location?: string;
  storage_class?: "STANDARD" | "NEARLINE" | "COLDLINE" | "ARCHIVE";
  versioning?: boolean;
  /** Allow terraform destroy to delete a non-empty bucket (default true for lab teardown). */
  force_destroy?: boolean;
  /** Access granted to a connected consumer's service account. */
  access?: "read" | "readwrite";
}

export interface Application {
  name: string;
  /** Optional. When empty on VM, the artifact is only staged (manual start). */
  command?: string;
  ports?: number[];
  env?: Record<string, string>;
  /** Requirement ids to apt-install on the VM before starting (e.g. "openjdk-25", "nodejs"). */
  requirements?: string[];
  /** Names of clusters in this deployment whose endpoint is injected as env. */
  connectClusters?: string[];
  /** Names of databases whose endpoint is injected as REDIS_<DB>_ENDPOINT. */
  connectDatabases?: string[];
  /** Names of load balancers whose VIP is injected as LB_<LB>_ENDPOINT. */
  connectLoadBalancers?: string[];
  /** Names of other applications / Set-of-VMs whose host is injected as <NAME>_HOST. */
  connectApps?: string[];
  /** Names of storage buckets injected as GCS_<NAME>_BUCKET / GCS_<NAME>_URL. */
  connectStorage?: string[];
  /** Names of Pub/Sub topics injected as PUBSUB_<NAME>_TOPIC / _SUBSCRIPTION / _PROJECT. */
  connectPubsub?: string[];
  /** Names of BigQuery datasets injected as BIGQUERY_<NAME>_DATASET / _PROJECT / _LOCATION. */
  connectBigquery?: string[];
  /** Names of Cloud SQL instances injected as SQL_<NAME>_HOST / _DB / _USER / _PASSWORD / _CONNECTION_NAME. */
  connectSql?: string[];
  // VM
  artifact?: ApplicationArtifact;
  vm_count?: number;
  machine_type?: string;
  disk_gib?: number;
  // GKE
  image?: string;
  replicas?: number;
  expose?: "none" | "http" | "https" | "lb";
  /** Populated server-side: a local file path Terraform copies to the VM over SSH. */
  artifactLocalPath?: string;
  artifactFilename?: string;
}

/** Per-database runtime state recorded after API-driven creation. */
export interface DatabaseState {
  cluster: string;
  name: string;
  status: "pending" | "creating" | "active" | "failed";
  uid?: number;
  endpoint?: string;
  port?: number;
  error?: string;
  /** Set when the actual bdb endpoint differs from the predicted one injected into consumers. */
  warning?: string;
}

/** Per-cluster license application state recorded after the cluster forms. */
export interface LicenseState {
  cluster: string;
  status: "applied" | "failed";
  /** Expiry / edition summary from the cluster once the license is set. */
  detail?: string;
  error?: string;
}

export interface InstanceRecord {
  id: string;
  name: string;
  mode: DeploymentMode;
  status: InstanceStatus;
  createdAt: string;
  updatedAt: string;
  project: string;
  region: string;
  ownerEmail: string;
  /** Okta subject (stable user id). */
  ownerSub?: string;
  credentialsFile: string;
  /** Uploaded credential id when using per-user JSON store. */
  credentialsId?: string;
  config: Record<string, unknown>;
  endpoints?: Record<string, unknown>;
  lastError?: string;
  lastApplyStartedAt?: string;
  lastDestroyStartedAt?: string;
  health?: ClusterHealth;
  /** User-defined grouping label, e.g. a team, customer or demo name. */
  folder?: string;
  /** State of API-driven database creation (populated after the cluster is ready). */
  databaseStates?: DatabaseState[];
  /** State of per-cluster license application (populated after the cluster is ready). */
  licenseStates?: LicenseState[];
}

export interface CreateInstanceInput {
  name: string;
  mode: DeploymentMode;
  youremail: string;
  /** When true, GCP resources get skip_deletion=yes. */
  skip_deletion?: boolean;
  /** When false, Terraform skips Redis Enterprise and deploys only application VMs. */
  redis_enabled?: boolean;
  project: string;
  credentialsFile: string;
  region_name?: string;
  env?: string;
  folder?: string;
  // VM
  clustersize?: number;
  machine_type?: string;
  RS_release?: string;
  rs_version?: string;
  RS_admin?: string;
  app?: number;
  /** One machine type per App VM (preferred). */
  app_machine_types?: string[];
  /** @deprecated Prefer app_machine_types — still accepted and repeated for every App VM. */
  app_machine_type?: string;
  memviz_enabled?: boolean;
  memviz_port?: number;
  app_expose_http?: boolean;
  app_expose_https?: boolean;
  /** Extra persistent disk GiB per App VM (0 = boot disk only). */
  app_disk_gib?: number[];
  /** Extra TCP ports to open on App VMs (string list or numbers). */
  app_extra_ports?: number[] | string;
  rof_nvme_disks?: number;
  /** One or more Redis clusters in this deployment. Legacy single-cluster fields still work. */
  clusters?: Array<{
    name?: string;
    nodes?: number;
    machine_type?: string;
    rof_nvme_disks?: number;
    rs_version?: string;
    RS_release?: string;
    rec_nodes?: number;
    /** Databases to create on this cluster after it forms. */
    databases?: DatabaseSpec[];
    /** Redis Enterprise license key applied to this cluster once it forms. */
    license?: string;
  }>;
  /** Custom application workloads (own VM group on VM, Deployment on GKE). */
  applications?: Application[];
  /** Internal load balancers fronting application / Set-of-VMs groups (VM mode). */
  load_balancers?: LoadBalancerSpec[];
  /** Cloud Storage buckets provisioned for this deployment (VM and GKE). */
  storage_buckets?: StorageBucketSpec[];
  /** Pub/Sub topics provisioned for this deployment (VM and GKE). */
  pubsub_topics?: PubsubSpec[];
  /** BigQuery datasets provisioned for this deployment (VM and GKE). */
  bigquery_datasets?: BigquerySpec[];
  /** Cloud SQL instances provisioned for this deployment (VM and GKE). */
  cloud_sql_instances?: CloudSqlSpec[];
  /** Redis Data Integration runtime + pipelines for this deployment (one per deployment). */
  rdi?: RdiSpec;
  /** Connection references from the Set-of-VMs group (app VMs) to providers in this deployment. */
  vms_connect?: {
    clusters?: string[];
    databases?: string[];
    load_balancers?: string[];
    apps?: string[];
    storage?: string[];
    pubsub?: string[];
    bigquery?: string[];
    sql?: string[];
  };
  // GKE
  gke_clustersize?: number;
  gke_machine_type?: string;
  rec_nodes?: number;
  /** Helm chart version for redis-enterprise-operator. Empty = latest. */
  operator_chart_version?: string;
  // shared
  dns_managed_zone?: string;
  dns_zone_dns_name?: string;
  rs_private_subnet?: string;
  rs_public_subnet?: string;
  region_zones?: string[];
}
