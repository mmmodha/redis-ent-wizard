"use client";

import "@xyflow/react/dist/style.css";
import "./design.css";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Background,
  Controls,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react";

import Link from "next/link";
import { CheckList } from "@/components/CheckList";
import { DeploymentSettings, ownerError, type DesignMeta } from "@/components/design/DeploymentSettings";
import { DesignProvider, clusterCapacityMB } from "@/components/design/DesignContext";
import { NodeDialog, type DialogTarget } from "@/components/design/NodeDialog";
import { PALETTE_MIME, Palette } from "@/components/design/Palette";
import { defaultNodeData } from "@/components/design/defaults";
import { nodeTypes } from "@/components/design/nodes";
import { createInstance, getInstance, runPreflight, type PreflightResult } from "@/lib/api";
import {
  createInputToDiagram,
  diagramToCreateInput,
  initialNodeStyle,
  layoutDiagram,
  type ClusterData,
  type DatabaseData,
  type DesignEdge,
  type DesignNode,
  type DesignNodeData,
  type NodeKind,
  type DesignSettings,
} from "@/lib/diagram";
import { useGcpLookups } from "@/lib/useGcpLookups";
import { canUseDesignerCanvas, designerLockReason } from "@/lib/designer-gate";
import {
  canEnableDbReplication,
  clusterRedisNodeCount,
} from "@/lib/db-replication";
import { clusterTrialShardGate, omitCreateInputDatabases } from "@/lib/trial-shards";

const ROOT_ID = "root";
const ROOT_SIZE = { width: 960, height: 560 };

const CONTAINER_KINDS: NodeKind[] = ["network", "gke", "cluster", "vms", "application"];

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

