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

variable "env" {
  type    = string
  default = "default"
}

variable "region_name" {
  type    = string
  default = "europe-west1"
}

variable "gke_clustersize" {
  type    = number
  default = 3
}

variable "gke_machine_type" {
  type    = string
  default = "e2-standard-8"
}

variable "rec_nodes" {
  type    = number
  default = 3
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

variable "outputs_dir" {
  type = string
}

variable "operator_chart_version" {
  type    = string
  default = ""
}

variable "rec_specs" {
  type = list(object({
    name  = string
    nodes = number
  }))
  default = []
}

variable "applications" {
  type = list(object({
    name     = string
    image    = string
    command  = string
    replicas = number
    ports    = list(number)
    env      = map(string)
    expose   = string
  }))
  description = "Custom application workloads deployed as containers on GKE."
  default     = []
}
