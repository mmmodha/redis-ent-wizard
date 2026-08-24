variable "name_prefix" {
  type = string
}

variable "youremail" {
  type = string
}

variable "skip_deletion" {
  type    = bool
  default = false
}

# GKE `owner` is Created by as firstName_lastName (e.g. mehul_modha).
# skip_deletion=yes is opt-in so org cleanup jobs leave these resources.
locals {
  owner_label = var.youremail
  resource_labels = merge(
    { owner = local.owner_label },
    var.skip_deletion ? { skip_deletion = "yes" } : {},
  )
}

variable "region_name" {
  type = string
}

variable "gke_clustersize" {
  type = number
}

variable "gke_machine_type" {
  type = string
}

variable "vpc_name" {
  type = string
}

variable "public_subnet_name" {
  type = string
}

resource "google_container_cluster" "gke" {
  name     = "${var.name_prefix}-gke"
  location = "${var.region_name}-b"

  network    = var.vpc_name
  subnetwork = var.public_subnet_name

  remove_default_node_pool = true
  initial_node_count       = 1
  deletion_protection      = false
  resource_labels          = local.resource_labels

  ip_allocation_policy {
    cluster_secondary_range_name  = "gke-pods"
    services_secondary_range_name = "gke-services"
  }

  maintenance_policy {
    daily_maintenance_window {
      start_time = "01:00"
    }
  }
}

resource "google_container_node_pool" "np" {
  name       = "redis-node-pool"
  cluster    = google_container_cluster.gke.name
  location   = "${var.region_name}-b"
  node_count = var.gke_clustersize

  node_config {
    machine_type = var.gke_machine_type
    labels       = local.resource_labels
    oauth_scopes = [
      "https://www.googleapis.com/auth/cloud-platform",
    ]
  }

  lifecycle {
    create_before_destroy = false
  }
}

output "cluster_name" {
  value = google_container_cluster.gke.name
}

output "cluster_endpoint" {
  value = google_container_cluster.gke.endpoint
}

output "cluster_ca_certificate" {
  value     = google_container_cluster.gke.master_auth[0].cluster_ca_certificate
  sensitive = true
}

output "location" {
  value = google_container_cluster.gke.location
}

output "how_to_kubectl" {
  value = "gcloud container clusters get-credentials ${google_container_cluster.gke.name} --zone ${google_container_cluster.gke.location}"
}
