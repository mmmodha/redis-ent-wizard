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
    env_secret_refs = list(object({
      name        = string
      secret_name = string
      secret_key  = string
    }))
    expose = string
  }))
  description = "Custom application workloads deployed as containers on GKE."
  default     = []
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
  description = "Cloud Storage buckets provisioned for this deployment."
  default     = []
}

variable "pubsub_topics" {
  type = list(object({
    name                = string
    create_subscription = bool
    grant_publisher     = bool
    grant_subscriber    = bool
  }))
  description = "Pub/Sub topics provisioned for this deployment."
  default     = []
}

variable "bigquery_datasets" {
  type = list(object({
    name          = string
    location      = string
    grant_role    = string
    grant_jobuser = bool
  }))
  description = "BigQuery datasets provisioned for this deployment."
  default     = []
}

variable "cloud_sql_instances" {
  type = list(object({
    name             = string
    database_version = string
    tier             = string
    db_name          = string
    db_user          = string
    connectivity     = string
    grant_client     = bool
  }))
  description = "Cloud SQL instances provisioned for this deployment."
  default     = []
}
