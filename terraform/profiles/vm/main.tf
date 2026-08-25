locals {
  name_prefix  = "${var.yourname}-${var.env}"
  scripts_path = abspath("${path.module}/../../scripts")
  clusters = var.redis_enabled ? (
    length(var.clusters) > 0 ? [for c in var.clusters : c if c.nodes > 0] : (
      var.clustersize > 0 ? [{
        name           = ""
        nodes          = var.clustersize
        machine_type   = var.machine_type
        rof_nvme_disks = var.rof_nvme_disks
        RS_release     = var.RS_release
      }] : []
    )
  ) : []
  cluster_prefixes = [
    for i, c in local.clusters :
    trimspace(c.name) != "" ? "${local.name_prefix}-${c.name}" : (
      i == 0 ? local.name_prefix : "${local.name_prefix}-c${i + 1}"
    )
  ]

  # Firewall coverage for custom application workload VMs (see module.app_workload).
  app_wl_any_http  = anytrue([for a in var.applications : a.expose_http])
  app_wl_any_https = anytrue([for a in var.applications : a.expose_https])
  app_wl_ports     = distinct(flatten([for a in var.applications : a.ports]))

  # Internal load balancers. Resolve each entry's backend VM self_links from the
  # matching module (guarded so a bad target name yields an empty group, not a
  # plan crash), and gather all fronted ports for the health-check firewall.
  lb_by_name = { for lb in var.load_balancers : lb.name => lb }
  lb_targets = {
    for lb in var.load_balancers : lb.name => (
      lb.target_kind == "application"
      ? try(module.app_workload[lb.target].instance_self_links, [])
      : module.app_vm.instance_self_links
    )
  }
  lb_all_ports = distinct(flatten([for lb in var.load_balancers : lb.ports]))
}

module "network" {
  source = "../../modules/network"

  name_prefix       = local.name_prefix
  region_name       = var.region_name
  rs_private_subnet = var.rs_private_subnet
  rs_public_subnet  = var.rs_public_subnet
  memviz_enabled    = var.memviz_enabled
  memviz_port       = var.memviz_port
  app_count         = var.app
  app_expose_http   = var.app_expose_http
  app_expose_https  = var.app_expose_https
  app_extra_ports   = var.app_extra_ports
}

module "re_vm" {
  source = "../../modules/re-vm"
  count  = length(local.clusters)

  name_prefix        = local.cluster_prefixes[count.index]
  youremail          = var.youremail
  skip_deletion      = var.skip_deletion
  clustersize        = local.clusters[count.index].nodes
  machine_type       = local.clusters[count.index].machine_type
  region_name        = var.region_name
  region_zones       = var.region_zones
  rof_nvme_disks     = local.clusters[count.index].rof_nvme_disks
  RS_release         = local.clusters[count.index].RS_release
  RS_admin           = var.RS_admin
  dns_managed_zone   = var.dns_managed_zone
  dns_zone_dns_name  = var.dns_zone_dns_name
  public_subnet_name = module.network.public_subnet_name
  ssh_public_key     = var.ssh_public_key
  scripts_path       = local.scripts_path
}

moved {
  from = module.re_vm
  to   = module.re_vm[0]
}

module "app_vm" {
  source = "../../modules/app-vm"

  name_prefix        = local.name_prefix
  youremail          = var.youremail
  skip_deletion      = var.skip_deletion
  app_count          = var.app
  app_machine_types  = var.app_machine_types
  region_name        = var.region_name
  region_zones       = var.region_zones
  dns_managed_zone   = var.dns_managed_zone
  dns_zone_dns_name  = var.dns_zone_dns_name
  public_subnet_name = module.network.public_subnet_name
  ssh_public_key     = var.ssh_public_key
  scripts_path       = local.scripts_path
  clustersize        = try(local.clusters[0].nodes, 0)
  memviz_enabled     = var.memviz_enabled
  memviz_port        = var.memviz_port
  memviz_repo_url    = var.memviz_repo_url
  memviz_repo_ref    = var.memviz_repo_ref
  app_expose_http    = var.app_expose_http
  app_expose_https   = var.app_expose_https
  app_disk_gib       = var.app_disk_gib
  app_extra_ports    = var.app_extra_ports
}

