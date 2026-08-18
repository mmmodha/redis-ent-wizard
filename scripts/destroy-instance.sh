#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGISTRY="${ROOT_DIR}/data/instances.json"
TERRAFORM_BIN="${TERRAFORM_BIN:-terraform}"

usage() {
  echo "Usage: $0 <instance-id>"
  echo "       $0 --choose"
  echo
  echo "Destroys GCP resources for a registered instance using local Terraform state."
  echo "Works even when Docker Compose is stopped."
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

if [[ ! -f "$REGISTRY" ]]; then
  echo "No registry at $REGISTRY"
  exit 1
fi

choose_id() {
  local ids
  ids="$(python3 - "$REGISTRY" <<'PY'
import json, sys
from pathlib import Path
data = json.loads(Path(sys.argv[1]).read_text() or "[]")
for i in data:
    print(i.get("id",""))
PY
)"
  if [[ -z "$ids" ]]; then
    echo "No instances to destroy."
    exit 0
  fi
  echo "Select an instance to destroy:"
  local idx=1
  local -a arr=()
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    arr+=("$line")
    echo "  [$idx] $line"
    idx=$((idx + 1))
  done <<< "$ids"
  read -r -p "Number: " num
  if ! [[ "$num" =~ ^[0-9]+$ ]] || (( num < 1 || num > ${#arr[@]} )); then
    echo "Invalid selection"
    exit 1
  fi
  echo "${arr[$((num - 1))]}"
}

ID="$1"
if [[ "$ID" == "--choose" || "$ID" == "-i" ]]; then
  ID="$(choose_id)"
fi

INSTANCE_DIR="${ROOT_DIR}/data/instances/${ID}"
if [[ ! -d "$INSTANCE_DIR" ]]; then
  echo "Instance directory not found: $INSTANCE_DIR"
  exit 1
fi

if [[ ! -f "$INSTANCE_DIR/terraform.tfvars" ]]; then
  echo "Missing terraform.tfvars in $INSTANCE_DIR"
  exit 1
fi

echo "Destroying $ID ..."
cd "$INSTANCE_DIR"

if [[ ! -d .terraform ]]; then
  "$TERRAFORM_BIN" init -input=false
fi

"$TERRAFORM_BIN" destroy -auto-approve -input=false -var-file=terraform.tfvars

python3 - "$REGISTRY" "$ID" <<'PY'
import json, sys
from pathlib import Path
reg = Path(sys.argv[1])
target = sys.argv[2]
data = json.loads(reg.read_text() or "[]")
data = [i for i in data if i.get("id") != target]
reg.write_text(json.dumps(data, indent=2) + "\n")
print(f"Removed {target} from registry")
PY

echo "Done."
