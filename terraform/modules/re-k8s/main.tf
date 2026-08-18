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

locals {
  namespace = "rec-ns"
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
  create: true
  name: $${NAME_PREFIX}-rec
  spec:
    nodes: $${REC_NODES}
    uiServiceType: LoadBalancer
YAML

      if ! helm upgrade --install "$${NAME_PREFIX}-re" redis/redis-enterprise-operator \
        --namespace "$NAMESPACE" \
        --create-namespace \
        -f "$OUTPUTS_DIR/rec-values.yaml" \
        "$${CHART_ARGS[@]}" \
        --wait --timeout 20m; then
        # Bundle fallback when Helm chart is unavailable
        VERSION=$(curl -s https://api.github.com/repos/RedisLabs/redis-enterprise-k8s-docs/releases/latest | grep tag_name | cut -d '"' -f 4 || echo master)
        kubectl apply -n "$NAMESPACE" -f "https://raw.githubusercontent.com/RedisLabs/redis-enterprise-k8s-docs/$${VERSION}/bundle.yaml"
        cat <<YAML | kubectl apply -n "$NAMESPACE" -f -
apiVersion: app.redislabs.com/v1
kind: RedisEnterpriseCluster
metadata:
  name: $${NAME_PREFIX}-rec
spec:
  nodes: $${REC_NODES}
  uiServiceType: LoadBalancer
YAML
      fi

      if ! kubectl get rec -n "$NAMESPACE" "$${NAME_PREFIX}-rec" >/dev/null 2>&1; then
        cat <<YAML | kubectl apply -n "$NAMESPACE" -f -
apiVersion: app.redislabs.com/v1
kind: RedisEnterpriseCluster
metadata:
  name: $${NAME_PREFIX}-rec
spec:
  nodes: $${REC_NODES}
  uiServiceType: LoadBalancer
YAML
      fi

      for i in $(seq 1 60); do
        STATUS=$(kubectl get rec -n "$NAMESPACE" "$${NAME_PREFIX}-rec" -o jsonpath='{.status.state}' 2>/dev/null || true)
        if [ "$STATUS" = "Running" ]; then
          break
        fi
        sleep 15
      done

      UI_IP=""
      for i in $(seq 1 40); do
        UI_IP=$(kubectl get svc -n "$NAMESPACE" -o jsonpath='{.items[?(@.spec.type=="LoadBalancer")].status.loadBalancer.ingress[0].ip}' 2>/dev/null | awk '{print $1}')
        if [ -n "$UI_IP" ]; then
          break
        fi
        sleep 15
      done

      USERNAME=$(kubectl get secret -n "$NAMESPACE" "$${NAME_PREFIX}-rec" -o jsonpath='{.data.username}' 2>/dev/null | base64 -d || true)
      PASSWORD=$(kubectl get secret -n "$NAMESPACE" "$${NAME_PREFIX}-rec" -o jsonpath='{.data.password}' 2>/dev/null | base64 -d || true)

      cat >"$OUTPUTS_DIR/k8s-outputs.json" <<JSON
{
  "rec_ui_url": "$([ -n "$UI_IP" ] && echo "https://$${UI_IP}:8443" || echo "")",
  "admin_username": "$${USERNAME}",
  "admin_password": "$${PASSWORD}",
  "namespace": "$${NAMESPACE}",
  "rec_name": "$${NAME_PREFIX}-rec"
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
  value = "${var.name_prefix}-rec"
}

output "k8s_outputs_file" {
  value = "${var.outputs_dir}/k8s-outputs.json"
}
