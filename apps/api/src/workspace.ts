import fs from "node:fs";
import path from "node:path";
import { normalizeAppDiskGib, normalizeAppMachineTypes, parseAppExtraPorts } from "./app-web.js";
import { clusterNamePrefix, normalizeClusters } from "./clusters.js";
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
    ? `
  clustersize      = var.clustersize
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
`
    : `
  gke_clustersize          = var.gke_clustersize
  gke_machine_type         = var.gke_machine_type
  rec_nodes                = var.rec_nodes
  rec_specs                = var.rec_specs
  operator_chart_version   = var.operator_chart_version
  outputs_dir              = var.outputs_dir
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
      clustersize: first.nodes,
      machine_type: first.machine_type,
      RS_release: first.RS_release,
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
      rof_nvme_disks: first.rof_nvme_disks,
      region_zones: input.region_zones || ["b", "c", "d"],
      ssh_public_key: sshKey,
    });
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
  }

  const tfvarsBody = Object.entries(tfvars)
    .map(([k, v]) => `${k} = ${tfValue(v)}`)
    .join("\n");

  fs.writeFileSync(path.join(workDir, "main.tf"), rootTf, "utf8");
  fs.writeFileSync(path.join(workDir, "variables.tf"), varsTf, "utf8");
  fs.writeFileSync(path.join(workDir, "terraform.tfvars"), tfvarsBody + "\n", "utf8");
}
