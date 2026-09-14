"use client";

import "@xyflow/react/dist/style.css";
import "@/app/design/design.css";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  ConnectionMode,
  Controls,
  Panel,
  ReactFlow,
  addEdge,
  getBezierPath,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type ConnectionLineComponentProps,
  type Edge,
  type Node,
} from "@xyflow/react";
import Link from "next/link";

import { DesignProvider, clusterCapacityMB } from "@/components/design/DesignContext";
import { NodeDialog, type DialogTarget } from "@/components/design/NodeDialog";
import { PALETTE_MIME, Palette } from "@/components/design/Palette";
import { defaultNodeData } from "@/components/design/defaults";
import { nodeTypes } from "@/components/design/nodes";
import {
  createInputToDiagram,
  diagramToCreateInput,
  initialNodeStyle,
  layoutDiagram,
  reconcileRdiInternalNodes,
  type ClusterData,
  type DatabaseData,
  type DesignEdge,
  type DesignNode,
  type DesignNodeData,
  type NodeKind,
  type DesignSettings,
} from "@/lib/diagram";
import type { UseGcpLookups } from "@/lib/useGcpLookups";
import { canUseDesignerCanvas, designerLockReason } from "@/lib/designer-gate";
import { canEnableDbReplication, clusterRedisNodeCount } from "@/lib/db-replication";

const ROOT_ID = "root";
const ROOT_SIZE = { width: 960, height: 560 };

function rootNode(mode: "vm" | "gke"): DesignNode {
  return {
    id: ROOT_ID,
    type: mode === "vm" ? "network" : "gke",
    position: { x: 0, y: 0 },
    data: mode === "vm" ? { kind: "network", label: "VPC network" } : { kind: "gke", label: "GKE cluster" },
    draggable: false,
    selectable: true,
    deletable: false,
    style: { width: ROOT_SIZE.width, height: ROOT_SIZE.height },
  };
}

function nodeSize(node: Node): { w: number; h: number } {
  const w = node.measured?.width ?? (node.style?.width as number) ?? 180;
  const h = node.measured?.height ?? (node.style?.height as number) ?? 90;
  return { w, h };
}

/** Connection line that turns green when the hovered target is valid, red when not. */
function DesignConnectionLine({ fromX, fromY, toX, toY, connectionStatus }: ConnectionLineComponentProps) {
  const [path] = getBezierPath({ sourceX: fromX, sourceY: fromY, targetX: toX, targetY: toY });
  const status = connectionStatus === "valid" ? " valid" : connectionStatus === "invalid" ? " invalid" : "";
  return <path d={path} fill="none" className={`design-connline${status}`} />;
}

/**
 * Canvas half of the unified create workspace. Deployment settings, the action
 * bar and preflight live in the parent shell; this view owns only the diagram,
 * hydrates from `initialConfig`, and reports the current create config and any
 * in-flight artifact upload back up.
 */
