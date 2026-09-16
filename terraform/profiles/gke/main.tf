locals {
  name_prefix = "${var.yourname}-${var.env}"
  # GKE nodes run as the default compute SA (with cloud-platform scope).
  compute_sa = "${data.google_project.current.number}-compute@developer.gserviceaccount.com"
}

data "google_project" "current" {}

module "storage" {
  source = "../../modules/storage"

  buckets          = var.storage_buckets
  compute_sa_email = local.compute_sa
  youremail        = var.youremail
}

module "pubsub" {
  source = "../../modules/pubsub"

  topics           = var.pubsub_topics
  compute_sa_email = local.compute_sa
  youremail        = var.youremail
}

module "bigquery" {
  source = "../../modules/bigquery"

  datasets         = var.bigquery_datasets
  compute_sa_email = local.compute_sa
  youremail        = var.youremail
}

module "cloudsql" {
  source = "../../modules/cloudsql"

  instances        = var.cloud_sql_instances
  region           = var.region_name
  vpc_id           = module.network.vpc_id
  compute_sa_email = local.compute_sa
  youremail        = var.youremail
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
  skip_deletion      = var.skip_deletion
  region_name        = var.region_name
  gke_clustersize    = var.gke_clustersize
  gke_machine_type   = var.gke_machine_type
  vpc_name           = module.network.vpc_name
  public_subnet_name = module.network.public_subnet_name
}

module "re_k8s" {
  source = "../../modules/re-k8s"

  name_prefix      = local.name_prefix
  project          = var.project
  cluster_name     = module.gke.cluster_name
  cluster_location = module.gke.location
  operators        = var.operators
  credentials_file = abspath(var.credentials)
  outputs_dir      = var.outputs_dir

  depends_on = [module.gke]
}

module "app_k8s" {
  source = "../../modules/app-k8s"
  count  = length(var.applications) > 0 ? 1 : 0

  name_prefix      = local.name_prefix
  project          = var.project
  cluster_name     = module.gke.cluster_name
  cluster_location = module.gke.location
  credentials_file = abspath(var.credentials)
  outputs_dir      = var.outputs_dir
  applications     = var.applications

  depends_on = [module.gke, module.re_k8s]
}

module "rdi_k8s" {
  source = "../../modules/rdi-k8s"
  count  = var.rdi_enabled ? 1 : 0

  name_prefix      = local.name_prefix
  project          = var.project
  cluster_name     = module.gke.cluster_name
  cluster_location = module.gke.location
  credentials_file = abspath(var.credentials)
  outputs_dir      = var.outputs_dir
  chart_version    = var.rdi.chart_version
  env              = var.rdi.env
  pipeline_config  = var.rdi.pipeline_config

  depends_on = [module.gke, module.re_k8s]
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

output "app_outputs_file" {
  value = length(module.app_k8s) > 0 ? module.app_k8s[0].app_outputs_file : ""
}

output "storage_buckets" {
  value = module.storage.buckets
}

output "pubsub_topics" {
  value = module.pubsub.topics
}

output "bigquery_datasets" {
  value = module.bigquery.datasets
}

output "cloud_sql_instances" {
  value = module.cloudsql.instances
}

output "rdi" {
  value = var.rdi_enabled ? {
    name      = var.rdi.name
    namespace = module.rdi_k8s[0].namespace
  } : null
}

output "deployment_mode" {
  value = "gke"
}

output "admin_username" {
  value = "see k8s-outputs.json (populated after operator install)"
}
