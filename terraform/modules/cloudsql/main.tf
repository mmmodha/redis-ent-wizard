variable "instances" {
  type = list(object({
    name             = string
    database_version = string
    tier             = string
    db_name          = string
    db_user          = string
    connectivity     = string # "private" | "proxy" | "public"
    grant_client     = bool
  }))
  description = "Cloud SQL instances to create."
  default     = []
}

variable "region" {
  type = string
}

variable "vpc_id" {
  type        = string
  description = "VPC self-link/id for private-IP peering."
}

variable "compute_sa_email" {
  type        = string
  description = "Default compute service account granted cloudsql.client when connected."
}

variable "youremail" {
  type    = string
  default = ""
}

locals {
  by_name       = { for s in var.instances : s.name => s }
  needs_private = anytrue([for s in var.instances : s.connectivity == "private"])
  needs_client  = anytrue([for s in var.instances : s.grant_client])
  labels        = var.youremail != "" ? { created_by = var.youremail } : {}
}

resource "random_password" "pw" {
  for_each = local.by_name

  length  = 20
  special = false
}

# Private Services Access peering for private-IP instances (once per VPC).
resource "google_compute_global_address" "private_ip" {
  count = local.needs_private ? 1 : 0

  name          = "cloudsql-psa-${substr(md5(var.vpc_id), 0, 8)}"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = var.vpc_id
}

resource "google_service_networking_connection" "private" {
  count = local.needs_private ? 1 : 0

  network                 = var.vpc_id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_ip[0].name]
}

resource "google_sql_database_instance" "instance" {
  for_each = local.by_name

  name                = each.value.name
  region              = var.region
  database_version    = each.value.database_version
  deletion_protection = false

  depends_on = [google_service_networking_connection.private]

  settings {
    tier            = each.value.tier
    user_labels     = local.labels
    disk_autoresize = true

    ip_configuration {
      ipv4_enabled    = each.value.connectivity != "private"
      private_network = each.value.connectivity == "private" ? var.vpc_id : null

      dynamic "authorized_networks" {
        for_each = each.value.connectivity == "public" ? [1] : []
        content {
          name  = "all"
          value = "0.0.0.0/0"
        }
      }
    }
  }
}

resource "google_sql_database" "db" {
  for_each = local.by_name

  name     = each.value.db_name
  instance = google_sql_database_instance.instance[each.key].name
}

resource "google_sql_user" "user" {
  for_each = local.by_name

  name     = each.value.db_user
  instance = google_sql_database_instance.instance[each.key].name
  password = random_password.pw[each.key].result
}

# cloudsql.client to the shared compute SA (one binding) when any instance is connected.
resource "google_project_iam_member" "client" {
  count = local.needs_client ? 1 : 0

  project = google_sql_database_instance.instance[keys(local.by_name)[0]].project
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${var.compute_sa_email}"
}

output "hosts" {
  value = {
    for k, i in google_sql_database_instance.instance :
    k => (local.by_name[k].connectivity == "private" ? i.private_ip_address : i.public_ip_address)
  }
}

output "passwords" {
  value     = { for k, r in random_password.pw : k => r.result }
  sensitive = true
}

output "instances" {
  value = [
    for k, i in google_sql_database_instance.instance : {
      name            = i.name
      connection_name = i.connection_name
      connectivity    = local.by_name[k].connectivity
    }
  ]
}
