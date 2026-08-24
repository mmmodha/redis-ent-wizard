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

# GCP `owner` is Created by as firstName_lastName (e.g. mehul_modha).
# skip_deletion=yes is opt-in so org cleanup jobs leave these resources.
locals {
  owner_label = var.youremail
  resource_labels = merge(
    { owner = local.owner_label },
    var.skip_deletion ? { skip_deletion = "yes" } : {},
  )
  app_tags = concat(
    ["ssh"],
    var.app_expose_http ? ["app-http"] : [],
    var.app_expose_https ? ["app-https"] : [],
    var.memviz_enabled ? ["memviz"] : [],
    length(var.app_extra_ports) > 0 ? ["app-extra"] : [],
  )
  # Pad / truncate so Terraform never indexes past the list if callers mis-size it.
  app_machine_types = [
    for i in range(var.app_count) :
    length(var.app_machine_types) > i && var.app_machine_types[i] != "" ? var.app_machine_types[i] : "n2-standard-8"
  ]
  app_disk_gib = [
    for i in range(var.app_count) :
    length(var.app_disk_gib) > i && var.app_disk_gib[i] > 0 ? var.app_disk_gib[i] : 0
  ]
}

variable "app_count" {
  type = number
}

variable "app_machine_types" {
  type        = list(string)
  description = "Machine type for each App VM (length must equal app_count)"
  default     = []
}

variable "region_name" {
  type = string
}

variable "region_zones" {
  type = list(string)
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
  type = string
}

variable "clustersize" {
  type = number
}

variable "memviz_enabled" {
  type    = bool
  default = false
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
  description = "Additional TCP ports; used only to tag VMs for the app-extra firewall"
  default     = []
}

resource "google_compute_disk" "app_data" {
  for_each = {
    for i, size in local.app_disk_gib : tostring(i) => size if size > 0
  }

  name = "${var.name_prefix}-app-data-${each.key}"
  type = "pd-balanced"
  zone = "${var.region_name}-${var.region_zones[0]}"
  size = each.value

  labels = local.resource_labels
}

resource "google_compute_instance" "app" {
  count = var.app_count

  name         = count.index <= 0 ? "${var.name_prefix}-app" : "${var.name_prefix}-app-${count.index}"
  machine_type = local.app_machine_types[count.index]
  zone         = "${var.region_name}-${var.region_zones[0]}"
  tags         = local.app_tags

  boot_disk {
    initialize_params {
      image = "ubuntu-minimal-2204-jammy-v20250311"
      size  = 30
    }
  }

  dynamic "attached_disk" {
    for_each = local.app_disk_gib[count.index] > 0 ? [tostring(count.index)] : []
    content {
      source      = google_compute_disk.app_data[attached_disk.value].id
      device_name = "app-data"
      mode        = "READ_WRITE"
    }
  }

  labels = local.resource_labels

  metadata = {
    ssh-keys = "ubuntu:${var.ssh_public_key}"
    startup-script = templatefile("${var.scripts_path}/app.sh", {
      cluster_dns_suffix = "${var.name_prefix}.${var.dns_zone_dns_name}"
      nodes              = tostring(var.clustersize)
      memviz_enabled     = var.memviz_enabled
      memviz_port        = var.memviz_port
      memviz_repo_url    = var.memviz_repo_url
      memviz_repo_ref    = var.memviz_repo_ref
      extra_disk_gib     = local.app_disk_gib[count.index]
    })
  }

  network_interface {
    subnetwork = var.public_subnet_name
    access_config {}
  }
}

resource "google_dns_record_set" "app" {
  count = var.app_count

  name         = count.index <= 0 ? "app.${var.name_prefix}.${var.dns_zone_dns_name}." : "app.${var.name_prefix}-${count.index}.${var.dns_zone_dns_name}."
  type         = "A"
  ttl          = 300
  managed_zone = var.dns_managed_zone
  rrdatas      = [google_compute_instance.app[count.index].network_interface[0].access_config[0].nat_ip]
}

output "app_names" {
  value = google_compute_instance.app[*].name
}

output "instance_self_links" {
  value = google_compute_instance.app[*].self_link
}

output "app_machine_types" {
  value = local.app_machine_types
}

output "app_ips" {
  value = google_compute_instance.app[*].network_interface[0].access_config[0].nat_ip
}

output "app_dns" {
  value = [for r in google_dns_record_set.app : trimsuffix(r.name, ".")]
}

output "how_to_ssh_to_app" {
  value = [
    for inst in google_compute_instance.app :
    "gcloud compute ssh ${inst.name} --zone ${inst.zone}"
  ]
}

output "apps" {
  value = [
    for i, inst in google_compute_instance.app : {
      name         = inst.name
      machine_type = inst.machine_type
      ip           = inst.network_interface[0].access_config[0].nat_ip
      dns          = trimsuffix(google_dns_record_set.app[i].name, ".")
      zone         = inst.zone
      how_to_ssh   = "gcloud compute ssh ${inst.name} --zone ${inst.zone}"
    }
  ]
}

output "memviz_url" {
  value = var.memviz_enabled && var.app_count > 0 ? "http://app.${var.name_prefix}.${var.dns_zone_dns_name}:${var.memviz_port}" : ""
}

output "app_http_url" {
  value = var.app_expose_http && var.app_count > 0 ? "http://app.${var.name_prefix}.${var.dns_zone_dns_name}" : ""
}

output "app_https_url" {
  value = var.app_expose_https && var.app_count > 0 ? "https://app.${var.name_prefix}.${var.dns_zone_dns_name}" : ""
}
