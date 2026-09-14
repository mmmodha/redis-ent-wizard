"use client";

import "@xyflow/react/dist/style.css";
import "@/app/design/design.css";

import { useEffect, useMemo, useState } from "react";
import { Background, Controls, ReactFlow, ReactFlowProvider, type Node } from "@xyflow/react";
import { DesignProvider } from "@/components/design/DesignContext";
import { nodeTypes } from "@/components/design/nodes";
import { listMachineTypes, type MachineTypeInfo } from "@/lib/api";
import { gcpProbeZone } from "@/lib/cluster-capacity";
import {
  createInputToDiagram,
  type DesignNode,
  type DesignSettings,
} from "@/lib/diagram";
import { overlayInstanceLive, type DatabaseLiveState } from "@/lib/instance-live";

type SpecRow = { label: string; value: string };

function rowsFor(node: DesignNode): SpecRow[] {
  const d = node.data;
  const rows: SpecRow[] = [];
  const add = (label: string, value: unknown) => {
    const v = value === undefined || value === null || value === "" ? "" : String(value);
    if (v) rows.push({ label, value: v });
  };
  add("Kind", d.kind);
  if (d.kind === "cluster") {
    add("Name", d.name);
    add("Nodes", d.nodes);
    add("REC nodes", d.rec_nodes);
    add("Machine type", d.machine_type);
    add("Redis version", d.rs_version);
    add("NVMe disks", d.rof_nvme_disks);
    add("License", d.license ? "configured" : "");
  } else if (d.kind === "database") {
    add("Name", d.name);
    add("Memory", `${d.memory_gb} GB`);
    add("Replication", d.replication ? "on" : "off");
    add("Sharding", d.sharding ? `${d.shards_count} shards` : "off");
    add("Port", d.port);
    add("Modules", d.modules?.join(", "));
    add("OSS Cluster API", d.oss_cluster ? "on" : "");
    add("Flex", d.flex ? "on" : "");
  } else if (d.kind === "application") {
    add("Name", d.name);
    add("Command", d.command);
    add("Source", d.artifact?.kind === "git" ? d.artifact.ref : d.artifact?.ref || d.image);
    add("Branch", d.artifact?.branch);
    add("Run with Docker", d.artifact?.runInDocker ? "yes" : "");
    add("Requirements", d.requirements?.join(", "));
    add("VM count", d.vm_count);
    add("Machine type", d.machine_type);
    add("Ports", d.ports);
  } else if (d.kind === "vms") {
    add("Count", d.count);
    add("Machine type", d.machine_type);
    add("Disk", d.disk_gib ? `${d.disk_gib} GiB` : "");
    add("HTTP", d.expose_http ? "open" : "");
    add("HTTPS", d.expose_https ? "open" : "");
  } else if (d.kind === "loadbalancer") {
    add("Name", d.name);
    add("HTTP", d.expose_http ? ":80" : "");
    add("HTTPS", d.expose_https ? ":443" : "");
    add("Extra ports", d.extra_ports);
  } else if (d.kind === "gke") {
    add("GKE nodes", d.gke_clustersize);
    add("Machine type", d.gke_machine_type);
  }
  add("Status", d.liveStatus as string | undefined);
  add("Live", d.liveDetail as string | undefined);
  return rows;
}

function SpecPanel({ node }: { node: DesignNode | null }) {
  if (!node) {
    return (
      <div className="instance-spec">
        <h3>Specs</h3>
        <p className="instance-spec-empty">Click a cluster, database, or application to see what was provisioned.</p>
      </div>
    );
  }
  const title =
    node.data.kind === "cluster"
      ? node.data.name.trim() || "Redis cluster"
      : node.data.kind === "database"
        ? node.data.name.trim() || "Database"
        : node.data.kind === "application"
          ? node.data.name.trim() || "Application"
          : node.data.kind;
  return (
    <div className="instance-spec">
      <h3>{title}</h3>
      <dl>
        {rowsFor(node).map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd className={row.label === "Live" || row.label === "Command" ? "mono" : undefined}>{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function InstanceDiagramCanvas({
  nodes,
  edges,
  settings,
  machineTypes,
  onSelect,
}: {
  nodes: DesignNode[];
  edges: ReturnType<typeof createInputToDiagram>["edges"];
  settings: DesignSettings;
  machineTypes: MachineTypeInfo[];
  onSelect: (node: DesignNode | null) => void;
}) {
  return (
    <DesignProvider value={{ machineTypes, nodes, settings, capacityIfUnavailable: "hide" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        panOnDrag
        zoomOnScroll
        minZoom={0.4}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, n: Node) => onSelect(n as DesignNode)}
        onPaneClick={() => onSelect(null)}
        fitView
        fitViewOptions={{ padding: 0.16 }}
      >
        <Background gap={18} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </DesignProvider>
  );
}

export function InstanceDiagram({
  config,
  mode,
  databaseStates,
  endpoints,
  credentialsFile,
  project,
  region,
}: {
  config: Record<string, unknown>;
  mode: "vm" | "gke";
  databaseStates?: DatabaseLiveState[];
  endpoints?: Record<string, unknown>;
  credentialsFile?: string;
  project?: string;
  region?: string;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [machineTypes, setMachineTypes] = useState<MachineTypeInfo[]>([]);
  const { nodes: rawNodes, edges } = useMemo(() => createInputToDiagram(config, mode), [config, mode]);
  const probeZone = gcpProbeZone(
    region || String(config.region_name || ""),
    Array.isArray(config.region_zones) ? (config.region_zones as string[]) : undefined,
  );
  const cred = credentialsFile?.trim() || "";
  const proj = project?.trim() || String(config.project || "").trim();

  useEffect(() => {
    if (!cred || !proj || !probeZone) {
      setMachineTypes([]);
      return;
    }
    let cancelled = false;
    listMachineTypes(cred, proj, probeZone)
      .then((list) => {
        if (!cancelled) setMachineTypes(list);
      })
      .catch(() => {
        if (!cancelled) setMachineTypes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [cred, proj, probeZone]);
  const nodes = useMemo(
    () => overlayInstanceLive(rawNodes, { databaseStates, endpoints }),
    [rawNodes, databaseStates, endpoints],
  );
  const selected = nodes.find((n) => n.id === selectedId) || null;
  const settings: DesignSettings = {
    name: String(config.name || ""),
    env: String(config.env || "default"),
    folder: String(config.folder || ""),
    youremail: String(config.youremail || ""),
    skip_deletion: Boolean(config.skip_deletion),
    mode,
    RS_admin: String(config.RS_admin || ""),
    operator_chart_version: String(config.operator_chart_version || ""),
    credentialsFile: "",
    project: String(config.project || ""),
    region_name: String(config.region_name || ""),
    region_zones: Array.isArray(config.region_zones) ? (config.region_zones as string[]) : [],
    dns_managed_zone: String(config.dns_managed_zone || ""),
    dns_zone_dns_name: String(config.dns_zone_dns_name || ""),
  };

  return (
    <div className="instance-diagram-layout">
      <div className="design-canvas-wrap instance-diagram-canvas">
        <ReactFlowProvider>
          <InstanceDiagramCanvas
            nodes={nodes}
            edges={edges}
            settings={settings}
            machineTypes={machineTypes}
            onSelect={(n) => setSelectedId(n?.id || null)}
          />
        </ReactFlowProvider>
      </div>
      <SpecPanel node={selected} />
    </div>
  );
}
