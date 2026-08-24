variable "name_prefix" {
  type = string
}

variable "project" {
  type = string
}

variable "cluster_name" {
  type = string
}

variable "cluster_location" {
  type = string
}

variable "credentials_file" {
  type = string
}

variable "namespace" {
  type    = string
  default = "apps"
}

variable "outputs_dir" {
  type        = string
  description = "Directory where app deployment metadata is written"
}

variable "applications" {
  type = list(object({
    name     = string
    image    = string
    command  = string
    replicas = number
    ports    = list(number)
    env      = map(string)
    expose   = string
  }))
  default = []
}

locals {
  # A Kubernetes List of Deployments + Services, rendered as JSON (kubectl apply
  # accepts JSON manifests) so we avoid fragile YAML indentation in bash.
  manifest = jsonencode({
    apiVersion = "v1"
    kind       = "List"
    items = flatten([
      for a in var.applications : [
        {
          apiVersion = "apps/v1"
          kind       = "Deployment"
          metadata = {
            name      = a.name
            namespace = var.namespace
            labels    = { app = a.name }
          }
          spec = {
            replicas = a.replicas
            selector = { matchLabels = { app = a.name } }
            template = {
              metadata = { labels = { app = a.name } }
              spec = {
                containers = [
                  merge(
                    {
                      name  = a.name
                      image = a.image
                      env   = [for k, v in a.env : { name = k, value = v }]
                      ports = [for p in a.ports : { containerPort = p }]
                    },
                    trimspace(a.command) != "" ? { command = split(" ", trimspace(a.command)) } : {},
                  )
                ]
              }
            }
          }
        },
        {
          apiVersion = "v1"
          kind       = "Service"
          metadata = {
            name      = a.name
            namespace = var.namespace
            labels    = { app = a.name }
          }
          spec = {
            type     = contains(["lb", "http", "https"], a.expose) ? "LoadBalancer" : "ClusterIP"
            selector = { app = a.name }
            ports    = [for p in a.ports : { name = "p${p}", port = p, targetPort = p }]
          }
        },
      ]
    ])
  })

  app_names_csv = join(";", [for a in var.applications : a.name])
  # name~expose~p1,p2 per app; used to gather Service IPs for the outputs file.
  app_specs_csv = join(";", [for a in var.applications : "${a.name}~${a.expose}~${join(",", [for p in a.ports : tostring(p)])}"])
}

resource "null_resource" "apps" {
  # Destroy-time provisioners may only read `self`, so everything the teardown
  # needs is carried here rather than referenced as a variable.
  triggers = {
    cluster_name     = var.cluster_name
    cluster_location = var.cluster_location
    project          = var.project
    credentials_file = var.credentials_file
    namespace        = var.namespace
    outputs_dir      = var.outputs_dir
    app_names_csv    = local.app_names_csv
    manifest         = local.manifest
  }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    environment = {
      CREDENTIALS_FILE = var.credentials_file
      PROJECT          = var.project
      CLUSTER_NAME     = var.cluster_name
      CLUSTER_LOCATION = var.cluster_location
      NAMESPACE        = var.namespace
      OUTPUTS_DIR      = var.outputs_dir
      APP_SPECS_CSV    = local.app_specs_csv
      APPS_MANIFEST    = local.manifest
    }
    command = <<-EOT
      set -euo pipefail
      export CLOUDSDK_CORE_DISABLE_PROMPTS=1
      export GOOGLE_APPLICATION_CREDENTIALS="$CREDENTIALS_FILE"
      gcloud auth activate-service-account --key-file="$CREDENTIALS_FILE" --project="$PROJECT"
      gcloud container clusters get-credentials "$CLUSTER_NAME" --zone "$CLUSTER_LOCATION" --project "$PROJECT"

      kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

      printf '%s' "$APPS_MANIFEST" | kubectl apply -n "$NAMESPACE" -f -

      mkdir -p "$OUTPUTS_DIR"

      apps_json="["
      sep=""
      IFS=';' read -ra SPECS <<< "$APP_SPECS_CSV"
      for spec in "$${SPECS[@]}"; do
        NAME=$(echo "$spec" | cut -d'~' -f1)
        EXPOSE=$(echo "$spec" | cut -d'~' -f2)
        PORTS=$(echo "$spec" | cut -d'~' -f3)
        IP=""
        case "$EXPOSE" in
          lb|http|https)
            for i in $(seq 1 40); do
              IP=$(kubectl get svc -n "$NAMESPACE" "$NAME" -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
              if [ -n "$IP" ]; then
                break
              fi
              sleep 15
            done
            ;;
        esac
        if [ -z "$IP" ]; then
          IP=$(kubectl get svc -n "$NAMESPACE" "$NAME" -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)
        fi
        apps_json="$${apps_json}$${sep}{\"name\":\"$${NAME}\",\"service_ip\":\"$${IP}\",\"ports\":[$${PORTS}]}"
        sep=","
      done
      apps_json="$${apps_json}]"

      cat >"$OUTPUTS_DIR/app-outputs.json" <<JSON
{
  "namespace": "$${NAMESPACE}",
  "apps": $${apps_json}
}
JSON
    EOT
  }

  provisioner "local-exec" {
    when        = destroy
    interpreter = ["/bin/bash", "-c"]
    environment = {
      CREDENTIALS_FILE = self.triggers.credentials_file
      PROJECT          = self.triggers.project
      CLUSTER_NAME     = self.triggers.cluster_name
      CLUSTER_LOCATION = self.triggers.cluster_location
      NAMESPACE        = self.triggers.namespace
      APP_NAMES_CSV    = self.triggers.app_names_csv
    }
    command = <<-EOT
      set +e
      export CLOUDSDK_CORE_DISABLE_PROMPTS=1
      export GOOGLE_APPLICATION_CREDENTIALS="$CREDENTIALS_FILE"
      gcloud auth activate-service-account --key-file="$CREDENTIALS_FILE" --project="$PROJECT"
      gcloud container clusters get-credentials "$CLUSTER_NAME" --zone "$CLUSTER_LOCATION" --project "$PROJECT"
      IFS=';' read -ra NAMES <<< "$APP_NAMES_CSV"
      for n in "$${NAMES[@]}"; do
        [ -z "$n" ] && continue
        kubectl delete deploy "$n" -n "$NAMESPACE" --ignore-not-found --wait=false
        kubectl delete svc "$n" -n "$NAMESPACE" --ignore-not-found --wait=false
      done
      kubectl delete namespace "$NAMESPACE" --wait=false
      true
    EOT
  }
}

output "app_outputs_file" {
  value = "${var.outputs_dir}/app-outputs.json"
}
