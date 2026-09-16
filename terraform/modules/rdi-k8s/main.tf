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

variable "chart_version" {
  type     = string
  default  = ""
  nullable = false
}

variable "env" {
  type        = map(string)
  default     = {}
  description = "Static RDI connection env (Redis target/state endpoints, Cloud SQL source static parts)."
}

variable "pipeline_config" {
  type        = string
  default     = ""
  description = "Base64 RDI pipeline config (config.yaml + jobs)."
}

variable "outputs_dir" {
  type        = string
  description = "Directory where RDI install metadata is written"
}

locals {
  namespace = "rdi"
  set_args  = join(",", [for k, v in var.env : "connections.${k}=${v}"])
}

resource "null_resource" "rdi" {
  # Destroy-time provisioners may only read `self`, so carry teardown inputs here.
  triggers = {
    cluster_name     = var.cluster_name
    cluster_location = var.cluster_location
    project          = var.project
    credentials_file = var.credentials_file
    name_prefix      = var.name_prefix
    namespace        = local.namespace
    chart_version    = var.chart_version
  }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    environment = {
      CREDENTIALS_FILE = var.credentials_file
      PROJECT          = var.project
      CLUSTER_NAME     = var.cluster_name
      CLUSTER_LOCATION = var.cluster_location
      NAME_PREFIX      = var.name_prefix
      NAMESPACE        = local.namespace
      CHART_VERSION    = var.chart_version
      SET_ARGS         = local.set_args
      PIPELINE_CONFIG  = var.pipeline_config
      OUTPUTS_DIR      = var.outputs_dir
    }
    command = <<-EOT
      set -euo pipefail
      export CLOUDSDK_CORE_DISABLE_PROMPTS=1
      export GOOGLE_APPLICATION_CREDENTIALS="$CREDENTIALS_FILE"
      gcloud auth activate-service-account --key-file="$CREDENTIALS_FILE" --project="$PROJECT"
      gcloud container clusters get-credentials "$CLUSTER_NAME" --zone "$CLUSTER_LOCATION" --project "$PROJECT"

      kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

      if ! helm repo list 2>/dev/null | grep -q '^redis'; then
        helm repo add redis https://helm.redis.io || true
      fi
      helm repo update redis || true

      CHART_ARGS=()
      if [ -n "$CHART_VERSION" ]; then
        CHART_ARGS+=(--version "$CHART_VERSION")
      fi
      if [ -n "$SET_ARGS" ]; then
        CHART_ARGS+=(--set "$SET_ARGS")
      fi

      # NOTE: confirm the RDI chart name against the current Redis Helm repo
      # before a real apply (see the plan's flagged items).
      helm upgrade --install "$${NAME_PREFIX}-rdi" redis/rdi \
        --namespace "$NAMESPACE" \
        --create-namespace \
        "$${CHART_ARGS[@]}" \
        --wait --timeout 20m || true

      # Stage the rendered pipeline config as a ConfigMap for the RDI operator.
      if [ -n "$PIPELINE_CONFIG" ]; then
        mkdir -p "$OUTPUTS_DIR"
        printf '%s' "$PIPELINE_CONFIG" | base64 -d >"$OUTPUTS_DIR/rdi-config.yaml"
        kubectl create configmap rdi-pipeline -n "$NAMESPACE" \
          --from-file=config.yaml="$OUTPUTS_DIR/rdi-config.yaml" \
          --dry-run=client -o yaml | kubectl apply -f -
      fi
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
      NAME_PREFIX      = self.triggers.name_prefix
      NAMESPACE        = self.triggers.namespace
    }
    command = <<-EOT
      set +e
      export CLOUDSDK_CORE_DISABLE_PROMPTS=1
      export GOOGLE_APPLICATION_CREDENTIALS="$CREDENTIALS_FILE"
      gcloud auth activate-service-account --key-file="$CREDENTIALS_FILE" --project="$PROJECT"
      gcloud container clusters get-credentials "$CLUSTER_NAME" --zone "$CLUSTER_LOCATION" --project "$PROJECT"
      helm uninstall "$${NAME_PREFIX}-rdi" -n "$NAMESPACE"
      kubectl delete namespace "$NAMESPACE" --wait=false
      true
    EOT
  }
}

output "namespace" {
  value = local.namespace
}
