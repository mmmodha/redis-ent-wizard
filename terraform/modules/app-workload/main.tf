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

variable "git_url" {
  type        = string
  description = "When set, clone this GitHub repo onto the VM instead of copying a local artifact."
  default     = ""
}

variable "git_ref" {
  type        = string
  description = "Optional git branch or tag to clone."
  default     = ""
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
  is_git      = trimspace(var.git_url) != ""
  needs_docker = contains(var.requirements, "docker")
  deploy_source = local.is_git ? "${path.module}/placeholder.txt" : var.artifact_local_path
  deploy_dest   = local.is_git ? "/tmp/placeholder.txt" : "/tmp/${var.artifact_filename}"

  # Requirement ids handled by install_requirement in the setup script.
  requirements_csv = join(",", var.requirements)

  # A jar still gets a modern JRE by default, but only when the user did not
  # already pick a Java requirement (openjdk-25/21/17) themselves.
  java_requirements     = ["openjdk-25", "openjdk-21", "openjdk-17"]
  has_java_requirement  = length(setintersection(toset(var.requirements), toset(local.java_requirements))) > 0
  jar_needs_default_jre = !local.is_git && var.artifact_type == "jar" && !local.has_java_requirement

  unit_file = <<-UNIT
    [Unit]
    Description=app workload
    After=network.target${local.needs_docker ? " docker.service" : ""}
    %{if local.needs_docker~}
    Wants=docker.service
    %{endif~}
    StartLimitIntervalSec=0

    [Service]
    Type=simple
    User=ubuntu
    %{if local.needs_docker~}
    Group=docker
    %{endif~}
    WorkingDirectory=/opt/app
    EnvironmentFile=/opt/app/app.env
    ExecStart=/usr/bin/env bash -lc 'cd /opt/app && ${var.command}'
    Restart=always
    RestartSec=5
    TimeoutStartSec=0

    [Install]
    WantedBy=multi-user.target
  UNIT

  # Runs on the VM (via remote-exec) to place the artifact, mount the optional
  # data disk, and — when a command was given — start a systemd service.
  setup_script = <<-SETUP
    #!/bin/bash
    set +e
    set -x
    export DEBIAN_FRONTEND=noninteractive
    export NEEDRESTART_MODE=a
    export NEEDRESTART_SUSPEND=1
    export GIT_TERMINAL_PROMPT=0
    mkdir -p /opt/app

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
        docker)
          echo "=== APPWL ${var.app_name} STEP docker ==="
          install -d -m 0755 /etc/apt/keyrings
          curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
          chmod a+r /etc/apt/keyrings/docker.gpg
          echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu jammy stable" > /etc/apt/sources.list.d/docker.list
          # Do not start docker during dpkg: its iptables rewrite drops Terraform's
          # SSH session ("exited without exit status" after a long hang).
          printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d
          chmod +x /usr/sbin/policy-rc.d
          apt-get -y update
          SYSTEMD_OFFLINE=1 apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold install \
            docker-ce docker-ce-cli containerd.io docker-compose-plugin
          rm -f /usr/sbin/policy-rc.d
          usermod -aG docker ubuntu
          iptables -I INPUT -p tcp --dport 22 -j ACCEPT || true
          iptables -I INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT || true
          systemctl enable docker
          systemctl start docker
          for i in $(seq 1 30); do
            docker info >/dev/null 2>&1 && break
            sleep 2
          done
          docker info
          COMPOSE_PLUGIN=""
          for p in /usr/libexec/docker/cli-plugins/docker-compose /usr/lib/docker/cli-plugins/docker-compose; do
            [ -x "$p" ] && COMPOSE_PLUGIN="$p" && break
          done
          if [ -n "$COMPOSE_PLUGIN" ]; then
            ln -sfn "$COMPOSE_PLUGIN" /usr/local/bin/docker-compose
          fi
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
    %{if local.is_git~}
    echo "=== APPWL ${var.app_name} STEP clone ==="
    rm -rf /opt/app
    install -d -o ubuntu -g ubuntu /opt/app
    set -e
    %{if local.needs_docker~}
    systemctl start docker
    for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 2; done
    docker info
    %{endif~}
    %{if trimspace(var.git_ref) != ""~}
    sudo -u ubuntu env GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=true git clone --depth 1 --branch '${var.git_ref}' '${var.git_url}' /opt/app
    %{else~}
    sudo -u ubuntu env GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=true git clone --depth 1 '${var.git_url}' /opt/app
    %{endif~}
    %{else~}
    mv /tmp/${var.artifact_filename} /opt/app/${var.artifact_filename}
    %{if var.artifact_type == "binary"~}
    chmod +x /opt/app/${var.artifact_filename}
    %{endif~}
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
    echo "=== APPWL ${var.app_name} STEP start ==="
    mv /tmp/appworkload.service /etc/systemd/system/appworkload.service
    systemctl daemon-reload
    systemctl enable appworkload
    # Do not block Terraform SSH on a long `docker compose --build`.
    systemctl restart --no-block appworkload
    %{else~}
    echo "no command set; artifact staged in /opt/app" > /opt/app/app.log
    %{endif~}
    echo "=== APPWL ${var.app_name} DONE ==="
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
    artifact = local.is_git ? "${var.git_url}#${var.git_ref}" : try(filemd5(var.artifact_local_path), "none")
    command  = var.command
    env      = local.env_file
  }

  connection {
    type        = "ssh"
    host        = google_compute_instance.vm[count.index].network_interface[0].access_config[0].nat_ip
    user        = "ubuntu"
    private_key = try(file(pathexpand(var.ssh_private_key_path)), null)
    timeout     = "20m"
  }

  provisioner "file" {
    source      = local.deploy_source
    destination = local.deploy_dest
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
    inline = [
      "sudo env NEEDRESTART_SUSPEND=1 DEBIAN_FRONTEND=noninteractive bash -x /tmp/appwl-setup.sh",
    ]
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
