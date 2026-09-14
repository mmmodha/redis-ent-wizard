import fs from "node:fs";
import path from "node:path";
import { normalizeAppDiskGib, normalizeAppMachineTypes, parseAppExtraPorts } from "./app-web.js";
import { normalizeApplications } from "./applications.js";
import { clusterNamePrefix, normalizeClusters } from "./clusters.js";
import { bucketFullName, bucketGrantRole, normalizeStorageBuckets } from "./storage.js";
import { grantsPublisher, grantsSubscriber, normalizePubsub, topicFullName } from "./pubsub.js";
import { resolveGkeOperatorChart } from "./rs-releases.js";
import type { CreateInstanceInput, DeploymentMode } from "./types.js";

const terraformDir =
  process.env.TERRAFORM_DIR || path.resolve(process.cwd(), "../../terraform");

const dataDir = process.env.DATA_DIR || path.resolve(process.cwd(), "../../data");

function escapeTfString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function tfValue(value: unknown): string {
  if (typeof value === "string") return `"${escapeTfString(value)}"`;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(tfValue).join(", ")}]`;
  if (value && typeof value === "object") {
    const body = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k} = ${tfValue(v)}`)
      .join(", ");
    return `{ ${body} }`;
  }
  throw new Error(`Unsupported tfvars value: ${typeof value}`);
}

export function resolveCredentialsPath(credentialsFile: string): string {
  if (path.isAbsolute(credentialsFile) && fs.existsSync(credentialsFile)) {
    return credentialsFile;
  }
  const candidates = [
    credentialsFile,
    path.join(dataDir, "credentials", credentialsFile),
    path.join(dataDir, credentialsFile),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return path.resolve(c);
  }
  throw new Error(`Credentials file not found: ${credentialsFile}`);
}

export function resolveSshPublicKey(): string {
  const configured = process.env.SSH_PUBLIC_KEY_PATH;
  const candidates = [
    configured,
    path.join(process.env.HOME || "", ".ssh/google_compute_engine.pub"),
    "/ssh/google_compute_engine.pub",
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return fs.readFileSync(c, "utf8").trim();
    }
  }
  throw new Error(
    "SSH public key not found. Mount ~/.ssh or set SSH_PUBLIC_KEY_PATH to google_compute_engine.pub",
  );
}

/**
 * Path (not contents) of the SSH private key Terraform uses to copy application
 * artifacts onto VMs. Returned as a path so the key never lands in tfvars.
 */
export function resolveSshPrivateKeyPath(): string {
  const configured = process.env.SSH_PRIVATE_KEY_PATH;
  const fromPublic = process.env.SSH_PUBLIC_KEY_PATH?.replace(/\.pub$/, "");
  const candidates = [
    configured,
    fromPublic,
    "/ssh/google_compute_engine",
    path.join(process.env.HOME || "", ".ssh/google_compute_engine"),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Fall back to the conventional container path even if unreadable at write
  // time; Terraform reads it at apply time inside the API container.
  return "/ssh/google_compute_engine";
}

// Terraform treats an absolute module source as its own package, so a profile
// referenced that way cannot reach ../../modules. Copying the tree in keeps every
// source a local path, and leaves the instance destroyable from the host later.
function portableCredentialsPath(workDir: string, credentialsAbs: string): string {
  const dataAbs = path.resolve(dataDir);
  if (!path.resolve(credentialsAbs).startsWith(dataAbs + path.sep)) return credentialsAbs;
  const rel = path.relative(path.resolve(workDir), path.resolve(credentialsAbs));
  return rel.split(path.sep).join("/");
}

const VENDOR_SKIP = new Set([".terraform", ".terraform.lock.hcl", ".git"]);

function vendorTerraform(workDir: string): string {
  const dest = path.join(workDir, "tf");
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(terraformDir, dest, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      const base = path.basename(src);
      return !VENDOR_SKIP.has(base) && !base.endsWith(".tfstate") && !base.endsWith(".tfstate.backup");
    },
  });
  return dest;
}

// In-cluster namespaces for GKE DNS wiring — must match the Terraform modules.
const GKE_REC_NS = "rec-ns"; // terraform/modules/re-k8s (local.namespace)
const GKE_APP_NS = "apps"; //  terraform/modules/app-k8s (var.namespace default)

