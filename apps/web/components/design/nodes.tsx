"use client";

import { useState } from "react";
import { Handle, Position, type NodeProps, type NodeTypes } from "@xyflow/react";
import { BrandIcon, type IconName } from "@/components/design/BrandIcon";
import { clusterCapacityMB, useDesignContext } from "@/components/design/DesignContext";
import { clusterCapacityCaption, clusterCapacityClass } from "@/lib/cluster-capacity";
import { exposedVariables, predictedDatabaseEndpoint } from "@/lib/diagram";
import { clusterRedisNodeCount, effectiveDbReplication } from "@/lib/db-replication";
import type {
  ApplicationData,
  BigqueryData,
  CloudSqlData,
  ClusterData,
  DatabaseData,
  LoadBalancerData,
  NodeKind,
  PubsubData,
  RdiData,
  RootData,
  StorageData,
  VmsData,
} from "@/lib/diagram";

function NodeHeader({ icon, title, tag }: { icon: IconName; title: string; tag?: string }) {
  return (
    <div className="design-node-head">
      <BrandIcon name={icon} size={16} />
      <span className="design-node-title">{title}</span>
      {tag ? <span className="design-node-tag mono">{tag}</span> : null}
    </div>
  );
}

/** Compact list of the env vars this provider injects into wired consumers. */
function ExposesLine({ kind, name }: { kind: NodeKind; name: string }) {
  const vars = exposedVariables(kind, name);
  if (!vars.length) return null;
  return (
    <div
      className="design-exposes mono"
      title={vars.map((v) => `${v.name} — ${v.description}`).join("\n")}
    >
      <span className="design-exposes-label">exposes</span> {vars.map((v) => v.name).join(" · ")}
    </div>
  );
}

