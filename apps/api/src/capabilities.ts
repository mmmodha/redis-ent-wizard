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
    gke: "Redis Enterprise on GKE via one or more operators. Each operator installs the redis-enterprise-operator Helm chart into its own namespace and owns the clusters (RECs) that reference it. Applications run as Deployments; RDI runs via Helm.",
  },
  required: {
    name: "Short deployment name (becomes the resource prefix).",
    mode: "'vm' or 'gke'.",
    youremail: "Owner id, firstName_lastName (e.g. jane_doe); attributes the deployment.",
  },
  optional_but_recommended: {
    credentialsFile:
      "A GCP credential id/file from list_credentials. Optional on a draft — the human can pick it in the wizard — but set it (with a matching project/region) to make the draft apply-ready. Never invent a placeholder.",
    project: "GCP project id, from the chosen credential or list_projects.",
    region_name: "GCP region, from list_regions.",
    region_zones: "Zone suffixes (e.g. ['b','c','d']) from list_regions for the chosen region.",
  },
  picking_a_target:
    "To produce an apply-ready draft: (1) list_credentials and choose one (prefer a projectId matching the intent); (2) set credentialsFile to its id/file and project to its projectId (or via list_projects); (3) list_regions and set region_name + region_zones. If nothing suitable exists, omit these and tell the human to choose them in the wizard.",
  artifacts:
    "Application artifacts (jars/binaries): for a file already hosted, use artifact kind 'url' (https), 'gcs' (gs://), or 'git' (repo URL) — a reference the wizard fetches at apply time. For a LOCAL file (only when the upload_artifact tool is available, i.e. the local stdio server), call upload_artifact(path, type) and set the app's artifact to { kind: 'upload', ref: <returned id>, type }. Otherwise leave the artifact for the human to attach in the wizard.",
  components: {
    operators:
      "GKE only. Redis Operators, each with a name and its own operator_chart_version (empty/'latest' = latest chart). Each operator installs into its own namespace and owns the clusters that name it via the cluster's `operator` field. A GKE deployment needs at least one operator; omit `operators` entirely and a single default operator is assumed (back-compat).",
    clusters:
      "Redis Enterprise clusters (RECs). Each has a name, node count, machine type, and a list of databases. On GKE, set each cluster's `operator` to the name of the operator that should own it (defaults to the first operator). Start empty and add clusters explicitly.",
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
  collaboration:
    "A human and you can edit the same draft in tandem. save_design creates/replaces a draft; update_design(id, patch) deep-merges a partial config onto an existing draft — send only what you want to change (named arrays like clusters/databases merge by name; omitted items and fields are kept). Human-owned fields a person set (per-cluster license, database passwords incl. the RDI target, per-cluster admin username) are always preserved and cannot be overwritten by a patch. Call get_design first to see the current state.",
  safety:
    "Saving a design creates a DRAFT instance and returns a reviewUrl. A human opens it in the wizard to validate and apply. This surface never provisions or destroys.",
} as const;
