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

variable "clustersize" {
  type    = number
  default = 3
}

variable "RS_release" {
  type    = string
  default = "https://s3.amazonaws.com/redis-enterprise-software-downloads/8.2.0/redislabs-8.2.0-46-jammy-amd64.tar"
}

variable "machine_type" {
  type    = string
  default = "e2-standard-2"
}

variable "env" {
  type    = string
  default = "default"
}

variable "RS_admin" {
  type    = string
  default = "admin@redis.io"
}

variable "region_name" {
  type    = string
  default = "europe-west1"
}

variable "rof_nvme_disks" {
  type    = number
  default = 0
}

variable "app" {
  type    = number
  default = 0
}

variable "app_machine_types" {
  type    = list(string)
  default = []
}

variable "memviz_enabled" {
  type    = bool
  default = false
}

variable "app_expose_http" {
  type    = bool
  default = false
}

variable "app_expose_https" {
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

variable "region_zones" {
  type    = list(string)
  default = ["b", "c", "d"]
}

variable "ssh_public_key" {
  type = string
}
