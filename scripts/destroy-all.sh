#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGISTRY="${ROOT_DIR}/data/instances.json"
DESTROY="${ROOT_DIR}/scripts/destroy-instance.sh"

if [[ ! -f "$REGISTRY" ]]; then
  echo "No registry at $REGISTRY"
  exit 0
fi

ids="$(python3 - "$REGISTRY" <<'PY'
import json, sys
from pathlib import Path
data = json.loads(Path(sys.argv[1]).read_text() or "[]")
for i in data:
    print(i.get("id",""))
PY
)"

if [[ -z "$ids" ]]; then
  echo "No instances registered."
  exit 0
fi

echo "This will destroy ALL registered instances:"
while IFS= read -r id; do
  [[ -z "$id" ]] && continue
  echo "  - $id"
done <<< "$ids"

read -r -p "Type 'destroy-all' to confirm: " confirm
if [[ "$confirm" != "destroy-all" ]]; then
  echo "Aborted."
  exit 1
fi

while IFS= read -r id; do
  [[ -z "$id" ]] && continue
  echo "==== Destroying $id ===="
  "$DESTROY" "$id" || echo "WARN: failed to destroy $id (continuing)"
done <<< "$ids"

echo "All destroy attempts finished."
