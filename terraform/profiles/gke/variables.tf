variable "yourname" {
  type = string
}

variable "youremail" {
  type = string
}

variable "credentials" {
  type = string
}

variable "project" {
  type = string
}

variable "env" {
  type    = string
  default = "default"
}

variable "region_name" {
  type    = string
  default = "europe-west1"
}

variable "gke_clustersize" {
  type    = number
  default = 3
}

variable "gke_machine_type" {
  type    = string
  default = "e2-standard-8"
}

variable "rec_nodes" {
  type    = number
  default = 3
}

variable "dns_managed_zone" {
  type    = string
  default = "demo-clusters"
}

variable "dns_zone_dns_name" {
  type    = string
  default = "demo.redislabs.com"
}

variable "rs_private_subnet" {
  type    = string
  default = "10.26.1.0/24"
}

variable "rs_public_subnet" {
  type    = string
  default = "10.26.2.0/24"
}

variable "outputs_dir" {
  type = string
}

variable "operator_chart_version" {
  type    = string
  default = ""
}

variable "rec_specs" {
  type = list(object({
    name  = string
    nodes = number
  }))
  default = []
}