module "app_workload" {
  source   = "../../modules/app-workload"
  for_each = { for a in var.applications : a.name => a }

  name_prefix          = local.name_prefix
  app_name             = each.value.name
  youremail            = var.youremail
  skip_deletion        = var.skip_deletion
  region_name          = var.region_name
  region_zones         = var.region_zones
  public_subnet_name   = module.network.public_subnet_name
  ssh_public_key       = var.ssh_public_key
  ssh_private_key_path = var.ssh_private_key_path
  dns_managed_zone     = var.dns_managed_zone
  dns_zone_dns_name    = var.dns_zone_dns_name

  artifact_local_path = each.value.artifact_local_path
  artifact_type       = each.value.artifact_type
  artifact_filename   = each.value.artifact_filename
  git_url             = each.value.git_url
  git_ref             = each.value.git_ref
  command             = each.value.command
  vm_count            = each.value.vm_count
  machine_type        = each.value.machine_type
  disk_gib            = each.value.disk_gib
  ports               = each.value.ports
  env                 = each.value.env
  expose_http         = each.value.expose_http
  expose_https        = each.value.expose_https
  requirements        = each.value.requirements
}

# The network module opens app-http/app-https/app-extra only for companion App
# VMs (var.app). Application workloads reuse the same tags, so open the ports
# here as well (distinct names avoid clashing with the network module rules).
resource "google_compute_firewall" "app_workload_http" {
  count   = local.app_wl_any_http ? 1 : 0
  name    = "${local.name_prefix}-fw-appwl-http"
  network = module.network.vpc_name

  allow {
    protocol = "tcp"
    ports    = ["80"]
  }

  target_tags   = ["app-http"]
  source_ranges = ["0.0.0.0/0"]
}

resource "google_compute_firewall" "app_workload_https" {
  count   = local.app_wl_any_https ? 1 : 0
  name    = "${local.name_prefix}-fw-appwl-https"
  network = module.network.vpc_name

  allow {
    protocol = "tcp"
    ports    = ["443"]
  }

  target_tags   = ["app-https"]
  source_ranges = ["0.0.0.0/0"]
}

resource "google_compute_firewall" "app_workload_extra" {
  count   = length(local.app_wl_ports) > 0 ? 1 : 0
  name    = "${local.name_prefix}-fw-appwl-extra"
  network = module.network.vpc_name

  allow {
    protocol = "tcp"
    ports    = [for p in local.app_wl_ports : tostring(p)]
  }

  target_tags   = ["app-extra"]
  source_ranges = ["0.0.0.0/0"]
}

# Regional internal TCP passthrough load balancers fronting app VMs. Each entry
# in var.load_balancers gets an unmanaged zonal instance group of the target
# VMs, a regional TCP health check, an INTERNAL backend service, an internal
# VIP, and a forwarding rule. All target VMs live in the first region zone.
resource "google_compute_instance_group" "lb" {
  for_each = local.lb_by_name

  name      = "${local.name_prefix}-lb-${each.key}"
  zone      = "${var.region_name}-${var.region_zones[0]}"
  instances = local.lb_targets[each.key]

  dynamic "named_port" {
    for_each = each.value.ports
    content {
      name = "port-${named_port.value}"
      port = named_port.value
    }
  }
}

resource "google_compute_region_health_check" "lb" {
  for_each = local.lb_by_name

  name   = "${local.name_prefix}-lb-hc-${each.key}"
  region = var.region_name

  tcp_health_check {
    port = each.value.ports[0]
  }
}

resource "google_compute_region_backend_service" "lb" {
  for_each = local.lb_by_name

  name                  = "${local.name_prefix}-lb-bes-${each.key}"
  region                = var.region_name
  load_balancing_scheme = "INTERNAL"
  protocol              = "TCP"
  health_checks         = [google_compute_region_health_check.lb[each.key].id]

  backend {
    group = google_compute_instance_group.lb[each.key].self_link
    # INTERNAL passthrough backend services require CONNECTION (UTILIZATION is rejected).
    balancing_mode = "CONNECTION"
  }
}

