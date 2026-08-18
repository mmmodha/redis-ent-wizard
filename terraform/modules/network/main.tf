variable "name_prefix" {
  type = string
}

variable "region_name" {
  type = string
}

variable "rs_private_subnet" {
  type = string
}

variable "rs_public_subnet" {
  type = string
}

variable "memviz_enabled" {
  type    = bool
  default = false
}

variable "memviz_port" {
  type    = number
  default = 3000
}

variable "app_count" {
  type    = number
  default = 0
}

variable "app_expose_http" {
  type    = bool
  default = false
}

variable "app_expose_https" {
  type    = bool
  default = false
}

resource "google_compute_network" "vpc" {
  name                    = "${var.name_prefix}-vpc"
  auto_create_subnetworks = false
  routing_mode            = "GLOBAL"
}

resource "google_compute_subnetwork" "public_subnet" {
  name          = "${var.name_prefix}-pub-net"
  ip_cidr_range = var.rs_public_subnet
  network       = google_compute_network.vpc.id
  region        = var.region_name

  secondary_ip_range {
    range_name    = "gke-pods"
    ip_cidr_range = "192.168.10.0/24"
  }

  secondary_ip_range {
    range_name    = "gke-services"
    ip_cidr_range = "192.168.11.0/24"
  }
}

resource "google_compute_subnetwork" "private_subnet" {
  name          = "${var.name_prefix}-pri-net"
  ip_cidr_range = var.rs_private_subnet
  network       = google_compute_network.vpc.id
  region        = var.region_name
}

resource "google_compute_firewall" "allow_internal" {
  name    = "${var.name_prefix}-fw-allow-internal"
  network = google_compute_network.vpc.name

  allow {
    protocol = "icmp"
  }

  allow {
    protocol = "tcp"
    ports    = ["0-65535"]
  }

  allow {
    protocol = "udp"
    ports    = ["0-65535"]
  }

  source_ranges = [
    var.rs_private_subnet,
    var.rs_public_subnet,
  ]
}

resource "google_compute_firewall" "allow_http" {
  name    = "${var.name_prefix}-fw-allow-http"
  network = google_compute_network.vpc.name

  allow {
    protocol = "tcp"
    ports    = ["10000-19999", "8443", "8001", "8070", "8071", "9081", "9443", "8080", "443"]
  }

  allow {
    protocol = "udp"
    ports    = ["53", "5353"]
  }

  target_tags   = ["http"]
  source_ranges = ["0.0.0.0/0"]
}

resource "google_compute_firewall" "allow_bastion" {
  name    = "${var.name_prefix}-fw-allow-bastion"
  network = google_compute_network.vpc.name

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  target_tags   = ["ssh"]
  source_ranges = ["0.0.0.0/0"]
}

resource "google_compute_firewall" "allow_memviz" {
  count   = var.memviz_enabled && var.app_count > 0 ? 1 : 0
  name    = "${var.name_prefix}-fw-allow-memviz"
  network = google_compute_network.vpc.name

  allow {
    protocol = "tcp"
    ports    = [tostring(var.memviz_port)]
  }

  target_tags   = ["memviz"]
  source_ranges = ["0.0.0.0/0"]
}

# Companion App VMs only — opt-in website ports (not the Redis `http` tag).
resource "google_compute_firewall" "allow_app_http" {
  count   = var.app_expose_http && var.app_count > 0 ? 1 : 0
  name    = "${var.name_prefix}-fw-allow-app-http"
  network = google_compute_network.vpc.name

  allow {
    protocol = "tcp"
    ports    = ["80"]
  }

  target_tags   = ["app-http"]
  source_ranges = ["0.0.0.0/0"]
}

resource "google_compute_firewall" "allow_app_https" {
  count   = var.app_expose_https && var.app_count > 0 ? 1 : 0
  name    = "${var.name_prefix}-fw-allow-app-https"
  network = google_compute_network.vpc.name

  allow {
    protocol = "tcp"
    ports    = ["443"]
  }

  target_tags   = ["app-https"]
  source_ranges = ["0.0.0.0/0"]
}

output "vpc_name" {
  value = google_compute_network.vpc.name
}

output "vpc_id" {
  value = google_compute_network.vpc.id
}

output "public_subnet_name" {
  value = google_compute_subnetwork.public_subnet.name
}

output "public_subnet_id" {
  value = google_compute_subnetwork.public_subnet.id
}

output "private_subnet_name" {
  value = google_compute_subnetwork.private_subnet.name
}
