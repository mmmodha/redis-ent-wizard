variable "datasets" {
  type = list(object({
    name          = string
    location      = string
    grant_role    = string
    grant_jobuser = bool
  }))
  description = "BigQuery datasets to create. grant_role grants the compute SA on the dataset; grant_jobuser adds project bigquery.jobUser."
  default     = []
}

variable "compute_sa_email" {
  type        = string
  description = "Default compute service account granted access to connected datasets."
}

variable "youremail" {
  type    = string
  default = ""
}

locals {
  by_name       = { for d in var.datasets : d.name => d }
  role_grants   = { for d in var.datasets : d.name => d if trimspace(d.grant_role) != "" }
  needs_jobuser = anytrue([for d in var.datasets : d.grant_jobuser])
  labels        = var.youremail != "" ? { created_by = var.youremail } : {}
}

resource "google_bigquery_dataset" "dataset" {
  for_each = local.by_name

  dataset_id                 = each.value.name
  location                   = upper(each.value.location)
  delete_contents_on_destroy = true
  labels                     = local.labels
}

resource "google_bigquery_dataset_iam_member" "access" {
  for_each = local.role_grants

  dataset_id = google_bigquery_dataset.dataset[each.key].dataset_id
  role       = each.value.grant_role
  member     = "serviceAccount:${var.compute_sa_email}"
}

# Running queries/loads needs project-level jobUser; one binding for the shared SA.
resource "google_project_iam_member" "job_user" {
  count = local.needs_jobuser ? 1 : 0

  project = google_bigquery_dataset.dataset[keys(local.by_name)[0]].project
  role    = "roles/bigquery.jobUser"
  member  = "serviceAccount:${var.compute_sa_email}"
}

output "datasets" {
  value = [
    for k, d in google_bigquery_dataset.dataset : {
      name     = d.dataset_id
      project  = d.project
      location = d.location
    }
  ]
}
