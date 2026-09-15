/**
 * An authored, human-readable guide to what a create-config can define, paired
 * with the machine-readable JSON Schema (from `createSchema`) at
 * `GET /designs/schema`. The MCP server surfaces both so an AI tool understands
 * the component kinds and — crucially — the wiring rules that the raw schema
 * can't express (which connection edges are allowed, and what they cause).
 *
 * Keep this in sync with the schema and the wiring semantics; it is guidance,
 * not validation. The API's `createSchema` is always the authority.
 */
export const CAPABILITIES_GUIDE = {
  summary:
    "Define a Redis Enterprise deployment on GCP: one or more Redis clusters (each with databases), optional application workloads, and optional GCP data services (Cloud SQL, Pub/Sub, BigQuery, Cloud Storage) and Redis Data Integration (RDI). You DEFINE a config; a human reviews and applies it. You cannot provision or destroy.",
  modes: {
    vm: "Redis Enterprise on Compute Engine VMs. Applications run on their own VM groups; load balancers and RDI-on-a-dedicated-VM are available.",
    gke: "Redis Enterprise on GKE via the operator. Applications run as Deployments; RDI runs via Helm.",
  },
  required: {
    name: "Short deployment name (becomes the resource prefix).",
    mode: "'vm' or 'gke'.",
    youremail: "Owner id (username or email); attributes the deployment.",
    project: "GCP project id.",
    credentialsFile: "Name of the GCP credentials file/id to apply with (not needed to define/validate).",
  },
  components: {
    clusters:
      "Redis Enterprise clusters. Each has a name, node count, machine type, and a list of databases. Start empty and add clusters explicitly.",
    databases:
      "Per-cluster Redis databases: name, memory_gb, optional replication/sharding, modules (search, ReJSON, timeseries, bf), eviction, port, password.",
    applications:
      "Custom workloads. VM: own VM group, optional artifact (jar/binary/git) run as a service. GKE: a container image Deployment. Connect to other components to receive their endpoints as env vars.",
    load_balancers: "VM-mode internal load balancers fronting an application or the Set-of-VMs group.",
    cloud_sql_instances:
      "Cloud SQL (postgres/mysql). Wiring one as an RDI source auto-enables its CDC prerequisites.",
    pubsub_topics: "Pub/Sub topics (optional subscription); granted to connected consumers.",
    bigquery_datasets: "BigQuery datasets; read or readwrite access to connected consumers.",
    storage_buckets: "Cloud Storage buckets; read or readwrite access to connected consumers.",
    rdi: "Redis Data Integration (one per deployment): ingests change data from wired Cloud SQL sources into one target Redis database.",
  },
  wiring: {
    note: "Connections are expressed as connect* / vms_connect / RDI source+target fields referencing other components by name. They inject endpoints/credentials at apply time; they do not themselves provision anything.",
    application:
      "connectClusters / connectDatabases / connectLoadBalancers / connectApps / connectStorage / connectPubsub / connectBigquery / connectSql — each injects the named component's endpoint (and, for data services, access) into the app's environment.",
    rdi: "rdi.target must name a database in this deployment (the RDI target). Each rdi.pipelines[].source must name a cloud_sql_instances entry — that Cloud SQL instance is the CDC source and gets cdc_enabled set automatically.",
  },
  safety:
    "Saving a design creates a DRAFT instance and returns a reviewUrl. A human opens it in the wizard to validate and apply. This surface never provisions or destroys.",
} as const;
