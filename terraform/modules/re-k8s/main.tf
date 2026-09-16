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

variable "outputs_dir" {
  type        = string
  description = "Directory where operator install metadata is written"
}

variable "operators" {
  type = list(object({
    name          = string
    namespace     = string
    chart_version = string
    recs = list(object({
      name  = string
      nodes = number
    }))
  }))
  description = "Redis Operators to install; each installs one Helm release into its namespace and owns its RECs. Empty falls back to a single default operator."
  default     = []
}

locals {
  operators = length(var.operators) > 0 ? var.operators : [{
    name          = "operator"
    namespace     = "rec-ns"
    chart_version = ""
    recs = [{
      name  = "${var.name_prefix}-rec"
      nodes = 3
    }]
  }]

  # Flat list of every REC across all operators, for the deployment-wide outputs.
  all_recs = flatten([for op in local.operators : op.recs])

  # Compact, jq-free encoding the provisioners parse in bash:
  #   operators joined by ';', each "name|namespace|chart_version|rec:nodes,rec:nodes"
  operators_enc = join(";", [
    for op in local.operators :
    format("%s|%s|%s|%s",
      op.name,
      op.namespace,
      op.chart_version,
      join(",", [for r in op.recs : "${r.name}:${r.nodes}"]),
    )
  ])
}