/** Uppercased env-var slug from a component name (e.g. "cache-1" -> "CACHE_1"). */
function envSlug(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** A consumer's connection selections, from an app or the Set-of-VMs group. */
interface ConnectSelections {
  connectClusters?: string[];
  connectDatabases?: string[];
  connectLoadBalancers?: string[];
  connectApps?: string[];
  connectStorage?: string[];
  connectPubsub?: string[];
}

/** Static Pub/Sub env values (global, identical for VM and GKE). */
interface PubsubRef {
  topic: string;
  subscription: string;
  project: string;
}
function pubsubEnvMap(input: CreateInstanceInput, prefix: string): Map<string, PubsubRef> {
  const project = input.project || "";
  const m = new Map<string, PubsubRef>();
  for (const t of normalizePubsub(input)) {
    const full = topicFullName(prefix, t.name);
    m.set(t.name, {
      topic: `projects/${project}/topics/${full}`,
      subscription: t.create_subscription ? `projects/${project}/subscriptions/${full}-sub` : "",
      project,
    });
  }
  return m;
}

/** Static env plus the apply-time refs that Terraform resolves in profiles/vm. */
interface ResolvedConnections {
  env: Record<string, string>;
  /** REDIS_<C>_ADMIN_PASSWORD env-var name -> re_vm module index. */
  connectClusterAdmin: Record<string, number>;
  /** LB_<LB>_ENDPOINT env-var name -> load-balancer name. */
  connectLb: Record<string, string>;
}

interface VmRegistry {
  clusterHosts: Map<string, string>;
  clusterIndex: Map<string, number>;
  dbEndpoints: Map<string, string>;
  appHosts: Map<string, string>;
  lbNames: Set<string>;
  /** Bucket slug -> full bucket name (`<prefix>-<slug>`). */
  storageBuckets: Map<string, string>;
  /** Topic slug -> static Pub/Sub env values. */
  pubsub: Map<string, PubsubRef>;
  adminUser: string;
  vmPrefix: string;
  dnsSuffix: string;
  appCount: number;
}

/** Provider registry for VM mode: predicted DNS hosts + apply-time ref keys. */
export function buildVmRegistry(
  input: CreateInstanceInput,
  clusters: ReturnType<typeof normalizeClusters>,
  vmPrefix: string,
  dnsSuffix: string,
): VmRegistry {
  const clusterHosts = new Map<string, string>();
  const clusterIndex = new Map<string, number>();
  const dbEndpoints = new Map<string, string>();
  clusters.forEach((c, i) => {
    const prefix = clusterNamePrefix(vmPrefix, i, c.name);
    const host = `cluster.${prefix}.${dnsSuffix}`;
    const connectName = c.name || `cluster${i + 1}`;
    clusterHosts.set(connectName, host);
    clusterIndex.set(connectName, i);
    if (c.name) {
      clusterHosts.set(c.name, host);
      clusterIndex.set(c.name, i);
    }
    if (i === 0) {
      clusterHosts.set(vmPrefix, host);
      clusterIndex.set(vmPrefix, i);
    }
    for (const db of c.databases || []) {
      const port = db.port ?? 12000;
      dbEndpoints.set(db.name, `redis-${port}.cluster.${prefix}.${dnsSuffix}:${port}`);
    }
  });
  const apps = normalizeApplications({ mode: "vm", applications: input.applications });
  const appHosts = new Map<string, string>();
  for (const a of apps) appHosts.set(a.name, `${a.name}.${vmPrefix}.${dnsSuffix}`);
  const lbNames = new Set<string>((input.load_balancers || []).map((lb) => lb.name));
  const storageBuckets = new Map<string, string>();
  for (const b of normalizeStorageBuckets(input)) storageBuckets.set(b.name, bucketFullName(vmPrefix, b.name));
  return {
    clusterHosts,
    clusterIndex,
    dbEndpoints,
    appHosts,
    lbNames,
    storageBuckets,
    pubsub: pubsubEnvMap(input, vmPrefix),
    adminUser: input.RS_admin || "admin@redis.io",
    vmPrefix,
    dnsSuffix,
    appCount: input.app ?? 0,
  };
}

/** Resolve one consumer's connections against the VM registry. */
export function resolveVmConnections(sel: ConnectSelections, reg: VmRegistry): ResolvedConnections {
  const env: Record<string, string> = {};
  const connectClusterAdmin: Record<string, number> = {};
  const connectLb: Record<string, string> = {};

  (sel.connectClusters || []).filter(Boolean).forEach((name, i) => {
    const host = reg.clusterHosts.get(name);
    if (host === undefined) return;
    const slug = envSlug(name);
    env[`REDIS_${slug}_HOST`] = host;
    env[`REDIS_${slug}_ADMIN_USER`] = reg.adminUser;
    if (i === 0) env.REDIS_HOST = host;
    const idx = reg.clusterIndex.get(name);
    if (idx !== undefined) connectClusterAdmin[`REDIS_${slug}_ADMIN_PASSWORD`] = idx;
  });

  for (const db of (sel.connectDatabases || []).filter(Boolean)) {
    const endpoint = reg.dbEndpoints.get(db);
    if (endpoint) env[`REDIS_${envSlug(db)}_ENDPOINT`] = endpoint;
  }

  for (const name of (sel.connectApps || []).filter(Boolean)) {
    // Known application name, otherwise the single Set-of-VMs group ("app.<prefix>").
    const host =
      reg.appHosts.get(name) ?? (reg.appCount > 0 ? `app.${reg.vmPrefix}.${reg.dnsSuffix}` : undefined);
    if (host) env[`${envSlug(name)}_HOST`] = host;
  }

  for (const lb of (sel.connectLoadBalancers || []).filter(Boolean)) {
    if (reg.lbNames.has(lb)) connectLb[`LB_${envSlug(lb)}_ENDPOINT`] = lb;
  }

  for (const bucket of (sel.connectStorage || []).filter(Boolean)) {
    const full = reg.storageBuckets.get(bucket);
    if (full) {
      const slug = envSlug(bucket);
      env[`GCS_${slug}_BUCKET`] = full;
      env[`GCS_${slug}_URL`] = `gs://${full}`;
    }
  }

  injectPubsubEnv(env, sel.connectPubsub, reg.pubsub);

  return { env, connectClusterAdmin, connectLb };
}

/** Shared Pub/Sub env injection (VM and GKE produce identical values). */
function injectPubsubEnv(
  env: Record<string, string>,
  connectPubsub: string[] | undefined,
  pubsub: Map<string, PubsubRef>,
): void {
  for (const p of (connectPubsub || []).filter(Boolean)) {
    const ref = pubsub.get(p);
    if (!ref) continue;
    const slug = envSlug(p);
    env[`PUBSUB_${slug}_TOPIC`] = ref.topic;
    if (ref.subscription) env[`PUBSUB_${slug}_SUBSCRIPTION`] = ref.subscription;
    env[`PUBSUB_${slug}_PROJECT`] = ref.project;
  }
}

function buildVmApplications(input: CreateInstanceInput, reg: VmRegistry): Record<string, unknown>[] {
  const apps = normalizeApplications({ mode: "vm", applications: input.applications });
  return apps.map((app) => {
    const conn = resolveVmConnections(app, reg);
    return {
      name: app.name,
      artifact_local_path: app.artifactLocalPath || "",
      artifact_type: app.artifact?.type || "binary",
      artifact_filename: app.artifactFilename || (app.artifact?.type === "jar" ? "app.jar" : "app"),
      git_url: app.artifact?.kind === "git" ? app.artifact.ref : "",
      git_ref: app.artifact?.kind === "git" ? app.artifact.branch || "" : "",
      command: app.command || "",
      vm_count: app.vm_count ?? 1,
      machine_type: app.machine_type || "e2-standard-2",
      disk_gib: app.disk_gib ?? 0,
      ports: app.ports || [],
      env: { ...(app.env || {}), ...conn.env },
      connect_cluster_admin: conn.connectClusterAdmin,
      connect_lb: conn.connectLb,
      expose_http: app.expose === "http" || app.expose === "lb",
      expose_https: app.expose === "https" || app.expose === "lb",
      requirements: app.requirements || [],
    };
  });
}

/** Connections for the single Set-of-VMs group (app_vm), from input.vms_connect. */
function buildVmSetConnections(input: CreateInstanceInput, reg: VmRegistry): ResolvedConnections {
  const vc = input.vms_connect || {};
  return resolveVmConnections(
    {
      connectClusters: vc.clusters,
      connectDatabases: vc.databases,
      connectLoadBalancers: vc.load_balancers,
      connectApps: vc.apps,
      connectStorage: vc.storage,
      connectPubsub: vc.pubsub,
    },
    reg,
  );
}

/** Topic short-names that at least one consumer connects to. */
function connectedPubsubNames(input: CreateInstanceInput): Set<string> {
  const set = new Set<string>();
  for (const a of input.applications || []) for (const p of a.connectPubsub || []) set.add(String(p));
  for (const p of input.vms_connect?.pubsub || []) set.add(String(p));
  return set;
}

/** tfvars for the shared pubsub module; grants set only for connected topics. */
function buildPubsub(input: CreateInstanceInput, prefix: string): Record<string, unknown>[] {
  const connected = connectedPubsubNames(input);
  return normalizePubsub(input).map((t) => ({
    name: topicFullName(prefix, t.name),
    create_subscription: t.create_subscription,
    grant_publisher: connected.has(t.name) && grantsPublisher(t.role),
    grant_subscriber: connected.has(t.name) && grantsSubscriber(t.role),
  }));
}

function buildLoadBalancers(input: CreateInstanceInput): Record<string, unknown>[] {
  const lbs = Array.isArray(input.load_balancers) ? input.load_balancers : [];
  return lbs.map((lb) => ({
    name: lb.name,
    target: lb.target,
    target_kind: lb.target_kind === "vms" ? "vms" : "application",
    ports: Array.isArray(lb.ports) ? lb.ports : [],
  }));
}

/** Bucket short-names that at least one consumer (app or Set-of-VMs) connects to. */
function connectedStorageNames(input: CreateInstanceInput): Set<string> {
  const set = new Set<string>();
  for (const a of input.applications || []) for (const s of a.connectStorage || []) set.add(String(s));
  for (const s of input.vms_connect?.storage || []) set.add(String(s));
  return set;
}

/** tfvars for the shared storage module; `grant_role` set only for connected buckets. */
function buildStorageBuckets(input: CreateInstanceInput, prefix: string): Record<string, unknown>[] {
  const connected = connectedStorageNames(input);
  const defaultLocation = input.region_name || "europe-west1";
  return normalizeStorageBuckets(input).map((b) => ({
    name: bucketFullName(prefix, b.name),
    location: b.location || defaultLocation,
    storage_class: b.storage_class,
    versioning: b.versioning,
    force_destroy: b.force_destroy,
    grant_role: connected.has(b.name) ? bucketGrantRole(b.access) : "",
  }));
}

interface GkeSecretRef {
  name: string;
  secret: string;
  key: string;
}

/** Resolve GKE connections to in-cluster DNS; admin creds via optional secretKeyRef. */
export function resolveGkeConnections(
  sel: ConnectSelections,
  clusters: ReturnType<typeof normalizeClusters>,
  prefix: string,
  apps: string[],
  storageBuckets: Map<string, string> = new Map(),
  pubsub: Map<string, PubsubRef> = new Map(),
): { env: Record<string, string>; secretRefs: GkeSecretRef[] } {
  const env: Record<string, string> = {};
  const secretRefs: GkeSecretRef[] = [];

  const clusterHost = new Map<string, string>();
  const clusterSecret = new Map<string, string>();
  const dbEndpoints = new Map<string, string>();
  clusters.forEach((c, i) => {
    const recName = `${clusterNamePrefix(prefix, i, c.name)}-rec`;
    const connectName = c.name || `cluster${i + 1}`;
    const host = `${recName}.${GKE_REC_NS}.svc.cluster.local`;
    clusterHost.set(connectName, host);
    clusterSecret.set(connectName, recName);
    if (c.name) {
      clusterHost.set(c.name, host);
      clusterSecret.set(c.name, recName);
    }
    for (const db of c.databases || []) {
      const port = db.port ?? 12000;
      dbEndpoints.set(db.name, `${db.name}.${GKE_REC_NS}.svc.cluster.local:${port}`);
    }
  });

  (sel.connectClusters || []).filter(Boolean).forEach((name, i) => {
    const host = clusterHost.get(name);
    if (host === undefined) return;
    const slug = envSlug(name);
    env[`REDIS_${slug}_HOST`] = host;
    if (i === 0) env.REDIS_HOST = host;
    const secret = clusterSecret.get(name);
    if (secret) {
      // The redis-enterprise operator stores REC credentials in a secret named
      // after the REC; optional so a name/key mismatch never blocks the pod.
      secretRefs.push({ name: `REDIS_${slug}_ADMIN_USER`, secret, key: "username" });
      secretRefs.push({ name: `REDIS_${slug}_ADMIN_PASSWORD`, secret, key: "password" });
    }
  });

  for (const db of (sel.connectDatabases || []).filter(Boolean)) {
    const endpoint = dbEndpoints.get(db);
    if (endpoint) env[`REDIS_${envSlug(db)}_ENDPOINT`] = endpoint;
  }

  const appSet = new Set(apps);
  for (const name of (sel.connectApps || []).filter(Boolean)) {
    if (appSet.has(name)) env[`${envSlug(name)}_HOST`] = `${name}.${GKE_APP_NS}.svc.cluster.local`;
  }

  for (const bucket of (sel.connectStorage || []).filter(Boolean)) {
    const full = storageBuckets.get(bucket);
    if (full) {
      const slug = envSlug(bucket);
      env[`GCS_${slug}_BUCKET`] = full;
      env[`GCS_${slug}_URL`] = `gs://${full}`;
    }
  }

  injectPubsubEnv(env, sel.connectPubsub, pubsub);

  return { env, secretRefs };
}

function buildGkeApplications(input: CreateInstanceInput): Record<string, unknown>[] {
  const apps = normalizeApplications({ mode: "gke", applications: input.applications });
  const clusters = normalizeClusters({ ...input, mode: "gke" });
  const prefix = `${input.name}-${input.env || "default"}`;
  const appNames = apps.map((a) => a.name);
  const storageBuckets = new Map<string, string>();
  for (const b of normalizeStorageBuckets(input)) storageBuckets.set(b.name, bucketFullName(prefix, b.name));
  const pubsub = pubsubEnvMap(input, prefix);
  return apps.map((app) => {
    const conn = resolveGkeConnections(app, clusters, prefix, appNames, storageBuckets, pubsub);
    return {
      name: app.name,
      image: app.image || "",
      command: app.command || "",
      replicas: app.replicas ?? 1,
      ports: app.ports || [],
      env: { ...(app.env || {}), ...conn.env },
      env_secret_refs: conn.secretRefs.map((r) => ({
        name: r.name,
        secret_name: r.secret,
        secret_key: r.key,
      })),
      expose: app.expose || "none",
    };
  });
}

export function vmStackModuleArguments(): string {
  return `
  clustersize      = var.clustersize
  redis_enabled    = var.redis_enabled
  machine_type     = var.machine_type
  RS_release       = var.RS_release
  clusters         = var.clusters
  RS_admin         = var.RS_admin
  app              = var.app
  app_machine_types = var.app_machine_types
  memviz_enabled   = var.memviz_enabled
  memviz_port      = var.memviz_port
  app_expose_http  = var.app_expose_http
  app_expose_https = var.app_expose_https
  app_disk_gib     = var.app_disk_gib
  app_extra_ports  = var.app_extra_ports
  rof_nvme_disks   = var.rof_nvme_disks
  region_zones     = var.region_zones
  ssh_public_key   = var.ssh_public_key
  ssh_private_key_path = var.ssh_private_key_path
  applications     = var.applications
  load_balancers   = var.load_balancers
  storage_buckets  = var.storage_buckets
  pubsub_topics    = var.pubsub_topics
  app_injected_env = var.app_injected_env
  app_connect_cluster_admin = var.app_connect_cluster_admin
  app_connect_lb   = var.app_connect_lb
`;
}

export function writeInstanceWorkspace(
  workDir: string,
  mode: DeploymentMode,
  input: CreateInstanceInput,
  credentialsAbs: string,
): void {
  fs.mkdirSync(workDir, { recursive: true });

  vendorTerraform(workDir);
  const profileSource = `./tf/profiles/${mode}`;
  const sshKey = mode === "vm" ? resolveSshPublicKey() : "";

  const rootTf = `terraform {
  required_version = ">= 1.5.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 4.47.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.4.3"
    }
    null = {
      source  = "hashicorp/null"
      version = ">= 3.2.0"
    }
  }
  backend "local" {
    path = "terraform.tfstate"
  }
}

provider "google" {
  project     = var.project
  credentials = var.credentials
}

module "stack" {
  source = "${escapeTfString(profileSource)}"

  yourname     = var.yourname
  youremail    = var.youremail
  skip_deletion = var.skip_deletion
  credentials  = var.credentials
  project      = var.project
  env          = var.env
  region_name  = var.region_name
  dns_managed_zone  = var.dns_managed_zone
  dns_zone_dns_name = var.dns_zone_dns_name
  rs_private_subnet = var.rs_private_subnet
  rs_public_subnet  = var.rs_public_subnet
${
  mode === "vm"
    ? vmStackModuleArguments()
    : `
  gke_clustersize          = var.gke_clustersize
  gke_machine_type         = var.gke_machine_type
  rec_nodes                = var.rec_nodes
  rec_specs                = var.rec_specs
  operator_chart_version   = var.operator_chart_version
  outputs_dir              = var.outputs_dir
  applications             = var.applications
  storage_buckets          = var.storage_buckets
  pubsub_topics            = var.pubsub_topics
`
}
}

${
  mode === "vm"
    ? `
output "rs_ui_dns" { value = module.stack.rs_ui_dns }
output "rs_ui_ip" { value = module.stack.rs_ui_ip }
output "rs_cluster_dns" { value = module.stack.rs_cluster_dns }
output "nodes_ip" { value = module.stack.nodes_ip }
output "nodes_dns" { value = module.stack.nodes_dns }
output "admin_username" { value = module.stack.admin_username }
output "admin_password" {
  value     = module.stack.admin_password
  sensitive = true
}
output "how_to_ssh" { value = module.stack.how_to_ssh }
output "app_names" { value = module.stack.app_names }
output "app_machine_types" { value = module.stack.app_machine_types }
output "app_ips" { value = module.stack.app_ips }
output "app_dns" { value = module.stack.app_dns }
output "how_to_ssh_to_app" { value = module.stack.how_to_ssh_to_app }
output "apps" { value = module.stack.apps }
output "memviz_url" { value = module.stack.memviz_url }
output "app_http_url" { value = module.stack.app_http_url }
output "app_https_url" { value = module.stack.app_https_url }
output "clusters" {
  value     = module.stack.clusters
  sensitive = true
}
output "app_workloads" { value = module.stack.app_workloads }
output "load_balancers" { value = module.stack.load_balancers }
output "storage_buckets" { value = module.stack.storage_buckets }
output "pubsub_topics" { value = module.stack.pubsub_topics }
output "deployment_mode" { value = module.stack.deployment_mode }
`
    : `
output "how_to_kubectl" { value = module.stack.how_to_kubectl }
output "gke_cluster_name" { value = module.stack.gke_cluster_name }
output "gke_cluster_endpoint" { value = module.stack.gke_cluster_endpoint }
output "rec_name" { value = module.stack.rec_name }
output "rec_names" { value = module.stack.rec_names }
output "rec_namespace" { value = module.stack.rec_namespace }
output "k8s_outputs_file" { value = module.stack.k8s_outputs_file }
output "app_outputs_file" { value = module.stack.app_outputs_file }
output "storage_buckets" { value = module.stack.storage_buckets }
output "pubsub_topics" { value = module.stack.pubsub_topics }
output "deployment_mode" { value = module.stack.deployment_mode }
`
}
`;

  const varsTf =
    mode === "vm"
      ? `
variable "yourname" { type = string }
variable "youremail" { type = string }
variable "skip_deletion" { type = bool }
variable "credentials" { type = string }
variable "project" { type = string }
variable "env" { type = string }
variable "region_name" { type = string }
variable "clustersize" { type = number }
variable "redis_enabled" { type = bool }
variable "machine_type" { type = string }
variable "RS_release" { type = string }
variable "clusters" {
  type = list(object({
    name           = optional(string, "")
    nodes          = number
    machine_type   = string
    rof_nvme_disks = number
    RS_release     = string
  }))
}
variable "RS_admin" { type = string }
variable "app" { type = number }
variable "app_machine_types" { type = list(string) }
variable "memviz_enabled" { type = bool }
variable "memviz_port" { type = number }
variable "app_expose_http" { type = bool }
variable "app_expose_https" { type = bool }
variable "app_disk_gib" { type = list(number) }
variable "app_extra_ports" { type = list(number) }
variable "rof_nvme_disks" { type = number }
variable "dns_managed_zone" { type = string }
variable "dns_zone_dns_name" { type = string }
variable "rs_private_subnet" { type = string }
variable "rs_public_subnet" { type = string }
variable "region_zones" { type = list(string) }
variable "ssh_public_key" { type = string }
variable "ssh_private_key_path" { type = string }
variable "applications" {
  type = list(object({
    name                  = string
    artifact_local_path   = string
    artifact_type         = string
    artifact_filename     = string
    git_url               = string
    git_ref               = string
    command               = string
    vm_count              = number
    machine_type          = string
    disk_gib              = number
    ports                 = list(number)
    env                   = map(string)
    connect_cluster_admin = map(number)
    connect_lb            = map(string)
    expose_http           = bool
    expose_https          = bool
    requirements          = list(string)
  }))
  default = []
}
variable "load_balancers" {
  type = list(object({
    name        = string
    target      = string
    target_kind = string
    ports       = list(number)
  }))
  default = []
}
variable "app_injected_env" {
  type    = map(string)
  default = {}
}
variable "app_connect_cluster_admin" {
  type    = map(number)
  default = {}
}
variable "app_connect_lb" {
  type    = map(string)
  default = {}
}
variable "storage_buckets" {
  type = list(object({
    name          = string
    location      = string
    storage_class = string
    versioning    = bool
    force_destroy = bool
    grant_role    = string
  }))
  default = []
}
variable "pubsub_topics" {
  type = list(object({
    name                = string
    create_subscription = bool
    grant_publisher     = bool
    grant_subscriber    = bool
  }))
  default = []
}
`
      : `
variable "yourname" { type = string }
variable "youremail" { type = string }
variable "skip_deletion" { type = bool }
variable "credentials" { type = string }
variable "project" { type = string }
variable "env" { type = string }
variable "region_name" { type = string }
variable "gke_clustersize" { type = number }
variable "gke_machine_type" { type = string }
variable "rec_nodes" { type = number }
variable "rec_specs" {
  type = list(object({
    name  = string
    nodes = number
  }))
}
variable "operator_chart_version" { type = string }
variable "dns_managed_zone" { type = string }
variable "dns_zone_dns_name" { type = string }
variable "rs_private_subnet" { type = string }
variable "rs_public_subnet" { type = string }
variable "outputs_dir" { type = string }
variable "applications" {
  type = list(object({
    name     = string
    image    = string
    command  = string
    replicas = number
    ports    = list(number)
    env      = map(string)
    env_secret_refs = list(object({
      name        = string
      secret_name = string
      secret_key  = string
    }))
    expose = string
  }))
  default = []
}
variable "storage_buckets" {
  type = list(object({
    name          = string
    location      = string
    storage_class = string
    versioning    = bool
    force_destroy = bool
    grant_role    = string
  }))
  default = []
}
variable "pubsub_topics" {
  type = list(object({
    name                = string
    create_subscription = bool
    grant_publisher     = bool
    grant_subscriber    = bool
  }))
  default = []
}
`;

  const tfvars: Record<string, unknown> = {
    yourname: input.name,
    youremail: input.youremail,
    skip_deletion: input.skip_deletion ?? true,
    // Relative so the same workspace authenticates from inside the container
    // (/data/...) and from the host when the teardown scripts run it.
    credentials: portableCredentialsPath(workDir, credentialsAbs),
    project: input.project,
    env: input.env || "default",
    region_name: input.region_name || "europe-west1",
    dns_managed_zone: input.dns_managed_zone || "demo-clusters",
    dns_zone_dns_name: input.dns_zone_dns_name || "demo.redislabs.com",
    rs_private_subnet: input.rs_private_subnet || "10.26.1.0/24",
    rs_public_subnet: input.rs_public_subnet || "10.26.2.0/24",
  };

  if (mode === "vm") {
    const clusters = normalizeClusters(input);
    const first = clusters[0];
    Object.assign(tfvars, {
      redis_enabled: clusters.length > 0,
      clustersize: first?.nodes ?? 0,
      machine_type: first?.machine_type || input.machine_type || "e2-standard-2",
      RS_release: first?.RS_release || input.RS_release || "",
      clusters: clusters.map((c) => ({
        name: c.name,
        nodes: c.nodes,
        machine_type: c.machine_type,
        rof_nvme_disks: c.rof_nvme_disks,
        RS_release: c.RS_release,
      })),
      RS_admin: input.RS_admin || "admin@redis.io",
      app: input.app ?? 0,
      app_machine_types: normalizeAppMachineTypes({
        app: input.app ?? 0,
        app_machine_types: input.app_machine_types,
        app_machine_type: input.app_machine_type,
      }),
      memviz_enabled: input.memviz_enabled ?? false,
      memviz_port: input.memviz_port ?? 3000,
      app_expose_http: (input.app ?? 0) > 0 && Boolean(input.app_expose_http),
      app_expose_https: (input.app ?? 0) > 0 && Boolean(input.app_expose_https),
      app_disk_gib: normalizeAppDiskGib({
        app: input.app ?? 0,
        app_disk_gib: input.app_disk_gib,
      }),
      app_extra_ports: (input.app ?? 0) > 0 ? parseAppExtraPorts(input.app_extra_ports) : [],
      rof_nvme_disks: first?.rof_nvme_disks ?? 0,
      region_zones: input.region_zones || ["b", "c", "d"],
      ssh_public_key: sshKey,
      ssh_private_key_path: resolveSshPrivateKeyPath(),
    });
    const vmPrefix = `${input.name}-${input.env || "default"}`;
    const dnsSuffix = String(tfvars.dns_zone_dns_name);
    const registry = buildVmRegistry(input, clusters, vmPrefix, dnsSuffix);
    tfvars.applications = buildVmApplications(input, registry);
    tfvars.load_balancers = buildLoadBalancers(input);
    // Connections for the Set-of-VMs group (app_vm); TF fills in admin pw + LB VIP.
    const vmsConn = buildVmSetConnections(input, registry);
    tfvars.app_injected_env = vmsConn.env;
    tfvars.app_connect_cluster_admin = vmsConn.connectClusterAdmin;
    tfvars.app_connect_lb = vmsConn.connectLb;
    tfvars.storage_buckets = buildStorageBuckets(input, vmPrefix);
    tfvars.pubsub_topics = buildPubsub(input, vmPrefix);
  } else {
    const clusters = normalizeClusters({ ...input, mode: "gke" });
    const prefix = `${input.name}-${input.env || "default"}`;
    Object.assign(tfvars, {
      gke_clustersize: input.gke_clustersize ?? 3,
      gke_machine_type: input.gke_machine_type || "e2-standard-8",
      rec_nodes: clusters[0].rec_nodes,
      rec_specs: clusters.map((c, i) => ({
        name: `${clusterNamePrefix(prefix, i, c.name)}-rec`,
        nodes: c.rec_nodes,
      })),
      operator_chart_version: resolveGkeOperatorChart(input.operator_chart_version),
      outputs_dir: workDir,
    });
    tfvars.applications = buildGkeApplications(input);
    tfvars.storage_buckets = buildStorageBuckets(input, prefix);
    tfvars.pubsub_topics = buildPubsub(input, prefix);
  }

  const tfvarsBody = Object.entries(tfvars)
    .map(([k, v]) => `${k} = ${tfValue(v)}`)
    .join("\n");

  fs.writeFileSync(path.join(workDir, "main.tf"), rootTf, "utf8");
  fs.writeFileSync(path.join(workDir, "variables.tf"), varsTf, "utf8");
  fs.writeFileSync(path.join(workDir, "terraform.tfvars"), tfvarsBody + "\n", "utf8");
}
