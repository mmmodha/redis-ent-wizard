variable "name_prefix" {
  type = string
}

variable "app_name" {
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

variable "public_subnet_name" {
  type = string
}

variable "ssh_public_key" {
  type = string
}

variable "ssh_private_key_path" {
  type        = string
  description = "Path to the SSH private key Terraform uses to copy the artifact to the VM."
}

variable "dns_managed_zone" {
  type = string
}

variable "dns_zone_dns_name" {
  type = string
}

variable "artifact_local_path" {
  type        = string
  description = "Local file (on the Terraform host) copied to each VM over SSH."
  default     = ""
}

variable "artifact_type" {
  type        = string
  description = "jar | binary"
  default     = "binary"
}

variable "artifact_filename" {
  type        = string
  description = "Filename the artifact lands as in /opt/app."
  default     = "app.bin"
}

variable "command" {
  type        = string
  description = "Command to run the app; empty means stage only (no systemd service)."
  default     = ""
}

variable "requirements" {
  type        = list(string)
  description = "Requirement ids to apt-install before the app command runs (e.g. openjdk-21, nodejs)."
  default     = []
}

variable "vm_count" {
  type = number
}

variable "machine_type" {
  type = string
}

variable "disk_gib" {
  type        = number
  description = "Extra data disk GiB per VM (0 = boot disk only)."
  default     = 0
}

variable "ports" {
  type        = list(number)
  description = "Extra TCP ports opened on the app VMs (app-extra tag)."
  default     = []
}

variable "env" {
  type        = map(string)
  description = "Environment variables for the app (incl. connected cluster endpoints)."
  default     = {}
}

variable "expose_http" {
  type    = bool
  default = false
}

variable "expose_https" {
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
    var.expose_http ? ["app-http"] : [],
    var.expose_https ? ["app-https"] : [],
    length(var.ports) > 0 ? ["app-extra"] : [],
  )
  command_set = trimspace(var.command) != ""
  env_file    = join("\n", [for k, v in var.env : "${k}=${v}"])

  # Requirement ids handled by install_requirement in the setup script.
  requirements_csv = join(",", var.requirements)

  # A jar still gets a modern JRE by default, but only when the user did not
  # already pick a Java requirement (openjdk-25/21/17) themselves.
  java_requirements     = ["openjdk-25", "openjdk-21", "openjdk-17"]
  has_java_requirement  = length(setintersection(toset(var.requirements), toset(local.java_requirements))) > 0
  jar_needs_default_jre = var.artifact_type == "jar" && !local.has_java_requirement

  unit_file = <<-UNIT
    [Unit]
    Description=app workload
    After=network.target

    [Service]
    Type=simple
    User=ubuntu
    WorkingDirectory=/opt/app
    EnvironmentFile=/opt/app/app.env
    ExecStart=/usr/bin/env bash -lc 'cd /opt/app && ${var.command}'
    Restart=always
    RestartSec=5

    [Install]
    WantedBy=multi-user.target
  UNIT

  # Runs on the VM (via remote-exec) to place the artifact, mount the optional
  # data disk, and — when a command was given — start a systemd service.
  setup_script = <<-SETUP
    #!/bin/bash
    set +e
    export DEBIAN_FRONTEND=noninteractive
    mkdir -p /opt/app
    mv /tmp/${var.artifact_filename} /opt/app/${var.artifact_filename}

    # Install a single requirement id on Ubuntu 22.04 (jammy). Unknown ids are
    # logged and skipped so a stray id never fails the whole deploy.
    install_requirement() {
      local id="$1"
      case "$id" in
        openjdk-25)
          install -d -m 0755 /etc/apt/keyrings
          curl -fsSL https://packages.adoptium.net/artifactory/api/gpg/key/public | gpg --dearmor -o /etc/apt/keyrings/adoptium.gpg
          chmod a+r /etc/apt/keyrings/adoptium.gpg
          echo "deb [signed-by=/etc/apt/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb jammy main" > /etc/apt/sources.list.d/adoptium.list
          apt-get -y update
          apt-get -y install temurin-25-jdk
          ;;
        openjdk-21)
          apt-get -y update
          apt-get -y install openjdk-21-jre-headless || {
            install -d -m 0755 /etc/apt/keyrings
            curl -fsSL https://packages.adoptium.net/artifactory/api/gpg/key/public | gpg --dearmor -o /etc/apt/keyrings/adoptium.gpg
            chmod a+r /etc/apt/keyrings/adoptium.gpg
            echo "deb [signed-by=/etc/apt/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb jammy main" > /etc/apt/sources.list.d/adoptium.list
            apt-get -y update
            apt-get -y install temurin-21-jre
          }
          ;;
        openjdk-17)
          apt-get -y update
          apt-get -y install openjdk-17-jre-headless
          ;;
        nodejs)
          curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
          apt-get -y install nodejs
          ;;
        python3)
          apt-get -y update
          apt-get -y install python3
          ;;
        python3-pip)
          apt-get -y update
          apt-get -y install python3-pip
          ;;
        build-essential)
          apt-get -y update
          apt-get -y install build-essential
          ;;
        git)
          apt-get -y update
          apt-get -y install git
          ;;
        *)
          echo "install_requirement: unknown requirement id '$id', skipping"
          ;;
      esac
    }

    # apt tools used by the requirement installers.
    apt-get -y update
    apt-get -y install ca-certificates curl gnupg

    REQUIREMENTS_CSV="${local.requirements_csv}"
    if [ -n "$REQUIREMENTS_CSV" ]; then
      IFS=',' read -ra REQ_IDS <<< "$REQUIREMENTS_CSV"
      for req in "$${REQ_IDS[@]}"; do
        req="$(echo "$req" | xargs)"
        [ -n "$req" ] && install_requirement "$req"
      done
    fi

    %{if local.jar_needs_default_jre~}
    # No Java requirement was selected, but a jar needs a modern JRE: default-jre
    # on 22.04 is Java 11, too old for recent Spring Boot jars. Prefer 21, fall
    # back to 17, then to the default only as a last resort.
    apt-get -y update
    apt-get -y install openjdk-21-jre-headless || apt-get -y install openjdk-17-jre-headless || apt-get -y install default-jre-headless
    %{endif~}
    %{if var.artifact_type == "binary"~}
    chmod +x /opt/app/${var.artifact_filename}
    %{endif~}
    mv /tmp/app.env /opt/app/app.env
    chown -R ubuntu:ubuntu /opt/app
    %{if var.disk_gib > 0~}
    for i in $(seq 1 30); do [ -e /dev/disk/by-id/google-app-data ] && break; sleep 2; done
    DEV=/dev/disk/by-id/google-app-data
    if [ -e "$DEV" ]; then
      blkid "$DEV" >/dev/null 2>&1 || mkfs.ext4 -F -L app-data "$DEV"
      mkdir -p /data
      grep -q " /data " /etc/fstab || echo "LABEL=app-data /data ext4 defaults,nofail 0 2" >> /etc/fstab
      mount -a
      chown ubuntu:ubuntu /data
    fi
    %{endif~}
    %{if local.command_set~}
    mv /tmp/appworkload.service /etc/systemd/system/appworkload.service
    systemctl daemon-reload
    systemctl enable appworkload
    systemctl restart appworkload
    %{else~}
    echo "no command set; artifact staged in /opt/app" > /opt/app/app.log
    %{endif~}
  SETUP
}