export function RootNode({ data }: NodeProps) {
  const d = data as RootData;
  const gke = d.kind === "gke";
  return (
    <div className={`design-root design-root-${d.kind}`}>
      <div className="design-root-head">
        <BrandIcon name={gke ? "gke" : "network"} size={16} />
        <span className="design-node-title">{d.label}</span>
        {gke ? (
          <span className="design-node-tag mono">
            {d.gke_clustersize ?? "?"} × {d.gke_machine_type || "node"}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function ClusterNode({ id, data }: NodeProps) {
  const d = data as ClusterData;
  const { machineTypes, nodes, capacityIfUnavailable = "pending" } = useDesignContext();
  const parentId = nodes.find((x) => x.id === id)?.parentId;
  const gke = nodes.some((n) => n.id === parentId && n.data.kind === "gke");
  const count = gke ? d.rec_nodes : d.nodes;
  const cap = clusterCapacityMB(id, count, d.machine_type, machineTypes, nodes);
  const catalogReady = Boolean(machineTypes.find((m) => m.name === d.machine_type)?.memoryMb);
  const capInput = {
    catalogReady,
    remainingMB: cap.remainingMB,
    ifUnavailable: capacityIfUnavailable,
  };
  const caption = clusterCapacityCaption(capInput);
  const capClass = clusterCapacityClass(capInput);
  return (
    <div className="design-cluster">
      <Handle type="target" position={Position.Left} className="design-hit" />
      <NodeHeader icon="cluster" title={d.name.trim() || "Redis cluster"} tag={`${count} nodes`} />
      <div className="design-node-meta mono">{d.machine_type || "machine type"}</div>
      {caption ? <div className={`design-cap ${capClass}`.trim()}>{caption}</div> : null}
      <ExposesLine kind="cluster" name={d.name.trim()} />
    </div>
  );
}

export function DatabaseNode({ id, data }: NodeProps) {
  const d = data as DatabaseData;
  const [copied, setCopied] = useState(false);
  const { nodes, settings } = useDesignContext();
  const clusters = nodes.filter((n) => n.data.kind === "cluster");
  const parentId = nodes.find((n) => n.id === id)?.parentId;
  const clusterIndex = clusters.findIndex((c) => c.id === parentId);
  const clusterNameRaw = ((clusters[clusterIndex]?.data as { name?: string } | undefined)?.name) || "";
  const parentCluster = clusters[clusterIndex]?.data as ClusterData | undefined;
  const ha = effectiveDbReplication(
    Boolean(d.replication),
    clusterRedisNodeCount(parentCluster, settings?.mode || "vm"),
  );
  const ep = settings
    ? predictedDatabaseEndpoint(settings, clusterNameRaw, clusterIndex < 0 ? 0 : clusterIndex, d.port)
    : null;
  return (
    <div className={`design-db${d.rdiInternal ? " design-db-rdi" : ""}`}>
      <Handle type="target" position={Position.Left} className="design-hit" />
      <NodeHeader
        icon="database"
        title={d.name.trim() || "database"}
        tag={d.rdiInternal ? "RDI state" : undefined}
      />
      <div className="design-node-meta mono">{d.memory_gb} GB</div>
      <div className="design-badges">
        {d.rdiInternal ? <span className="design-badge design-badge-rdi">managed by RDI</span> : null}
        {ha ? <span className="design-badge">HA</span> : null}
        {d.liveStatus ? (
          <span className={`design-badge design-badge-live design-badge-${d.liveStatus}`}>{String(d.liveStatus)}</span>
        ) : null}
        {d.sharding ? <span className="design-badge">{d.shards_count}× sharded</span> : null}
      </div>
      {ep ? (
        <div className="design-db-endpoint mono" title={ep.resolved ? ep.endpoint : ep.note}>
          <span className="design-db-endpoint-label">endpoint</span>
          <span className="design-db-endpoint-value">
            {ep.resolved ? ep.endpoint : `${ep.endpoint} — ${ep.note}`}
          </span>
          {ep.resolved ? (
            <button
              type="button"
              className="nodrag design-db-copy"
              title="Copy endpoint to clipboard"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                navigator.clipboard
                  ?.writeText(ep.endpoint)
                  .then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  })
                  .catch(() => {});
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          ) : null}
        </div>
      ) : null}
      <ExposesLine kind="database" name={d.name.trim()} />
    </div>
  );
}

export function VmsNode({ data }: NodeProps) {
  const d = data as VmsData;
  const extras = [
    d.memviz_enabled ? "memviz" : null,
    d.expose_http ? "80" : null,
    d.expose_https ? "443" : null,
    d.extra_ports?.trim() ? d.extra_ports.trim() : null,
  ].filter(Boolean);
  return (
    <div className="design-vms">
      <Handle type="target" position={Position.Left} className="design-hit" />
      <NodeHeader icon="vm" title={d.name.trim() || "Set of VMs"} tag={`${d.count} VMs`} />
      <div className="design-node-meta mono">{d.machine_type || "machine type"}</div>
      {extras.length ? <div className="design-node-meta mono">{extras.join(" · ")}</div> : null}
      <ExposesLine kind="vms" name="app" />
      <Handle type="source" position={Position.Right} className="design-handle" />
    </div>
  );
}

export function ApplicationNode({ data }: NodeProps) {
  const d = data as ApplicationData;
  const summary =
    d.artifact && d.artifact.ref
      ? d.artifact.kind === "git"
        ? `github: ${d.artifact.ref}`
        : `${d.artifact.kind}: ${d.artifact.ref}`
      : d.image
        ? d.image
        : "no source yet";
  return (
    <div className="design-app">
      <Handle type="target" position={Position.Left} className="design-hit" />
      <NodeHeader icon="application" title={d.name.trim() || "Application"} />
      <div className="design-node-meta mono">{summary}</div>
      {d.liveStatus ? (
        <div className="design-badges">
          <span className={`design-badge design-badge-live design-badge-${d.liveStatus}`}>{String(d.liveStatus)}</span>
        </div>
      ) : null}
      <ExposesLine kind="application" name={d.name.trim()} />
      <Handle type="source" position={Position.Right} className="design-handle" />
    </div>
  );
}

export function LoadBalancerNode({ data }: NodeProps) {
  const d = data as LoadBalancerData;
  // Ports the LB actually serves, annotated with the protocol for the well-known ones.
  const ports = [
    d.expose_http ? "80 (HTTP)" : null,
    d.expose_https ? "443 (HTTPS)" : null,
    d.extra_ports.trim() ? d.extra_ports.trim() : null,
  ].filter(Boolean);
  return (
    <div className="design-lb">
      <Handle type="target" position={Position.Left} className="design-hit" />
      <NodeHeader icon="load-balancer" title={d.name.trim() || "Load balancer"} />
      <div className="design-node-meta mono">
        {ports.length ? `serves ${ports.join(" · ")}` : "no ports exposed"}
      </div>
      <ExposesLine kind="loadbalancer" name={d.name.trim()} />
      <Handle type="source" position={Position.Right} className="design-handle" />
    </div>
  );
}

export function StorageNode({ data }: NodeProps) {
  const d = data as StorageData;
  const meta = [d.location.trim() || "region", d.storage_class, d.access === "read" ? "read-only" : "read+write"]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="design-storage">
      <Handle type="target" position={Position.Left} className="design-hit" />
      <NodeHeader icon="storage" title={d.name.trim() || "Cloud Storage"} />
      <div className="design-node-meta mono">{meta}</div>
      <ExposesLine kind="storage" name={d.name.trim()} />
    </div>
  );
}

export function PubsubNode({ data }: NodeProps) {
  const d = data as PubsubData;
  const meta = [d.create_subscription ? "topic + subscription" : "topic", d.role].join(" · ");
  return (
    <div className="design-pubsub">
      <Handle type="target" position={Position.Left} className="design-hit" />
      <NodeHeader icon="pubsub" title={d.name.trim() || "Pub/Sub"} />
      <div className="design-node-meta mono">{meta}</div>
      <ExposesLine kind="pubsub" name={d.name.trim()} />
    </div>
  );
}

export function BigqueryNode({ data }: NodeProps) {
  const d = data as BigqueryData;
  const meta = [d.location.trim() || "region", d.access === "read" ? "read-only" : "read+write"].join(" · ");
  return (
    <div className="design-bigquery">
      <Handle type="target" position={Position.Left} className="design-hit" />
      <NodeHeader icon="bigquery" title={d.name.trim() || "BigQuery"} />
      <div className="design-node-meta mono">{meta}</div>
      <ExposesLine kind="bigquery" name={d.name.trim()} />
    </div>
  );
}

export function CloudSqlNode({ data }: NodeProps) {
  const d = data as CloudSqlData;
  const meta = [d.engine === "mysql" ? "MySQL" : "Postgres", d.connectivity].join(" · ");
  return (
    <div className="design-cloudsql">
      <Handle type="target" position={Position.Left} className="design-hit" />
      <NodeHeader icon="cloudsql" title={d.name.trim() || "Cloud SQL"} />
      <div className="design-node-meta mono">{meta}</div>
      <ExposesLine kind="cloudsql" name={d.name.trim()} />
    </div>
  );
}

export function RdiNode({ data }: NodeProps) {
  const d = data as RdiData;
  const pipelines = Array.isArray(d.pipelines) ? d.pipelines.length : 0;
  return (
    <div className="design-rdi">
      <Handle type="target" position={Position.Left} className="design-hit" />
      <NodeHeader icon="rdi" title={d.name.trim() || "RDI"} />
      <div className="design-node-meta mono">{d.machine_type || "machine type"}</div>
      <div className="design-node-meta mono">
        {pipelines ? `${pipelines} pipeline${pipelines === 1 ? "" : "s"}` : "wire a Cloud SQL source + a target DB"}
      </div>
      <Handle type="source" position={Position.Right} className="design-handle" />
    </div>
  );
}

export const nodeTypes: NodeTypes = {
  network: RootNode,
  gke: RootNode,
  cluster: ClusterNode,
  database: DatabaseNode,
  vms: VmsNode,
  application: ApplicationNode,
  loadbalancer: LoadBalancerNode,
  storage: StorageNode,
  pubsub: PubsubNode,
  bigquery: BigqueryNode,
  cloudsql: CloudSqlNode,
  rdi: RdiNode,
};
