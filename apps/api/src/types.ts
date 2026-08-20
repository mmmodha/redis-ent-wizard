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
}

export interface CreateInstanceInput {
  name: string;
  mode: DeploymentMode;
  youremail: string;
  /** When true, GCP resources get skip_deletion=yes. */
  skip_deletion?: boolean;
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
  }>;
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
