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

variable "rec_nodes" {
  type    = number
  default = 3
}

variable "credentials_file" {
  type = string
}

variable "operator_chart_version" {
  type     = string
  default  = ""
  nullable = false
}

variable "outputs_dir" {
  type        = string
  description = "Directory where operator install metadata is written"
}

variable "rec_specs" {
  type = list(object({
    name  = string
    nodes = number
  }))
  description = "REC clusters to create after the operator is installed. Empty uses name_prefix-rec with rec_nodes."
  default     = []
}

locals {
  namespace = "rec-ns"
  recs = length(var.rec_specs) > 0 ? var.rec_specs : [{
    name  = "${var.name_prefix}-rec"
    nodes = var.rec_nodes
  }]
  rec_spec_csv = join(",", [for r in local.recs : "${r.name}:${r.nodes}"])
}

resource "null_resource" "re_operator" {
  # Destroy-time provisioners may only read `self`, so everything the teardown
  # needs is carried here rather than referenced as a variable.
  triggers = {
    cluster_name     = var.cluster_name
    cluster_location = var.cluster_location
    project          = var.project
    credentials_file = var.credentials_file
    name_prefix      = var.name_prefix
    namespace        = local.namespace
    rec_nodes        = tostring(var.rec_nodes)
    rec_spec_csv     = local.rec_spec_csv
    outputs_dir      = var.outputs_dir
    chart_version    = var.operator_chart_version
  }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    environment = {
      CREDENTIALS_FILE = var.credentials_file
      PROJECT          = var.project
      CLUSTER_NAME     = var.cluster_name
      CLUSTER_LOCATION = var.cluster_location
      NAME_PREFIX      = var.name_prefix
      REC_NODES        = tostring(var.rec_nodes)
      REC_SPEC_CSV     = local.rec_spec_csv
      NAMESPACE        = local.namespace
      OUTPUTS_DIR      = var.outputs_dir
      CHART_VERSION    = var.operator_chart_version
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

      mkdir -p "$OUTPUTS_DIR"

      cat >"$OUTPUTS_DIR/rec-values.yaml" <<YAML
cluster:
  create: false
YAML

      if ! helm upgrade --install "$${NAME_PREFIX}-re" redis/redis-enterprise-operator \
        --namespace "$NAMESPACE" \
        --create-namespace \
        -f "$OUTPUTS_DIR/rec-values.yaml" \
        "$${CHART_ARGS[@]}" \
        --wait --timeout 20m; then
        VERSION=$(curl -s https://api.github.com/repos/RedisLabs/redis-enterprise-k8s-docs/releases/latest | grep tag_name | cut -d '"' -f 4 || echo master)
        kubectl apply -n "$NAMESPACE" -f "https://raw.githubusercontent.com/RedisLabs/redis-enterprise-k8s-docs/$${VERSION}/bundle.yaml"
      fi

      IFS=',' read -ra SPECS <<< "$REC_SPEC_CSV"
      FIRST_REC=""
      for spec in "$${SPECS[@]}"; do
        REC_NAME="$${spec%%:*}"
        REC_N="$${spec##*:}"
        if [ -z "$FIRST_REC" ]; then
          FIRST_REC="$REC_NAME"
        fi
        cat <<YAML | kubectl apply -n "$NAMESPACE" -f -
apiVersion: app.redislabs.com/v1
kind: RedisEnterpriseCluster
metadata:
  name: $${REC_NAME}
spec:
  nodes: $${REC_N}
  uiServiceType: LoadBalancer
YAML
      done

      for spec in "$${SPECS[@]}"; do
        REC_NAME="$${spec%%:*}"
        for i in $(seq 1 60); do
          STATUS=$(kubectl get rec -n "$NAMESPACE" "$REC_NAME" -o jsonpath='{.status.state}' 2>/dev/null || true)
          if [ "$STATUS" = "Running" ]; then
            break
          fi
          sleep 15
        done
      done

      recs_json="["
      first_ui=""
      first_user=""
      first_pass=""
      sep=""
      for spec in "$${SPECS[@]}"; do
        REC_NAME="$${spec%%:*}"
        UI_IP=""
        for i in $(seq 1 40); do
          UI_IP=$(kubectl get svc -n "$NAMESPACE" "$${REC_NAME}-ui" -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
          if [ -z "$UI_IP" ]; then
            UI_IP=$(kubectl get svc -n "$NAMESPACE" -l "redis.io/cluster=$${REC_NAME}" -o jsonpath='{.items[?(@.spec.type=="LoadBalancer")].status.loadBalancer.ingress[0].ip}' 2>/dev/null | awk '{print $1}')
          fi
          if [ -n "$UI_IP" ]; then
            break
          fi
          sleep 15
        done
        USERNAME=$(kubectl get secret -n "$NAMESPACE" "$REC_NAME" -o jsonpath='{.data.username}' 2>/dev/null | base64 -d || true)
        PASSWORD=$(kubectl get secret -n "$NAMESPACE" "$REC_NAME" -o jsonpath='{.data.password}' 2>/dev/null | base64 -d || true)
        UI_URL=""
        if [ -n "$UI_IP" ]; then
          UI_URL="https://$${UI_IP}:8443"
        fi
        if [ -z "$first_ui" ]; then
          first_ui="$UI_URL"
          first_user="$USERNAME"
          first_pass="$PASSWORD"
        fi
        recs_json="$${recs_json}$${sep}{\"name\":\"$${REC_NAME}\",\"ui\":\"$${UI_URL}\",\"admin_username\":\"$${USERNAME}\",\"admin_password\":\"$${PASSWORD}\"}"
        sep=","
      done
      recs_json="$${recs_json}]"

      cat >"$OUTPUTS_DIR/k8s-outputs.json" <<JSON
{
  "rec_ui_url": "$${first_ui}",
  "admin_username": "$${first_user}",
  "admin_password": "$${first_pass}",
  "namespace": "$${NAMESPACE}",
  "rec_name": "$${FIRST_REC}",
  "recs": $${recs_json}
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
      NAME_PREFIX      = self.triggers.name_prefix
      NAMESPACE        = self.triggers.namespace
    }
    command = <<-EOT
      set +e
      export CLOUDSDK_CORE_DISABLE_PROMPTS=1
      export GOOGLE_APPLICATION_CREDENTIALS="$CREDENTIALS_FILE"
      gcloud auth activate-service-account --key-file="$CREDENTIALS_FILE" --project="$PROJECT"
      gcloud container clusters get-credentials "$CLUSTER_NAME" --zone "$CLUSTER_LOCATION" --project "$PROJECT"
      helm uninstall "$${NAME_PREFIX}-re" -n "$NAMESPACE"
      kubectl delete rec -n "$NAMESPACE" --all --wait=false
      kubectl delete namespace "$NAMESPACE" --wait=false
      true
    EOT
  }
}

output "namespace" {
  value = local.namespace
}

output "rec_name" {
  value = local.recs[0].name
}

output "rec_names" {
  value = [for r in local.recs : r.name]
}

output "k8s_outputs_file" {
  value = "${var.outputs_dir}/k8s-outputs.json"
}