resource "google_compute_address" "lb" {
  for_each = local.lb_by_name

  name         = "${local.name_prefix}-lb-vip-${each.key}"
  address_type = "INTERNAL"
  subnetwork   = module.network.public_subnet_name
  region       = var.region_name
}

resource "google_compute_forwarding_rule" "lb" {
  for_each = local.lb_by_name

  name                  = "${local.name_prefix}-lb-fr-${each.key}"
  region                = var.region_name
  load_balancing_scheme = "INTERNAL"
  backend_service       = google_compute_region_backend_service.lb[each.key].id
  ports                 = [for p in each.value.ports : tostring(p)]
  network               = module.network.vpc_name
  subnetwork            = module.network.public_subnet_name
  ip_address            = google_compute_address.lb[each.key].address
}

# Allow the GCP health-check probers and internal subnet traffic to reach the
# fronted ports on the backend VMs (all app VMs carry the `ssh` network tag).
resource "google_compute_firewall" "lb_health_check" {
  count   = length(var.load_balancers) > 0 ? 1 : 0
  name    = "${local.name_prefix}-fw-lb-hc"
  network = module.network.vpc_name

  allow {
    protocol = "tcp"
    ports    = [for p in local.lb_all_ports : tostring(p)]
  }

  target_tags = ["ssh"]
  source_ranges = [
    "130.211.0.0/22",
    "35.191.0.0/16",
    var.rs_private_subnet,
    var.rs_public_subnet,
  ]
}

output "rs_ui_dns" {
  value = length(module.re_vm) > 0 ? module.re_vm[0].rs_ui_dns : []
}

output "rs_ui_ip" {
  value = length(module.re_vm) > 0 ? module.re_vm[0].rs_ui_ip : ""
}

output "rs_cluster_dns" {
  value = length(module.re_vm) > 0 ? module.re_vm[0].rs_cluster_dns : ""
}

output "nodes_ip" {
  value = flatten(module.re_vm[*].nodes_ip)
}

output "nodes_dns" {
  value = flatten(module.re_vm[*].nodes_dns)
}

output "admin_username" {
  value = length(module.re_vm) > 0 ? var.RS_admin : ""
}

output "admin_password" {
  value     = length(module.re_vm) > 0 ? module.re_vm[0].admin_password : ""
  sensitive = true
}

output "how_to_ssh" {
  value = length(module.re_vm) > 0 ? "gcloud compute ssh ${module.re_vm[0].node1_name} --zone ${var.region_name}-${var.region_zones[0]}" : ""
}

output "clusters" {
  sensitive = true
  value = [
    for i, m in module.re_vm : {
      index          = i + 1
      name_prefix    = local.cluster_prefixes[i]
      name           = local.clusters[i].name
      nodes          = local.clusters[i].nodes
      machine_type   = local.clusters[i].machine_type
      rs_release     = local.clusters[i].RS_release
      ui             = m.rs_ui_ip
      ui_dns         = m.rs_ui_dns
      dns            = m.rs_cluster_dns
      nodes_ip       = m.nodes_ip
      nodes_dns      = m.nodes_dns
      node_names     = m.node_names
      node_zones     = m.node_zones
      how_to_ssh     = m.how_to_ssh
      node1_name     = m.node1_name
      admin_password = m.admin_password
    }
  ]
}

output "app_names" {
  value = module.app_vm.app_names
}

output "app_machine_types" {
  value = module.app_vm.app_machine_types
}

output "app_ips" {
  value = module.app_vm.app_ips
}

output "app_dns" {
  value = module.app_vm.app_dns
}

output "how_to_ssh_to_app" {
  value = module.app_vm.how_to_ssh_to_app
}

output "apps" {
  value = module.app_vm.apps
}

output "memviz_url" {
  value = module.app_vm.memviz_url
}

output "app_http_url" {
  value = module.app_vm.app_http_url
}

output "app_https_url" {
  value = module.app_vm.app_https_url
}

output "app_workloads" {
  value = flatten([for m in module.app_workload : m.apps])
}

output "load_balancers" {
  value = [
    for k, fr in google_compute_forwarding_rule.lb : {
      name  = k
      vip   = fr.ip_address
      ports = local.lb_by_name[k].ports
    }
  ]
}

output "deployment_mode" {
  value = "vm"
}
