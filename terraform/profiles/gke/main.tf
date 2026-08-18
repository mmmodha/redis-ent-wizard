locals {
  name_prefix = "${var.yourname}-${var.env}"
}

module "network" {
  source = "../../modules/network"

  name_prefix       = local.name_prefix
  region_name       = var.region_name
  rs_private_subnet = var.rs_private_subnet
  rs_public_subnet  = var.rs_public_subnet
  memviz_enabled    = false
  app_count         = 0
}

module "gke" {
  source = "../../modules/gke"

  name_prefix        = local.name_prefix
  youremail          = var.youremail
  region_name        = var.region_name
  gke_clustersize    = var.gke_clustersize
  gke_machine_type   = var.gke_machine_type
  vpc_name           = module.network.vpc_name
  public_subnet_name = module.network.public_subnet_name
}

module "re_k8s" {
  source = "../../modules/re-k8s"

  name_prefix            = local.name_prefix
  project                = var.project
  cluster_name           = module.gke.cluster_name
  cluster_location       = module.gke.location
  rec_nodes              = var.rec_nodes
  rec_specs              = var.rec_specs
  credentials_file       = abspath(var.credentials)
  outputs_dir            = var.outputs_dir
  operator_chart_version = var.operator_chart_version

  depends_on = [module.gke]
}

output "how_to_kubectl" {
  value = module.gke.how_to_kubectl
}

output "gke_cluster_name" {
  value = module.gke.cluster_name
}

output "gke_cluster_endpoint" {
  value = module.gke.cluster_endpoint
}

output "rec_name" {
  value = module.re_k8s.rec_name
}

output "rec_names" {
  value = module.re_k8s.rec_names
}

output "rec_namespace" {
  value = module.re_k8s.namespace
}

output "k8s_outputs_file" {
  value = module.re_k8s.k8s_outputs_file
}

output "deployment_mode" {
  value = "gke"
}

output "admin_username" {
  value = "see k8s-outputs.json (populated after operator install)"
}
