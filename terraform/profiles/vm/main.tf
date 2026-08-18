locals {
  name_prefix  = "${var.yourname}-${var.env}"
  scripts_path = abspath("${path.module}/../../scripts")
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
}

module "re_vm" {
  source = "../../modules/re-vm"

  name_prefix         = local.name_prefix
  youremail           = var.youremail
  clustersize         = var.clustersize
  machine_type        = var.machine_type
  region_name         = var.region_name
  region_zones        = var.region_zones
  rof_nvme_disks      = var.rof_nvme_disks
  RS_release          = var.RS_release
  RS_admin            = var.RS_admin
  dns_managed_zone    = var.dns_managed_zone
  dns_zone_dns_name   = var.dns_zone_dns_name
  public_subnet_name  = module.network.public_subnet_name
  ssh_public_key      = var.ssh_public_key
  scripts_path        = local.scripts_path
}

module "app_vm" {
  source = "../../modules/app-vm"

  name_prefix         = local.name_prefix
  youremail           = var.youremail
  app_count           = var.app
  app_machine_types   = var.app_machine_types
  region_name         = var.region_name
  region_zones        = var.region_zones
  dns_managed_zone    = var.dns_managed_zone
  dns_zone_dns_name   = var.dns_zone_dns_name
  public_subnet_name  = module.network.public_subnet_name
  ssh_public_key      = var.ssh_public_key
  scripts_path        = local.scripts_path
  clustersize         = var.clustersize
  memviz_enabled      = var.memviz_enabled
  memviz_port         = var.memviz_port
  memviz_repo_url     = var.memviz_repo_url
  memviz_repo_ref     = var.memviz_repo_ref
  app_expose_http     = var.app_expose_http
  app_expose_https    = var.app_expose_https
}

output "rs_ui_dns" {
  value = module.re_vm.rs_ui_dns
}

output "rs_ui_ip" {
  value = module.re_vm.rs_ui_ip
}

output "rs_cluster_dns" {
  value = module.re_vm.rs_cluster_dns
}

output "nodes_ip" {
  value = module.re_vm.nodes_ip
}

output "nodes_dns" {
  value = module.re_vm.nodes_dns
}

output "admin_username" {
  value = var.RS_admin
}

output "admin_password" {
  value     = module.re_vm.admin_password
  sensitive = true
}

output "how_to_ssh" {
  value = "gcloud compute ssh ${module.re_vm.node1_name} --zone ${var.region_name}-${var.region_zones[0]}"
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
