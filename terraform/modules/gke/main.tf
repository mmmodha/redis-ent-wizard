variable "name_prefix" {
  type = string
}

variable "youremail" {
  type = string
}

# Kubernetes node labels reject '@', so an owner email must be normalised.
locals {
  owner_label = substr(replace(lower(var.youremail), "/[^a-z0-9_-]+/", "-"), 0, 63)
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
    labels = {
      owner         = local.owner_label
      skip_deletion = "yes"
    }
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
