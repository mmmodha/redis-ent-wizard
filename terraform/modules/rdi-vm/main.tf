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

variable "region_name" {
  type = string
}

variable "region_zones" {
  type = list(string)
}

variable "machine_type" {
  type    = string
  default = "n2-standard-4"
}

variable "rdi_version" {
  type        = string
  default     = ""
  description = "RDI runtime version to install (empty = installer default)."
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

variable "dns_managed_zone" {
  type = string
}

variable "dns_zone_dns_name" {
  type = string
}

variable "oauth_scopes" {
  type    = list(string)
  default = []
}

variable "injected_env" {
  type        = map(string)
  default     = {}
  description = "Connection env (Redis target/state + Cloud SQL source creds) written to /opt/rew/connections.env."
}

variable "pipeline_config" {
  type        = string
  default     = ""
  description = "Base64 RDI pipeline config (config.yaml + jobs), deployed by the runtime."
}

locals {
  resource_labels = merge(
    { owner = var.youremail },
    var.skip_deletion ? { skip_deletion = "yes" } : {},
  )
}

resource "google_compute_instance" "rdi" {
  name         = "${var.name_prefix}-rdi"
  machine_type = var.machine_type
  zone         = "${var.region_name}-${var.region_zones[0]}"
  tags         = ["ssh", "rdi"]

  boot_disk {
    initialize_params {
      image = "ubuntu-minimal-2204-jammy-v20250311"
      size  = 30
    }
  }

  labels = local.resource_labels

  metadata = {
    ssh-keys = "ubuntu:${var.ssh_public_key}"
    startup-script = templatefile("${var.scripts_path}/rdi.sh", {
      rdi_version     = var.rdi_version
      pipeline_config = var.pipeline_config
      connections_env = join("\n", [
        for k, v in var.injected_env : "export ${k}='${replace(v, "'", "'\\''")}'"
      ])
    })
  }

  network_interface {
    subnetwork = var.public_subnet_name
    access_config {}
  }

  dynamic "service_account" {
    for_each = length(var.oauth_scopes) > 0 ? [1] : []
    content {
      scopes = var.oauth_scopes
    }
  }
}

resource "google_dns_record_set" "rdi" {
  name         = "rdi.${var.name_prefix}.${var.dns_zone_dns_name}."
  type         = "A"
  ttl          = 300
  managed_zone = var.dns_managed_zone
  rrdatas      = [google_compute_instance.rdi.network_interface[0].access_config[0].nat_ip]
}

output "rdi_ip" {
  value = google_compute_instance.rdi.network_interface[0].access_config[0].nat_ip
}

output "rdi_dns" {
  value = trimsuffix(google_dns_record_set.rdi.name, ".")
}

output "how_to_ssh" {
  value = "gcloud compute ssh ${google_compute_instance.rdi.name} --zone ${google_compute_instance.rdi.zone}"
}
