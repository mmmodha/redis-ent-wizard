variable "name_prefix" {
  type = string
}

variable "youremail" {
  type = string
}

# GCP label values reject '@' and '.', so an owner email must be normalised.
locals {
  owner_label = substr(replace(lower(var.youremail), "/[^a-z0-9_-]+/", "-"), 0, 63)
}

variable "clustersize" {
  type = number
}

variable "machine_type" {
  type = string
}

variable "region_name" {
  type = string
}

variable "region_zones" {
  type = list(string)
}

variable "rof_nvme_disks" {
  type    = number
  default = 0
}

variable "RS_release" {
  type = string
}

variable "RS_admin" {
  type = string
}

variable "dns_managed_zone" {
  type = string
}

variable "dns_zone_dns_name" {
  type = string
}

variable "public_subnet_name" {
  type = string
}

variable "ssh_public_key" {
  type = string
}

variable "scripts_path" {
  type        = string
  description = "Absolute path to terraform/scripts directory"
}

resource "random_password" "password" {
  length           = 12
  special          = true
  override_special = "_"
}

resource "google_compute_instance" "node1" {
  name         = "${var.name_prefix}-1"
  machine_type = var.machine_type
  zone         = "${var.region_name}-${var.region_zones[0]}"
  tags         = ["ssh", "http"]

  boot_disk {
    initialize_params {
      image = "ubuntu-minimal-2204-jammy-v20250311"
      size  = 30
    }
  }

  dynamic "scratch_disk" {
    for_each = range(var.rof_nvme_disks)
    content {
      interface = "NVME"
    }
  }

  # Local SSD is attached for Redis on Flash. Live migration is supported for
  # most machine types with Local SSD; TERMINATE is used when disks are present
  # to avoid host-maintenance edge cases on older families.
  scheduling {
    on_host_maintenance = var.rof_nvme_disks > 0 ? "TERMINATE" : "MIGRATE"
    automatic_restart   = true
  }

  labels = {
    owner         = local.owner_label
    skip_deletion = "yes"
  }

  metadata = {
    ssh-keys = "ubuntu:${var.ssh_public_key}"
    startup-script = templatefile("${var.scripts_path}/instance.sh", {
      cluster_dns = "cluster.${var.name_prefix}.${var.dns_zone_dns_name}"
      node_id     = 1
      clustersize = tostring(var.clustersize)
      zone        = "${var.region_name}-${var.region_zones[0]}"
      node_1_ip   = ""
      RS_release  = var.RS_release
      RS_admin    = var.RS_admin
      RS_password = random_password.password.result
    })
  }

  network_interface {
    subnetwork = var.public_subnet_name
    access_config {}
  }
}

resource "google_compute_instance" "nodeX" {
  count = var.clustersize > 0 ? var.clustersize - 1 : 0

  name         = "${var.name_prefix}-${count.index + 2}"
  machine_type = var.machine_type
  zone         = "${var.region_name}-${var.region_zones[(count.index + 1) % length(var.region_zones)]}"
  tags         = ["ssh", "http"]

  boot_disk {
    initialize_params {
      image = "ubuntu-minimal-2204-jammy-v20250311"
      size  = 30
    }
  }

  dynamic "scratch_disk" {
    for_each = range(var.rof_nvme_disks)
    content {
      interface = "NVME"
    }
  }

  # Local SSD is attached for Redis on Flash. Live migration is supported for
  # most machine types with Local SSD; TERMINATE is used when disks are present
  # to avoid host-maintenance edge cases on older families.
  scheduling {
    on_host_maintenance = var.rof_nvme_disks > 0 ? "TERMINATE" : "MIGRATE"
    automatic_restart   = true
  }

  labels = {
    owner         = local.owner_label
    skip_deletion = "yes"
  }

  metadata = {
    ssh-keys = "ubuntu:${var.ssh_public_key}"
    startup-script = templatefile("${var.scripts_path}/instance.sh", {
      cluster_dns = "cluster.${var.name_prefix}.${var.dns_zone_dns_name}"
      node_id     = count.index + 2
      clustersize = tostring(var.clustersize)
      zone        = "${var.region_name}-${var.region_zones[(count.index + 1) % length(var.region_zones)]}"
      node_1_ip   = google_compute_instance.node1.network_interface[0].network_ip
      RS_release  = var.RS_release
      RS_admin    = var.RS_admin
      RS_password = random_password.password.result
    })
  }

  network_interface {
    subnetwork = var.public_subnet_name
    access_config {}
  }
}

resource "google_dns_record_set" "node1" {
  name         = "node1.${var.name_prefix}.${var.dns_zone_dns_name}."
  type         = "A"
  ttl          = 300
  managed_zone = var.dns_managed_zone
  rrdatas      = [google_compute_instance.node1.network_interface[0].access_config[0].nat_ip]
}

resource "google_dns_record_set" "nodeX" {
  count = var.clustersize > 0 ? var.clustersize - 1 : 0

  name         = "node${count.index + 2}.${var.name_prefix}.${var.dns_zone_dns_name}."
  type         = "A"
  ttl          = 300
  managed_zone = var.dns_managed_zone
  rrdatas      = [google_compute_instance.nodeX[count.index].network_interface[0].access_config[0].nat_ip]
}

resource "google_dns_record_set" "name_servers" {
  name         = "cluster.${var.name_prefix}.${var.dns_zone_dns_name}."
  type         = "NS"
  ttl          = 60
  managed_zone = var.dns_managed_zone
  rrdatas      = flatten([google_dns_record_set.node1.name, [for xx in google_dns_record_set.nodeX : xx.name]])
}

output "admin_password" {
  value     = random_password.password.result
  sensitive = true
}

output "node1_name" {
  value = google_compute_instance.node1.name
}

output "node1_ip" {
  value = google_compute_instance.node1.network_interface[0].access_config[0].nat_ip
}

output "nodes_ip" {
  value = flatten([
    google_compute_instance.node1.network_interface[0].access_config[0].nat_ip,
    google_compute_instance.nodeX[*].network_interface[0].access_config[0].nat_ip,
  ])
}

output "nodes_dns" {
  value = flatten([google_dns_record_set.node1.name, google_dns_record_set.nodeX[*].name])
}

output "rs_cluster_dns" {
  value = "cluster.${var.name_prefix}.${var.dns_zone_dns_name}"
}

output "rs_ui_dns" {
  value = [
    "https://node1.${var.name_prefix}.${var.dns_zone_dns_name}:8443",
  ]
}

output "rs_ui_ip" {
  value = "https://${google_compute_instance.node1.network_interface[0].access_config[0].nat_ip}:8443"
}

output "node_names" {
  value = concat([google_compute_instance.node1.name], google_compute_instance.nodeX[*].name)
}

output "node_zones" {
  value = concat([google_compute_instance.node1.zone], google_compute_instance.nodeX[*].zone)
}

output "how_to_ssh" {
  value = concat(
    ["gcloud compute ssh ${google_compute_instance.node1.name} --zone ${google_compute_instance.node1.zone}"],
    [for n in google_compute_instance.nodeX : "gcloud compute ssh ${n.name} --zone ${n.zone}"],
  )
}