function DesignCanvas() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const fromId = searchParams.get("from");
  const hydratedRef = useRef(false);
  const gcp = useGcpLookups();
  const { screenToFlowPosition } = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(1);

  const [meta, setMeta] = useState<DesignMeta>({
    name: "",
    env: "default",
    folder: "",
    youremail: "",
    skip_deletion: false,
    mode: "vm",
    RS_admin: "admin@redis.io",
    operator_chart_version: "latest",
  });

  const [nodes, setNodes, onNodesChange] = useNodesState<DesignNode>([rootNode("vm")]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<DesignEdge>([]);

  const [dialog, setDialog] = useState<DialogTarget | null>(null);
  const [toast, setToast] = useState("");
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((cur) => (cur === msg ? "" : cur)), 3200);
  }, []);

  const resetPreflight = useCallback(() => setPreflight(null), []);

  // Switching mode rebuilds the root and clears the canvas to avoid invalid nesting.
  const switchMode = useCallback(
    (mode: "vm" | "gke") => {
      setMeta((m) => ({ ...m, mode }));
      setNodes(layoutDiagram([rootNode(mode)]));
      setEdges([]);
      resetPreflight();
    },
    [setNodes, setEdges, resetPreflight],
  );

  // Reopen a destroyed instance's config for editing (?from=<id>). Runs once.
  const gcpSetSettings = gcp.setSettings;
  useEffect(() => {
    if (!fromId || hydratedRef.current) return;
    hydratedRef.current = true;
    getInstance(fromId)
      .then((inst) => {
        const cfg = (inst.config || {}) as Record<string, unknown>;
        const mode: "vm" | "gke" = cfg.mode === "gke" ? "gke" : "vm";
        setMeta((m) => ({
          ...m,
          name: typeof cfg.name === "string" ? cfg.name : m.name,
          env: typeof cfg.env === "string" && cfg.env ? cfg.env : m.env,
          folder: typeof cfg.folder === "string" ? cfg.folder : m.folder,
          youremail: typeof cfg.youremail === "string" ? cfg.youremail : m.youremail,
          skip_deletion: Boolean(cfg.skip_deletion),
          mode,
          RS_admin: typeof cfg.RS_admin === "string" && cfg.RS_admin ? cfg.RS_admin : m.RS_admin,
          operator_chart_version:
            typeof cfg.operator_chart_version === "string" && cfg.operator_chart_version
              ? cfg.operator_chart_version
              : m.operator_chart_version,
        }));
        const zones = Array.isArray(cfg.region_zones)
          ? (cfg.region_zones as unknown[]).map(String)
          : [];
        gcpSetSettings((s) => ({
          ...s,
          credentialsFile: inst.credentialsId || "",
          project: typeof cfg.project === "string" ? cfg.project : s.project,
          region_name: typeof cfg.region_name === "string" ? cfg.region_name : s.region_name,
          region_zones: zones.length ? zones : s.region_zones,
          dns_managed_zone:
            typeof cfg.dns_managed_zone === "string" ? cfg.dns_managed_zone : s.dns_managed_zone,
          dns_zone_dns_name:
            typeof cfg.dns_zone_dns_name === "string" ? cfg.dns_zone_dns_name : s.dns_zone_dns_name,
        }));
        const { nodes: hydratedNodes, edges: hydratedEdges } = createInputToDiagram(cfg, mode);
        setNodes(layoutDiagram(hydratedNodes));
        setEdges(hydratedEdges);
        const maxId = hydratedNodes.reduce((m, n) => {
          const match = /-(\d+)$/.exec(n.id);
          return match ? Math.max(m, Number(match[1])) : m;
        }, 0);
        idRef.current = maxId + 1;
        resetPreflight();
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Failed to load instance for editing"),
      );
  }, [fromId, gcpSetSettings, setNodes, setEdges, resetPreflight]);

  const settings: DesignSettings = useMemo(
    () => ({
      name: meta.name,
      env: meta.env,
      folder: meta.folder,
      youremail: meta.youremail,
      skip_deletion: meta.skip_deletion,
      mode: meta.mode,
      RS_admin: meta.RS_admin,
      operator_chart_version: meta.operator_chart_version,
      credentialsFile: gcp.settings.credentialsFile,
      project: gcp.settings.project,
      region_name: gcp.settings.region_name,
      region_zones: gcp.settings.region_zones,
      dns_managed_zone: gcp.settings.dns_managed_zone,
      dns_zone_dns_name: gcp.settings.dns_zone_dns_name,
    }),
    [meta, gcp.settings],
  );

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

  /** Deepest child (of root) whose rect contains the flow point, optionally filtered by kind. */
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
        // A load balancer is an external peer, not nested. If dropped on a set
        // of VMs or an application, link it to that target with an edge.
        parentId = ROOT_ID;
        relative = point;
        const host = nodeAt(point, ["vms", "application"]);
        if (host) {
          lbTargetId = host.id;
        } else {
          showToast("Connect the load balancer to a set of VMs or an application by dragging a link.");
        }
      } else if (kind === "cluster" || kind === "vms" || kind === "application") {
        if (kind === "vms" && meta.mode === "gke") {
          showToast("Sets of VMs are only available in VM mode.");
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
          clusterRedisNodeCount(clusterHost?.data as ClusterData | undefined, meta.mode),
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
      resetPreflight();
      // Open the editor immediately so the drop captures its fields.
      setDialog({ id, type: kind, data: newNode.data });
    },
    [canvasReady, screenToFlowPosition, nodeAt, meta.mode, gcp.machineTypes, gcp.vmReleases, setNodes, setEdges, resetPreflight, showToast],
  );

  const onDragOver = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = canvasReady ? "move" : "none";
    },
    [canvasReady],
  );

  const isValidConnection = useCallback(
    (c: Connection | Edge) => {
      const source = nodeById(c.source ?? "");
      const target = nodeById(c.target ?? "");
      if (!source || !target || source.id === target.id) return false;
      // Application to cluster wiring.
      if (source.data.kind === "application" && target.data.kind === "cluster") return true;
      // Load balancer to a set of VMs or an application, in either direction.
      const kinds = [source.data.kind, target.data.kind];
      const hasLb = kinds.includes("loadbalancer");
      const hasHost = kinds.includes("vms") || kinds.includes("application");
      return hasLb && hasHost;
    },
    [nodeById],
  );

  const onConnect = useCallback(
    (params: Connection) => {
      if (!canvasReady) return;
      if (!isValidConnection(params)) {
        showToast("Connect an application to a cluster, or a load balancer to a set of VMs or application.");
        return;
      }
      const source = nodeById(params.source ?? "");
      const target = nodeById(params.target ?? "");
      const isLbEdge = source?.data.kind === "loadbalancer" || target?.data.kind === "loadbalancer";
      setEdges((eds) =>
        addEdge({ ...params, animated: true, ...(isLbEdge ? { className: "design-edge-lb" } : {}) }, eds),
      );
      setNodes((prev) => layoutDiagram(prev));
      resetPreflight();
    },
    [canvasReady, isValidConnection, nodeById, setEdges, setNodes, resetPreflight, showToast],
  );

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (!canvasReady) return;
      if (node.data.kind === "network") return; // nothing to edit on the VPC root
      setDialog({ id: node.id, type: node.type || (node.data.kind as string), data: node.data as DesignNodeData });
    },
    [canvasReady],
  );

  const removeNode = useCallback(
    (id: string) => {
      if (id === ROOT_ID) return;
      const doomed = new Set<string>([id]);
      // Cascade to descendants.
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
      // Drop any edges whose endpoints were deleted so dangling links disappear.
      setEdges((prev) => prev.filter((e) => !doomed.has(e.source) && !doomed.has(e.target)));
      setDialog(null);
      resetPreflight();
    },
    [nodes, setNodes, setEdges, resetPreflight],
  );

  const saveDialog = useCallback(
    (data: DesignNodeData) => {
      if (!dialog) return;
      setNodes((prev) => {
        let next = prev.map((n) => (n.id === dialog.id ? { ...n, data } : n));
        if (data.kind === "cluster" && !canEnableDbReplication(clusterRedisNodeCount(data, meta.mode))) {
          next = next.map((n) =>
            n.parentId === dialog.id && n.data.kind === "database"
              ? { ...n, data: { ...n.data, replication: false } }
              : n,
          );
        }
        return layoutDiagram(next);
      });
      setDialog(null);
      resetPreflight();
    },
    [dialog, meta.mode, setNodes, resetPreflight],
  );

  // Client-side capacity check surfaced before preflight.
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

  const trialShardBlocks = useMemo(
    () =>
      nodes
        .filter((n) => n.data.kind === "cluster")
        .map((n, i) => {
          const d = n.data as ClusterData;
          const parentIsGke = nodes.some((p) => p.id === n.parentId && p.data.kind === "gke");
          const count = parentIsGke ? d.rec_nodes : d.nodes;
          const dbs = nodes
            .filter((x) => x.parentId === n.id && x.data.kind === "database")
            .map((x) => x.data as DatabaseData);
          return clusterTrialShardGate({
            name: d.name.trim() || `cluster ${i + 1}`,
            license: d.license,
            databases: dbs,
            nodes: count,
          });
        })
        .filter((g) => g.blocked),
    [nodes],
  );

  const oe = ownerError(meta.youremail);
  const hasCluster = nodes.some((n) => n.data.kind === "cluster");
  const canValidate = Boolean(
    meta.name && !oe && canvasReady && gcp.settings.project && gcp.settings.region_name && hasCluster,
  );

  const validate = useCallback(async () => {
    setChecking(true);
    setError("");
    try {
      setPreflight(await runPreflight(diagramToCreateInput(nodes, edges, settings)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preflight failed");
    } finally {
      setChecking(false);
    }
  }, [nodes, edges, settings]);

  const create = useCallback(async () => {
    setSubmitting(true);
    setError("");
    try {
      const created = await createInstance(diagramToCreateInput(nodes, edges, settings));
      router.push(`/instances/${encodeURIComponent(created.id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
      setSubmitting(false);
    }
  }, [nodes, edges, settings, router]);

  const createWithoutDatabases = useCallback(async () => {
    if (
      !confirm(
        "Create the cluster without databases? You can apply a license later and create the databases from the instance page.",
      )
    ) {
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const input = omitCreateInputDatabases(diagramToCreateInput(nodes, edges, settings));
      const pf = await runPreflight(input);
      setPreflight(pf);
      if (!pf.ok) {
        setSubmitting(false);
        return;
      }
      const created = await createInstance(input);
      router.push(`/instances/${encodeURIComponent(created.id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
      setSubmitting(false);
    }
  }, [nodes, edges, settings, router]);

  return (
    <div>
      <div className="page-head">
        <div>
          <p className="page-eyebrow">Designer</p>
          <h2 className="page-title">Design infrastructure</h2>
          <p className="page-sub">Drag components onto the canvas, then validate against your GCP project</p>
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {gcp.error ? <div className="error">{gcp.error}</div> : null}

      <div className="panel design-settings-panel">
        <DeploymentSettings
          gcp={gcp}
          meta={meta}
          onModeChange={switchMode}
          setMeta={(update) => {
            setMeta(update);
            resetPreflight();
          }}
        />
      </div>

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
          <Palette mode={meta.mode} disabled={!canvasReady} />
        </div>
      </div>

      {overCommitted.length ? (
        <div className="notice notice-warn design-warn">
          Over-committed clusters: {overCommitted.map((c) => c.name).join(", ")}. Reduce database memory or
          add nodes.
        </div>
      ) : null}

      {trialShardBlocks.length ? (
        <div className="notice notice-warn design-warn">
          {trialShardBlocks.map((g) => (
            <p key={g.message} style={{ margin: "0 0 8px" }}>
              {g.message}
            </p>
          ))}
        </div>
      ) : null}

      <div className="panel design-validate">
        <div className="review-head">
          <div>
            <h3 style={{ margin: "0 0 4px" }}>
              {meta.name || "instance"}-{meta.env}
            </h3>
            <p className="hint" style={{ margin: 0 }}>
              {meta.mode.toUpperCase()} · {gcp.settings.project || "no project"} ·{" "}
              {gcp.settings.region_name || "no region"}
            </p>
          </div>
          <button type="button" className="btn" onClick={validate} disabled={!canValidate || checking}>
            {checking ? "Validating…" : "Validate"}
          </button>
        </div>

        {!hasCluster ? (
          <p className="hint">Add at least one Redis cluster before validating.</p>
        ) : null}

        {checking && !preflight ? <div className="empty">Validating against GCP…</div> : null}
        {preflight ? <CheckList checks={preflight.checks} /> : null}
        {preflight && !preflight.ok ? (
          <div className="error">Fix the failed checks above before applying. Nothing has been created yet.</div>
        ) : null}

        <div className="actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={submitting || checking || !preflight?.ok}
            onClick={create}
          >
            {submitting ? "Starting…" : "Apply with Terraform"}
          </button>
          {trialShardBlocks.length ? (
            <button
              type="button"
              className="btn"
              disabled={submitting || checking}
              onClick={() => void createWithoutDatabases()}
            >
              Apply without databases
            </button>
          ) : null}
        </div>
      </div>

      {dialog ? (
        <NodeDialog
          target={dialog}
          mode={meta.mode}
          machineTypes={gcp.machineTypes}
          loadingMachines={gcp.loading.machines}
          vmReleases={gcp.vmReleases}
          probeZone={gcp.probeZone}
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
            return clusterRedisNodeCount(parent?.data as ClusterData | undefined, meta.mode);
          })()}
          onSave={saveDialog}
          onCancel={() => setDialog(null)}
          onDelete={() => removeNode(dialog.id)}
        />
      ) : null}
    </div>
  );
}

export default function DesignPage() {
  return (
    <Suspense fallback={<div className="empty">Loading…</div>}>
      <ReactFlowProvider>
        <DesignCanvas />
      </ReactFlowProvider>
    </Suspense>
  );
}
