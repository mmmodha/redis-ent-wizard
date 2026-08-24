variable "yourname" {
  type = string
}

variable "youremail" {
  type        = string
  description = "Created by in firstName_lastName form (e.g. mehul_modha); GCP owner label."

  validation {
    condition     = can(regex("^[a-z][a-z0-9]*_[a-z][a-z0-9]*$", var.youremail))
    error_message = "youremail (Created by) must be firstName_lastName, e.g. mehul_modha."
  }
}

variable "skip_deletion" {
  type        = bool
  default     = false
  description = "If true, GCP resources get skip_deletion=yes so org cleanup jobs leave them."
}

variable "credentials" {
  type = string
}

variable "project" {
  type = string
}

variable "clustersize" {
  type    = number
  default = 3
}

variable "RS_release" {
  type    = string
  default = "https://s3.amazonaws.com/redis-enterprise-software-downloads/8.2.0/redislabs-8.2.0-46-jammy-amd64.tar"
}

variable "machine_type" {
  type    = string
  default = "e2-standard-2"
}

variable "env" {
  type    = string
  default = "default"
}

variable "RS_admin" {
  type    = string
  default = "admin@redis.io"
}

variable "region_name" {
  type    = string
  default = "europe-west1"
}

variable "rof_nvme_disks" {
  type    = number
  default = 0
}

variable "app" {
  type    = number
  default = 0
}

variable "app_machine_types" {
  type    = list(string)
  default = []
}

variable "memviz_enabled" {
  type    = bool
  default = false
}

variable "app_expose_http" {
  type    = bool
  default = false
}

variable "app_expose_https" {
  type    = bool
  default = false
}

variable "app_disk_gib" {
  type        = list(number)
  description = "Extra persistent disk GiB per App VM (0 = boot disk only)"
  default     = []
}

variable "app_extra_ports" {
  type        = list(number)
  description = "Additional TCP ports to open on App VMs from the internet"
  default     = []
}

variable "memviz_port" {
  type    = number
  default = 3000
}

variable "memviz_repo_url" {
  type    = string
  default = "https://github.com/itay-ct/memviz.git"
}

variable "memviz_repo_ref" {
  type    = string
  default = "main"
}

variable "dns_managed_zone" {
  type    = string
  default = "demo-clusters"
}

variable "dns_zone_dns_name" {
  type    = string
  default = "demo.redislabs.com"
}

variable "rs_private_subnet" {
  type    = string
  default = "10.26.1.0/24"
}

variable "rs_public_subnet" {
  type    = string
  default = "10.26.2.0/24"
}

variable "region_zones" {
  type    = list(string)
  default = ["b", "c", "d"]
}

variable "ssh_public_key" {
  type = string
}

variable "clusters" {
  type = list(object({
    name           = optional(string, "")
    nodes          = number
    machine_type   = string
    rof_nvme_disks = number
    RS_release     = string
  }))
  description = "Redis clusters in this deployment. Empty falls back to the legacy single-cluster variables."
  default     = []
}

variable "ssh_private_key_path" {
  type        = string
  description = "Path to the SSH private key used to copy application artifacts to VMs."
  default     = "~/.ssh/google_compute_engine"
}

variable "applications" {
  type = list(object({
    name                = string
    artifact_local_path = string
    artifact_type       = string
    artifact_filename   = string
    command             = string
    vm_count            = number
    machine_type        = string
    disk_gib            = number
    ports               = list(number)
    env                 = map(string)
    expose_http         = bool
    expose_https        = bool
    requirements        = list(string)
  }))
  description = "Custom application workloads run on dedicated VMs."
  default     = []
}

variable "load_balancers" {
  type = list(object({
    name        = string
    target      = string # application name, or "app" for the Set-of-VMs group
    target_kind = string # "application" | "vms"
    ports       = list(number)
  }))
  description = "Regional internal TCP passthrough load balancers fronting app VMs."
  default     = []
}