resource "null_resource" "re_operator" {
  # Destroy-time provisioners may only read `self`, so everything the teardown
  # needs (the per-operator name|namespace list) is carried here.
  triggers = {
    cluster_name     = var.cluster_name
    cluster_location = var.cluster_location
    project          = var.project
    credentials_file = var.credentials_file
    name_prefix      = var.name_prefix
    outputs_dir      = var.outputs_dir
    operators_enc    = local.operators_enc
  }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    environment = {
      CREDENTIALS_FILE = var.credentials_file
      PROJECT          = var.project
      CLUSTER_NAME     = var.cluster_name
      CLUSTER_LOCATION = var.cluster_location
      NAME_PREFIX      = var.name_prefix
      OUTPUTS_DIR      = var.outputs_dir
      OPERATORS_ENC    = local.operators_enc
    }
    command = <<-EOT
      set -euo pipefail
      export CLOUDSDK_CORE_DISABLE_PROMPTS=1
      export GOOGLE_APPLICATION_CREDENTIALS="$CREDENTIALS_FILE"
      gcloud auth activate-service-account --key-file="$CREDENTIALS_FILE" --project="$PROJECT"
      gcloud container clusters get-credentials "$CLUSTER_NAME" --zone "$CLUSTER_LOCATION" --project "$PROJECT"

      if ! helm repo list 2>/dev/null | grep -q '^redis'; then
        helm repo add redis https://helm.redis.io || true
      fi
      helm repo update redis || true

      mkdir -p "$OUTPUTS_DIR"
      cat >"$OUTPUTS_DIR/rec-values.yaml" <<YAML
cluster:
  create: false
YAML

      recs_json="["
      first_ui=""
      first_user=""
      first_pass=""
      first_rec=""
      first_ns=""
      sep=""

      # One operator per ';'-separated record: name|namespace|chart|rec:nodes,rec:nodes
      IFS=';' read -ra OPS <<< "$OPERATORS_ENC"
      for openc in "$${OPS[@]}"; do
        OP_NAME="$${openc%%|*}"; rest="$${openc#*|}"
        OP_NS="$${rest%%|*}"; rest="$${rest#*|}"
        OP_CHART="$${rest%%|*}"; REC_CSV="$${rest#*|}"
        if [ -z "$first_ns" ]; then first_ns="$OP_NS"; fi

        kubectl create namespace "$OP_NS" --dry-run=client -o yaml | kubectl apply -f -

        CHART_ARGS=()
        if [ -n "$OP_CHART" ]; then
          CHART_ARGS+=(--version "$OP_CHART")
        fi

        if ! helm upgrade --install "$${NAME_PREFIX}-$${OP_NAME}-re" redis/redis-enterprise-operator \
          --namespace "$OP_NS" \
          --create-namespace \
          -f "$OUTPUTS_DIR/rec-values.yaml" \
          "$${CHART_ARGS[@]}" \
          --wait --timeout 20m; then
          VERSION=$(curl -s https://api.github.com/repos/RedisLabs/redis-enterprise-k8s-docs/releases/latest | grep tag_name | cut -d '"' -f 4 || echo master)
          kubectl apply -n "$OP_NS" -f "https://raw.githubusercontent.com/RedisLabs/redis-enterprise-k8s-docs/$${VERSION}/bundle.yaml"
        fi

        IFS=',' read -ra SPECS <<< "$REC_CSV"
        for spec in "$${SPECS[@]}"; do
          REC_NAME="$${spec%%:*}"
          REC_N="$${spec##*:}"
          cat <<YAML | kubectl apply -n "$OP_NS" -f -
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
            STATUS=$(kubectl get rec -n "$OP_NS" "$REC_NAME" -o jsonpath='{.status.state}' 2>/dev/null || true)
            if [ "$STATUS" = "Running" ]; then
              break
            fi
            sleep 15
          done
        done

        for spec in "$${SPECS[@]}"; do
          REC_NAME="$${spec%%:*}"
          UI_IP=""
          for i in $(seq 1 40); do
            UI_IP=$(kubectl get svc -n "$OP_NS" "$${REC_NAME}-ui" -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
            if [ -z "$UI_IP" ]; then
              UI_IP=$(kubectl get svc -n "$OP_NS" -l "redis.io/cluster=$${REC_NAME}" -o jsonpath='{.items[?(@.spec.type=="LoadBalancer")].status.loadBalancer.ingress[0].ip}' 2>/dev/null | awk '{print $1}')
            fi
            if [ -n "$UI_IP" ]; then
              break
            fi
            sleep 15
          done
          USERNAME=$(kubectl get secret -n "$OP_NS" "$REC_NAME" -o jsonpath='{.data.username}' 2>/dev/null | base64 -d || true)
          PASSWORD=$(kubectl get secret -n "$OP_NS" "$REC_NAME" -o jsonpath='{.data.password}' 2>/dev/null | base64 -d || true)
          UI_URL=""
          if [ -n "$UI_IP" ]; then
            UI_URL="https://$${UI_IP}:8443"
          fi
          if [ -z "$first_ui" ]; then
            first_ui="$UI_URL"
            first_user="$USERNAME"
            first_pass="$PASSWORD"
            first_rec="$REC_NAME"
          fi
          recs_json="$${recs_json}$${sep}{\"name\":\"$${REC_NAME}\",\"ui\":\"$${UI_URL}\",\"admin_username\":\"$${USERNAME}\",\"admin_password\":\"$${PASSWORD}\",\"namespace\":\"$${OP_NS}\"}"
          sep=","
        done
      done
      recs_json="$${recs_json}]"

      cat >"$OUTPUTS_DIR/k8s-outputs.json" <<JSON
{
  "rec_ui_url": "$${first_ui}",
  "admin_username": "$${first_user}",
  "admin_password": "$${first_pass}",
  "namespace": "$${first_ns}",
  "rec_name": "$${first_rec}",
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
      OPERATORS_ENC    = self.triggers.operators_enc
    }
    command = <<-EOT
      set +e
      export CLOUDSDK_CORE_DISABLE_PROMPTS=1
      export GOOGLE_APPLICATION_CREDENTIALS="$CREDENTIALS_FILE"
      gcloud auth activate-service-account --key-file="$CREDENTIALS_FILE" --project="$PROJECT"
      gcloud container clusters get-credentials "$CLUSTER_NAME" --zone "$CLUSTER_LOCATION" --project "$PROJECT"
      IFS=';' read -ra OPS <<< "$OPERATORS_ENC"
      for openc in "$${OPS[@]}"; do
        OP_NAME="$${openc%%|*}"; rest="$${openc#*|}"
        OP_NS="$${rest%%|*}"
        helm uninstall "$${NAME_PREFIX}-$${OP_NAME}-re" -n "$OP_NS"
        kubectl delete rec -n "$OP_NS" --all --wait=false
        kubectl delete namespace "$OP_NS" --wait=false
      done
      true
    EOT
  }
}

output "namespace" {
  value = local.operators[0].namespace
}

output "rec_name" {
  value = local.all_recs[0].name
}

output "rec_names" {
  value = [for r in local.all_recs : r.name]
}

output "k8s_outputs_file" {
  value = "${var.outputs_dir}/k8s-outputs.json"
}
