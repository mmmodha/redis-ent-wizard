variable "buckets" {
  type = list(object({
    name          = string
    location      = string
    storage_class = string
    versioning    = bool
    force_destroy = bool
    grant_role    = string
  }))
  description = "Cloud Storage buckets to create. grant_role != \"\" grants the compute SA that role."
  default     = []
}

variable "compute_sa_email" {
  type        = string
  description = "Default compute service account the VMs/GKE nodes run as; granted access to connected buckets."
}

variable "youremail" {
  type    = string
  default = ""
}

locals {
  by_name = { for b in var.buckets : b.name => b }
  # Only buckets a consumer connects to get an IAM binding.
  grants = { for b in var.buckets : b.name => b if trimspace(b.grant_role) != "" }
  labels = var.youremail != "" ? { created_by = var.youremail } : {}
}

resource "google_storage_bucket" "bucket" {
  for_each = local.by_name

  name                        = each.value.name
  location                    = upper(each.value.location)
  storage_class               = each.value.storage_class
  force_destroy               = each.value.force_destroy
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning {
    enabled = each.value.versioning
  }

  labels = local.labels
}

# Grant the deployment's compute service account access to connected buckets.
# All VMs/GKE nodes share the default compute SA, so access is deployment-level.
resource "google_storage_bucket_iam_member" "grant" {
  for_each = local.grants

  bucket = google_storage_bucket.bucket[each.key].name
  role   = each.value.grant_role
  member = "serviceAccount:${var.compute_sa_email}"
}

output "buckets" {
  value = [
    for k, b in google_storage_bucket.bucket : {
      name     = b.name
      url      = "gs://${b.name}"
      location = b.location
    }
  ]
}
