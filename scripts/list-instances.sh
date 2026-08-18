#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGISTRY="${ROOT_DIR}/data/instances.json"

if [[ ! -f "$REGISTRY" ]]; then
  echo "No registry found at $REGISTRY"
  exit 0
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required"
  exit 1
fi

python3 - "$REGISTRY" <<'PY'
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
data = json.loads(path.read_text() or "[]")
if not data:
    print("No instances registered.")
    raise SystemExit(0)
print(f"{'ID':<28} {'MODE':<5} {'STATUS':<14} {'REGION':<16} CREATED")
print("-" * 92)
for i in data:
    endpoints = i.get("endpoints") or {}
    ui = endpoints.get("rs_ui_ip") or endpoints.get("rec_ui_url") or ""
    health = i.get("health") or {}
    print(f"{i.get('id',''):<28} {i.get('mode',''):<5} {i.get('status',''):<14} {i.get('region',''):<16} {i.get('createdAt','')}")
    if health and i.get("status") != "ready":
        print(f"  cluster: {health.get('nodesActive', 0)}/{health.get('nodesExpected', 0)} nodes - {health.get('detail', '')}")
    if ui:
        print(f"  UI: {ui}")
PY
