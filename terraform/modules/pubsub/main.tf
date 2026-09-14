variable "topics" {
  type = list(object({
    name                = string
    create_subscription = bool
    grant_publisher     = bool
    grant_subscriber    = bool
  }))
  description = "Pub/Sub topics to create. grant_* grant the compute SA publisher/subscriber."
  default     = []
}

variable "compute_sa_email" {
  type        = string
  description = "Default compute service account granted publisher/subscriber on connected topics."
}

variable "youremail" {
  type    = string
  default = ""
}

locals {
  by_name    = { for t in var.topics : t.name => t }
  subs       = { for t in var.topics : t.name => t if t.create_subscription }
  pub_grants = { for t in var.topics : t.name => t if t.grant_publisher }
  sub_grants = { for t in var.topics : t.name => t if t.create_subscription && t.grant_subscriber }
  labels     = var.youremail != "" ? { created_by = var.youremail } : {}
}

resource "google_pubsub_topic" "topic" {
  for_each = local.by_name

  name   = each.value.name
  labels = local.labels
}

resource "google_pubsub_subscription" "sub" {
  for_each = local.subs

  name   = "${each.value.name}-sub"
  topic  = google_pubsub_topic.topic[each.key].name
  labels = local.labels
}

resource "google_pubsub_topic_iam_member" "publisher" {
  for_each = local.pub_grants

  topic  = google_pubsub_topic.topic[each.key].name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${var.compute_sa_email}"
}

resource "google_pubsub_subscription_iam_member" "subscriber" {
  for_each = local.sub_grants

  subscription = google_pubsub_subscription.sub[each.key].name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${var.compute_sa_email}"
}

output "topics" {
  value = [
    for k, t in google_pubsub_topic.topic : {
      name         = t.name
      topic        = "projects/${t.project}/topics/${t.name}"
      subscription = try("projects/${t.project}/subscriptions/${google_pubsub_subscription.sub[k].name}", "")
      project      = t.project
    }
  ]
}
