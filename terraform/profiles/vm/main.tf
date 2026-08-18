locals {
  name_prefix  = "${var.yourname}-${var.env}"
  scripts_path = abspath("${path.module}/../../scripts")
  clusters = length(var.clusters) > 0 ? var.clusters : [{
    name           = ""
    nodes          = var.clustersize
    machine_type   = var.machine_type
    rof_nvme_disks = var.rof_nvme_disks
    RS_release     = var.RS_release
  }]
  cluster_prefixes = [
    for i, c in local.clusters :
    trimspace(c.name) != "" ? "${local.name_prefix}-${c.name}" : (
      i == 0 ? local.name_prefix : "${local.name_prefix}-c${i + 1}"
    )
  ]
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
  app_count          = var.app
  app_machine_types  = var.app_machine_types
  region_name        = var.region_name
  region_zones       = var.region_zones
  dns_managed_zone   = var.dns_managed_zone
  dns_zone_dns_name  = var.dns_zone_dns_name
  public_subnet_name = module.network.public_subnet_name
  ssh_public_key     = var.ssh_public_key
  scripts_path       = local.scripts_path
  clustersize        = local.clusters[0].nodes
  memviz_enabled     = var.memviz_enabled
  memviz_port        = var.memviz_port
  memviz_repo_url    = var.memviz_repo_url
  memviz_repo_ref    = var.memviz_repo_ref
  app_expose_http    = var.app_expose_http
  app_expose_https   = var.app_expose_https
  app_disk_gib       = var.app_disk_gib
  app_extra_ports    = var.app_extra_ports
}

output "rs_ui_dns" {
  value = module.re_vm[0].rs_ui_dns
}

output "rs_ui_ip" {
  value = module.re_vm[0].rs_ui_ip
}

output "rs_cluster_dns" {
  value = module.re_vm[0].rs_cluster_dns
}

output "nodes_ip" {
  value = flatten(module.re_vm[*].nodes_ip)
}

output "nodes_dns" {
  value = flatten(module.re_vm[*].nodes_dns)
}

output "admin_username" {
  value = var.RS_admin
}

output "admin_password" {
  value     = module.re_vm[0].admin_password
  sensitive = true
}

output "how_to_ssh" {
  value = "gcloud compute ssh ${module.re_vm[0].node1_name} --zone ${var.region_name}-${var.region_zones[0]}"
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

output "deployment_mode" {
  value = "vm"
}