resource "google_compute_disk" "data" {
  count = var.disk_gib > 0 ? var.vm_count : 0

  name = "${var.name_prefix}-${var.app_name}-data-${count.index}"
  type = "pd-balanced"
  zone = "${var.region_name}-${var.region_zones[0]}"
  size = var.disk_gib

  labels = local.resource_labels
}

resource "google_compute_instance" "vm" {
  count = var.vm_count

  name         = count.index <= 0 ? "${var.name_prefix}-${var.app_name}" : "${var.name_prefix}-${var.app_name}-${count.index}"
  machine_type = var.machine_type
  zone         = "${var.region_name}-${var.region_zones[0]}"
  tags         = local.app_tags

  boot_disk {
    initialize_params {
      image = "ubuntu-minimal-2204-jammy-v20250311"
      size  = 30
    }
  }

  dynamic "attached_disk" {
    for_each = var.disk_gib > 0 ? [count.index] : []
    content {
      source      = google_compute_disk.data[attached_disk.value].id
      device_name = "app-data"
      mode        = "READ_WRITE"
    }
  }

  labels = local.resource_labels

  metadata = {
    ssh-keys = "ubuntu:${var.ssh_public_key}"
  }

  network_interface {
    subnetwork = var.public_subnet_name
    access_config {}
  }
}

# Copy the artifact and set the app up over SSH. Terraform's SSH provisioner
# avoids any Cloud Storage staging: the artifact is already a local file.
resource "null_resource" "deploy" {
  count = var.vm_count

  triggers = {
    instance = google_compute_instance.vm[count.index].id
    artifact = try(filemd5(var.artifact_local_path), "none")
    command  = var.command
    env      = local.env_file
  }

  connection {
    type        = "ssh"
    host        = google_compute_instance.vm[count.index].network_interface[0].access_config[0].nat_ip
    user        = "ubuntu"
    private_key = try(file(pathexpand(var.ssh_private_key_path)), null)
    timeout     = "5m"
  }

  provisioner "file" {
    source      = var.artifact_local_path
    destination = "/tmp/${var.artifact_filename}"
  }

  provisioner "file" {
    content     = "${local.env_file}\n"
    destination = "/tmp/app.env"
  }

  provisioner "file" {
    content     = local.unit_file
    destination = "/tmp/appworkload.service"
  }

  provisioner "file" {
    content     = local.setup_script
    destination = "/tmp/appwl-setup.sh"
  }

  provisioner "remote-exec" {
    inline = ["sudo bash /tmp/appwl-setup.sh"]
  }
}

resource "google_dns_record_set" "app" {
  count = var.vm_count

  name         = count.index <= 0 ? "${var.app_name}.${var.name_prefix}.${var.dns_zone_dns_name}." : "${var.app_name}.${var.name_prefix}-${count.index}.${var.dns_zone_dns_name}."
  type         = "A"
  ttl          = 300
  managed_zone = var.dns_managed_zone
  rrdatas      = [google_compute_instance.vm[count.index].network_interface[0].access_config[0].nat_ip]
}

output "instance_self_links" {
  value = google_compute_instance.vm[*].self_link
}

output "apps" {
  value = [
    for i, inst in google_compute_instance.vm : {
      name        = inst.name
      app_name    = var.app_name
      ip          = inst.network_interface[0].access_config[0].nat_ip
      dns         = trimsuffix(google_dns_record_set.app[i].name, ".")
      zone        = inst.zone
      ports       = var.ports
      command_set = local.command_set
      how_to_ssh  = "gcloud compute ssh ${inst.name} --zone ${inst.zone}"
    }
  ]
}
