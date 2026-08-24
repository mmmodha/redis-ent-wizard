import type { MachineTypeInfo, RsReleaseInfo } from "@/lib/api";
import { DEFAULT_RS_VERSION } from "@/lib/useGcpLookups";
import type { DesignNodeData, NodeKind } from "@/lib/diagram";

function pick(machineTypes: MachineTypeInfo[], preferred: string[]): string {
  for (const p of preferred) {
    if (machineTypes.some((m) => m.name === p)) return p;
  }
  return machineTypes[0]?.name || "";
}

export function defaultNodeData(
  kind: NodeKind,
  machineTypes: MachineTypeInfo[],
  vmReleases: RsReleaseInfo[],
): DesignNodeData {
  const rsVersion = vmReleases[0]?.id || DEFAULT_RS_VERSION;
  switch (kind) {
    case "network":
      return { kind: "network", label: "VPC network" };
    case "gke":
      return {
        kind: "gke",
        label: "GKE cluster",
        gke_machine_type: pick(machineTypes, ["e2-standard-8", "n2-standard-8"]),
        gke_clustersize: 3,
      };
    case "cluster":
      return {
        kind: "cluster",
        name: "",
        nodes: 3,
        machine_type: pick(machineTypes, ["e2-standard-2", "n2-standard-2"]),
        rof_nvme_disks: 0,
        rs_version: rsVersion,
        rec_nodes: 3,
        license: "",
      };
    case "database":
      return {
        kind: "database",
        name: "",
        memory_gb: 1,
        replication: true,
        sharding: false,
        shards_count: 2,
        eviction_policy: "noeviction",
        port: 12000,
        password: "",
        modules: [],
        proxy_policy: "single",
        shards_placement: "dense",
        oss_cluster: false,
        flex: false,
      };
    case "vms":
      return {
        kind: "vms",
        name: "",
        count: 1,
        machine_type: pick(machineTypes, ["n2-standard-8", "e2-standard-4"]),
        disk_gib: 0,
        memviz_enabled: false,
        expose_http: false,
        expose_https: false,
        extra_ports: "",
      };
    case "application":
      return {
        kind: "application",
        name: "",
        command: "",
        ports: "",
        env: [],
        requirements: [],
        artifact: { kind: "upload", ref: "", type: "jar" },
        vm_count: 1,
        machine_type: pick(machineTypes, ["n2-standard-8", "e2-standard-4"]),
        disk_gib: 0,
        image: "",
        replicas: 1,
        expose: "none",
      };
    case "loadbalancer":
      return {
        kind: "loadbalancer",
        name: "",
        expose_http: true,
        expose_https: false,
        extra_ports: "",
      };
    default:
      return { kind: "network", label: "VPC network" };
  }
}