export function DesignView({
  gcp,
  settings,
  initialConfig,
  onConfigChange,
  onUploadingChange,
}: {
  gcp: UseGcpLookups;
  settings: DesignSettings;
  initialConfig: Record<string, unknown> | null;
  onConfigChange: (config: Record<string, unknown>) => void;
  onUploadingChange: (uploading: boolean) => void;
}) {
  const mode = settings.mode;
  const { screenToFlowPosition } = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(1);

  // Hydrate the canvas once from the incoming config (the parent remounts this
  // component with a fresh key on a view switch, so mount === (re)hydrate).
  const initial = useMemo(() => {
    if (initialConfig && Object.keys(initialConfig).length) {
      const { nodes, edges } = createInputToDiagram(initialConfig, mode);
      const laid = layoutDiagram(nodes);
      const maxId = laid.reduce((m, n) => {
        const match = /-(\d+)$/.exec(n.id);
        return match ? Math.max(m, Number(match[1])) : m;
      }, 0);
      idRef.current = maxId + 1;
      return { nodes: laid, edges };
    }
    return { nodes: [rootNode(mode)], edges: [] as DesignEdge[] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [nodes, setNodes, onNodesChange] = useNodesState<DesignNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<DesignEdge>(initial.edges);
  const [dialog, setDialog] = useState<DialogTarget | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [toast, setToast] = useState("");

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((cur) => (cur === msg ? "" : cur)), 3200);
  }, []);

  // Report the current create config up whenever the diagram or settings change.
  useEffect(() => {
    onConfigChange(diagramToCreateInput(nodes, edges, settings));
  }, [nodes, edges, settings, onConfigChange]);

  // A mode change (chosen in the shared settings) rebuilds the root and clears
  // the canvas to avoid invalid nesting. Skipped on the initial mount.
  const builtModeRef = useRef(mode);
  useEffect(() => {
    if (builtModeRef.current === mode) return;
    builtModeRef.current = mode;
    setNodes(layoutDiagram([rootNode(mode)]));
    setEdges([]);
  }, [mode, setNodes, setEdges]);

  const validCredential = gcp.credentials.find((c) => c.file === gcp.settings.credentialsFile)?.valid;
  const canvasReady = canUseDesignerCanvas({
    credentialsFile: gcp.settings.credentialsFile,
    credentialValid: validCredential,
  });
  const lockReason = designerLockReason({
    credentialsFile: gcp.settings.credentialsFile,
    credentialValid: validCredential,
  });

  const nodeById = useCallback((id: string) => nodes.find((n) => n.id === id), [nodes]);

  const nodeAt = useCallback(
    (point: { x: number; y: number }, kinds: NodeKind[], skipId?: string): DesignNode | undefined => {
      const candidates = nodes
        .filter((n) => n.id !== skipId && n.parentId === ROOT_ID && kinds.includes(n.data.kind as NodeKind))
        .filter((n) => {
          const { w, h } = nodeSize(n);
          return (
            point.x >= n.position.x &&
            point.x <= n.position.x + w &&
            point.y >= n.position.y &&
            point.y <= n.position.y + h
          );
        });
      return candidates[candidates.length - 1];
    },
    [nodes],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      if (!canvasReady) {
        showToast("Select a service account key before adding components.");
        return;
      }
      const kind = event.dataTransfer.getData(PALETTE_MIME) as NodeKind;
      if (!kind) return;

      const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });

      let parentId = ROOT_ID;
      let relative = point;
      let lbTargetId: string | undefined;
      let clusterHost: DesignNode | undefined;

      if (kind === "database") {
        clusterHost = nodeAt(point, ["cluster"]);
        if (!clusterHost) {
          showToast("A database must be dropped inside a Redis cluster.");
          return;
        }
        parentId = clusterHost.id;
        relative = { x: point.x - clusterHost.position.x, y: point.y - clusterHost.position.y };
      } else if (kind === "loadbalancer") {
        parentId = ROOT_ID;
        relative = point;
        const host = nodeAt(point, ["vms", "application"]);
        if (host) {
          lbTargetId = host.id;
        } else {
          showToast("Connect the load balancer to a set of VMs or an application by dragging a link.");
        }
      } else if (kind === "cluster" || kind === "vms" || kind === "application") {
        if (kind === "vms" && mode === "gke") {
          showToast("Sets of VMs are only available in VM mode.");
          return;
        }
        parentId = ROOT_ID;
        relative = point;
      } else if (kind === "rdi") {
        if (nodes.some((n) => n.data.kind === "rdi")) {
          showToast("Only one RDI component is supported per deployment.");
          return;
        }
        parentId = ROOT_ID;
        relative = point;
      }

      const id = `${kind}-${idRef.current++}`;
      const style = initialNodeStyle(kind);
      const data = defaultNodeData(kind, gcp.machineTypes, gcp.vmReleases);
      if (kind === "database") {
        (data as DatabaseData).replication = canEnableDbReplication(
          clusterRedisNodeCount(clusterHost?.data as ClusterData | undefined, mode),
        );
      }
      const newNode: DesignNode = {
        id,
        type: kind,
        position: relative,
        parentId,
        extent: "parent",
        data,
        ...(style ? { style } : {}),
      };
      setNodes((prev) => layoutDiagram(prev.concat(newNode)));
      if (lbTargetId) {
        setEdges((eds) =>
          addEdge(
            { id: `edge-lb-${id}`, source: id, target: lbTargetId as string, animated: true, className: "design-edge-lb" },
            eds,
          ),
        );
      }
      setDialog({ id, type: kind, data: newNode.data });
    },
    [canvasReady, screenToFlowPosition, nodeAt, mode, gcp.machineTypes, gcp.vmReleases, setNodes, setEdges, showToast, nodes],
  );

  const onDragOver = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = canvasReady ? "move" : "none";
    },
    [canvasReady],
  );

  const lbBackendId = useCallback(
    (lb: DesignNode): string | undefined => {
      const isHost = (n?: DesignNode) => n?.data.kind === "vms" || n?.data.kind === "application";
      if (lb.parentId && isHost(nodeById(lb.parentId))) return lb.parentId;
      for (const e of edges) if (e.source === lb.id && isHost(nodeById(e.target))) return e.target;
      return undefined;
    },
    [nodeById, edges],
  );

  const orientConnection = useCallback(
    (aId?: string | null, bId?: string | null): { source: string; target: string; isLbEdge: boolean } | null => {
      const a = nodeById(aId ?? "");
      const b = nodeById(bId ?? "");
      if (!a || !b || a.id === b.id) return null;
      const isConsumer = (k: string) => k === "application" || k === "vms";
      const isProviderOnly = (k: string) =>
        k === "cluster" ||
        k === "database" ||
        k === "storage" ||
        k === "pubsub" ||
        k === "bigquery" ||
        k === "cloudsql";

      const orientLb = (lb: DesignNode, host: DesignNode) => {
        const backend = lbBackendId(lb);
        if (backend === undefined) return { source: lb.id, target: host.id, isLbEdge: true };
        if (backend === host.id) return null;
        return { source: host.id, target: lb.id, isLbEdge: true };
      };

      const ka = a.data.kind;
      const kb = b.data.kind;
      const isRdiTargetKind = (k: string) => k === "cloudsql" || k === "database";
      if (ka === "rdi" && isRdiTargetKind(kb)) return { source: a.id, target: b.id, isLbEdge: false };
      if (kb === "rdi" && isRdiTargetKind(ka)) return { source: b.id, target: a.id, isLbEdge: false };
      if (ka === "rdi" || kb === "rdi") return null;
      if (isProviderOnly(ka) && isConsumer(kb)) return { source: b.id, target: a.id, isLbEdge: false };
      if (isProviderOnly(kb) && isConsumer(ka)) return { source: a.id, target: b.id, isLbEdge: false };
      if (ka === "loadbalancer" && isConsumer(kb)) return orientLb(a, b);
      if (kb === "loadbalancer" && isConsumer(ka)) return orientLb(b, a);
      if (isConsumer(ka) && isConsumer(kb)) return { source: a.id, target: b.id, isLbEdge: false };
      return null;
    },
    [nodeById, lbBackendId],
  );

  const isValidConnection = useCallback(
    (c: Connection | Edge) => orientConnection(c.source, c.target) !== null,
    [orientConnection],
  );

  const onConnect = useCallback(
    (params: Connection) => {
      if (!canvasReady) return;
      const oriented = orientConnection(params.source, params.target);
      if (!oriented) {
        showToast("Wire a consumer (app or set of VMs) to a cluster, database, load balancer, or another app — not to its own load balancer.");
        return;
      }
      setEdges((eds) =>
        addEdge(
          {
            id: `edge-${oriented.source}-${oriented.target}`,
            source: oriented.source,
            target: oriented.target,
            animated: true,
            ...(oriented.isLbEdge ? { className: "design-edge-lb" } : {}),
          },
          eds,
        ),
      );
      setNodes((prev) => layoutDiagram(prev));
    },
    [canvasReady, orientConnection, setEdges, setNodes, showToast],
  );

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (!canvasReady) return;
      if (node.data.kind === "network") return;
      setDialog({ id: node.id, type: node.type || (node.data.kind as string), data: node.data as DesignNodeData });
    },
    [canvasReady],
  );

  const removeNode = useCallback(
    (id: string) => {
      if (id === ROOT_ID) return;
      const doomed = new Set<string>([id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const n of nodes) {
          if (n.parentId && doomed.has(n.parentId) && !doomed.has(n.id)) {
            doomed.add(n.id);
            grew = true;
          }
        }
      }
      setNodes((prev) => layoutDiagram(prev.filter((n) => !doomed.has(n.id))));
      setEdges((prev) => prev.filter((e) => !doomed.has(e.source) && !doomed.has(e.target)));
      setDialog(null);
    },
    [nodes, setNodes, setEdges],
  );

  const saveDialog = useCallback(
    (data: DesignNodeData) => {
      if (!dialog) return;
      setNodes((prev) => {
        let next = prev.map((n) => (n.id === dialog.id ? { ...n, data } : n));
        if (data.kind === "cluster" && !canEnableDbReplication(clusterRedisNodeCount(data, mode))) {
          next = next.map((n) =>
            n.parentId === dialog.id && n.data.kind === "database"
              ? { ...n, data: { ...n.data, replication: false } }
              : n,
          );
        }
        return layoutDiagram(next);
      });
      setDialog(null);
    },
    [dialog, mode, setNodes],
  );

  // Keep the RDI pipeline-state database in sync with the RDI target edge.
  useEffect(() => {
    const next = reconcileRdiInternalNodes(nodes, edges);
    if (!next) return;
    setNodes(next.nodes);
    setEdges(next.edges);
  }, [nodes, edges, setNodes, setEdges]);

  const overCommitted = useMemo(() => {
    return nodes
      .filter((n) => n.data.kind === "cluster")
      .map((n, i) => {
        const d = n.data as { name: string; nodes: number; rec_nodes: number; machine_type: string };
        const parentIsGke = nodes.some((p) => p.id === n.parentId && p.data.kind === "gke");
        const count = parentIsGke ? d.rec_nodes : d.nodes;
        const cap = clusterCapacityMB(n.id, count, d.machine_type, gcp.machineTypes, nodes);
        return { name: d.name.trim() || `cluster${i + 1}`, negative: cap.remainingMB < 0 };
      })
      .filter((c) => c.negative);
  }, [nodes, gcp.machineTypes]);

  return (
    <div className="design-layout-wrap">
      <div className="design-layout">
        <div className="design-canvas-wrap" ref={wrapperRef}>
          {!canvasReady ? (
            <div className="design-canvas-lock" role="status">
              <p className="design-canvas-lock-title">Service account required</p>
              <p className="design-canvas-lock-body">{lockReason}</p>
              <p className="hint">
                Choose a key in Deployment settings above, or{" "}
                <Link href="/credentials">add one on Credentials</Link>.
              </p>
            </div>
          ) : null}
          <DesignProvider value={{ machineTypes: gcp.machineTypes, nodes, settings }}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              connectionMode={ConnectionMode.Loose}
              connectionLineComponent={DesignConnectionLine}
              onConnectStart={() => setConnecting(true)}
              onConnectEnd={() => setConnecting(false)}
              className={connecting ? "design-connecting" : undefined}
              onDrop={onDrop}
              onDragOver={onDragOver}
              onNodeClick={onNodeClick}
              nodesDraggable={canvasReady}
              nodesConnectable={canvasReady}
              elementsSelectable={canvasReady}
              panOnDrag={canvasReady}
              zoomOnScroll={canvasReady}
              zoomOnPinch={canvasReady}
              zoomOnDoubleClick={canvasReady}
              nodeTypes={nodeTypes}
              fitView
              proOptions={{ hideAttribution: true }}
            >
              <Background />
              <Controls />
              {toast ? (
                <Panel position="top-center">
                  <div className="design-toast">{toast}</div>
                </Panel>
              ) : null}
            </ReactFlow>
          </DesignProvider>
        </div>
        <div className="design-side">
          <Palette mode={mode} disabled={!canvasReady} />
        </div>
      </div>

      {overCommitted.length ? (
        <div className="notice notice-warn design-warn">
          Over-committed clusters: {overCommitted.map((c) => c.name).join(", ")}. Reduce database memory or
          add nodes.
        </div>
      ) : null}

      {dialog ? (
        <NodeDialog
          target={dialog}
          mode={mode}
          machineTypes={gcp.machineTypes}
          loadingMachines={gcp.loading.machines}
          vmReleases={gcp.vmReleases}
          probeZone={gcp.probeZone}
          onUploadingChange={onUploadingChange}
          clusterHasNvme={(() => {
            if (dialog.type !== "database") return false;
            const dbNode = nodes.find((n) => n.id === dialog.id);
            const parent = nodes.find((n) => n.id === dbNode?.parentId);
            return Number((parent?.data as { rof_nvme_disks?: number } | undefined)?.rof_nvme_disks) > 0;
          })()}
          clusterNodes={(() => {
            if (dialog.type !== "database") return 0;
            const dbNode = nodes.find((n) => n.id === dialog.id);
            const parent = nodes.find((n) => n.id === dbNode?.parentId);
            return clusterRedisNodeCount(parent?.data as ClusterData | undefined, mode);
          })()}
          onSave={saveDialog}
          onCancel={() => setDialog(null)}
          onDelete={() => removeNode(dialog.id)}
        />
      ) : null}
    </div>
  );
}
