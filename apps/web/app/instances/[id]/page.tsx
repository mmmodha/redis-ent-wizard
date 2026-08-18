"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { AccessPanel } from "@/components/AccessPanel";
import { ProgressTracker } from "@/components/ProgressTracker";
import { StatusBadge } from "@/components/StatusBadge";
import {
  apiBase,
  destroyInstance,
  forgetInstance,
  getInstance,
  moveInstance,
  recheckHealth,
  recreateInstance,
  retryInstance,
  type Instance,
  type Progress,
} from "@/lib/api";

function asClusters(cfg: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  if (Array.isArray(cfg?.clusters) && cfg.clusters.length) {
    return cfg.clusters as Array<Record<string, unknown>>;
  }
  if (!cfg) return [];
  if (cfg.mode === "gke") {
    return [{ rec_nodes: cfg.rec_nodes ?? 3 }];
  }
  return [
    {
      nodes: cfg.clustersize ?? 3,
      machine_type: cfg.machine_type,
      rs_version: cfg.rs_version,
      RS_release: cfg.RS_release,
      rof_nvme_disks: cfg.rof_nvme_disks ?? 0,
    },
  ];
}

function deploymentSummary(inst: Instance): { label: string; value: string }[] {
  const cfg = (inst.config || {}) as Record<string, unknown>;
  const clusters = asClusters(cfg);
  const rows: { label: string; value: string }[] = [
    { label: "GCP project", value: String(inst.project) },
    { label: "Region", value: String(inst.region) },
    { label: "Mode", value: inst.mode.toUpperCase() },
  ];
  clusters.forEach((c, i) => {
    const label = String(c.name || "").trim()
      ? String(c.name)
      : clusters.length > 1
        ? `Redis cluster ${i + 1}`
        : "Redis cluster";
    if (inst.mode === "gke") {
      rows.push({ label, value: `${c.rec_nodes ?? c.nodes ?? "?"} REC nodes` });
    } else {
      const ver = String(c.rs_version || c.RS_release || "").replace(/.*redislabs-/, "").replace(/-jammy.*/, "");
      rows.push({
        label,
        value: `${c.nodes ?? "?"} × ${c.machine_type || "?"} · ${ver || "default version"}${
          Number(c.rof_nvme_disks) > 0 ? ` · ${c.rof_nvme_disks} NVMe` : ""
        }`,
      });
    }
  });
  if (inst.mode === "gke" && cfg.operator_chart_version) {
    rows.push({
      label: "Operator",
      value: String(cfg.operator_chart_version || "latest"),
    });
  }
  const app = Number(cfg.app || 0);
  if (app > 0) {
    const types = Array.isArray(cfg.app_machine_types) ? (cfg.app_machine_types as string[]).join(", ") : "";
    const ports = [
      cfg.app_expose_http ? "HTTP :80" : null,
      cfg.app_expose_https ? "HTTPS :443" : null,
      Array.isArray(cfg.app_extra_ports) && (cfg.app_extra_ports as number[]).length
        ? `TCP ${(cfg.app_extra_ports as number[]).join(",")}`
        : typeof cfg.app_extra_ports === "string" && cfg.app_extra_ports
          ? `TCP ${cfg.app_extra_ports}`
          : null,
    ].filter(Boolean);
    rows.push({
      label: "App VMs",
      value: `${app}${types ? ` · ${types}` : ""}${ports.length ? ` · ${ports.join(" + ")}` : ""}`,
    });
  }
  return rows;
}

export default function InstanceDetailPage() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(params.id);
  const router = useRouter();
  const [inst, setInst] = useState<Instance | null>(null);
  const [progress, setProgress] = useState<Progress | undefined>();
  const [log, setLog] = useState("");
  const [error, setError] = useState("");
  const [destroying, setDestroying] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [recreating, setRecreating] = useState(false);
  const [confirmRecreate, setConfirmRecreate] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [folderDraft, setFolderDraft] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await getInstance(id);
        if (cancelled) return;
        setInst(data);
        setFolderDraft(data.folder || "");
        if (data.progress) setProgress(data.progress);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load");
      }
    };
    load();
    const t = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [id]);

  useEffect(() => {
    const token =
      typeof window !== "undefined" ? localStorage.getItem("rew-access-token") : null;
    const qs = token ? `?access_token=${encodeURIComponent(token)}` : "";
    const es = new EventSource(`${apiBase()}/instances/${encodeURIComponent(id)}/logs${qs}`);
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as {
          chunk?: string;
          status?: string;
          progress?: Progress;
        };
        if (data.chunk) setLog((prev) => prev + data.chunk);
        if (data.progress) setProgress(data.progress);
        if (data.status) {
          setInst((prev) => (prev ? { ...prev, status: data.status! } : prev));
        }
      } catch {
        // ignore malformed frames
      }
    };
    return () => es.close();
  }, [id]);

  useEffect(() => {
    if (showLog && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [log, showLog]);

  async function onDestroy() {
    if (!confirm(`Destroy ${id} and all its GCP resources?`)) return;
    setDestroying(true);
    setError("");
    setShowLog(true);
    try {
      await destroyInstance(id);
      // Stay on this page so destroy progress is visible.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Destroy failed");
    } finally {
      setDestroying(false);
    }
  }

  async function onRetry() {
    setRetrying(true);
    setError("");
    setLog("");
    try {
      await retryInstance(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Retry failed");
    } finally {
      setRetrying(false);
    }
  }

  async function onRecreate() {
    setRecreating(true);
    setError("");
    setLog("");
    setShowLog(true);
    try {
      await recreateInstance(id);
      setConfirmRecreate(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recreate failed");
    } finally {
      setRecreating(false);
    }
  }

  async function onForget() {
    if (!confirm(`Remove ${id} from the registry? Cloud resources are not touched.`)) return;
    setForgetting(true);
    try {
      await forgetInstance(id);
      router.push("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Forget failed");
      setForgetting(false);
    }
  }

  async function onRecheck() {
    setChecking(true);
    setError("");
    try {
      const health = await recheckHealth(id);
      setInst((prev) => (prev ? { ...prev, health } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Health check failed");
    } finally {
      setChecking(false);
    }
  }

  async function onSaveFolder() {
    try {
      await moveInstance(id, folderDraft.trim() || null);
      setInst((prev) => (prev ? { ...prev, folder: folderDraft.trim() || undefined } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update folder");
    }
  }

  const inProgress = inst?.status === "applying" || inst?.status === "destroying" || inst?.busy;
  // Terraform is done but the cluster is not usable yet, so links must carry a warning.
  const settling = inst?.status === "bootstrapping" || inst?.status === "degraded";
  const canForget = inst?.status === "destroyed" || inst?.status === "failed";
  const canDestroy =
    inst &&
    !inst.busy &&
    inst.status !== "destroying" &&
    inst.status !== "destroyed" &&
    inst.status !== "applying";

  const subtitle = (() => {
    if (!inst) return "Loading…";
    const parts = [inst.mode.toUpperCase(), inst.project, inst.region, inst.ownerEmail];
    if (inst.mode === "vm") {
      const clusters = asClusters(inst.config);
      if (clusters.length > 1) {
        parts.push(`${clusters.length} Redis clusters`);
      }
      const nvme = clusters.some((c) => Number(c.rof_nvme_disks) > 0);
      if (nvme) parts.push("Redis on Flash");
      const appCount = Number(inst.config?.app || 0);
      if (appCount > 0) {
        const types = Array.isArray(inst.config?.app_machine_types)
          ? (inst.config.app_machine_types as string[])
          : inst.config?.app_machine_type
            ? [String(inst.config.app_machine_type)]
            : [];
        const label = types.length
          ? types.join(", ")
          : String(inst.config?.app_machine_type || "");
        const disks = Array.isArray(inst.config?.app_disk_gib)
          ? (inst.config.app_disk_gib as number[]).filter((n) => n > 0)
          : [];
        const diskNote = disks.length ? `, +${disks.join("/")} GiB disk` : "";
        parts.push(`${appCount} app VM${appCount > 1 ? "s" : ""}${label ? ` (${label}${diskNote})` : diskNote}`);
      }
    }
    return parts.filter(Boolean).join(" · ");
  })();

  return (
    <div>
      <div className="page-head">
        <div>
          <p className="page-eyebrow">Instance</p>
          <h2 className="page-title mono">{id}</h2>
          <p className="page-sub">{subtitle}</p>
        </div>
        <Link className="btn" href="/">
          All instances
        </Link>
      </div>

      {error ? <div className="error">{error}</div> : null}

      <div className="grid grid-2" style={{ marginBottom: 24 }}>
        <div className="panel">
          <div className="progress-head" style={{ marginTop: 0 }}>
            <h2 style={{ margin: 0 }}>Progress</h2>
            {inst ? <StatusBadge status={inst.status} /> : null}
          </div>

          <ProgressTracker progress={progress} status={inst?.status} />

          {inst?.health && inst.status !== "destroyed" && inst.status !== "destroying" ? (
            <div className={settling ? "notice notice-warn" : "notice"}>
              <div style={{ flex: 1 }}>
                <div className="health-row">
                  <strong>
                    {settling
                      ? "Redis Enterprise is still coming up"
                      : "Redis Enterprise cluster is up"}
                  </strong>
                  <span className="mono">
                    {inst.health.nodesActive}/{inst.health.nodesExpected} nodes
                  </span>
                </div>
                <div className="hint">{inst.health.detail}</div>
                <div className="hint mono">
                  Last checked {new Date(inst.health.checkedAt).toLocaleTimeString()}
                </div>
              </div>
              <button className="btn" type="button" disabled={checking} onClick={onRecheck}>
                {checking ? "Checking…" : "Re-check"}
              </button>
            </div>
          ) : null}

          {inst?.lastError ? <div className="error">{inst.lastError}</div> : null}

          <div className="folder-row">
            <label className="inline-label" style={{ flex: 1 }}>
              Folder
              <input
                value={folderDraft}
                onChange={(e) => setFolderDraft(e.target.value.slice(0, 60))}
                placeholder="team-emea / customer-acme"
              />
            </label>
            <button className="btn" type="button" onClick={onSaveFolder}>
              Save
            </button>
          </div>

          <div className="actions">
            {inst?.status === "failed" ? (
              <button
                className="btn btn-primary"
                type="button"
                disabled={retrying || !!inst?.busy}
                onClick={onRetry}
              >
                {retrying ? "Retrying…" : "Retry apply"}
              </button>
            ) : null}
            {canDestroy ? (
              <button
                className="btn btn-danger"
                type="button"
                disabled={destroying}
                onClick={onDestroy}
              >
                {destroying ? "Starting…" : "Destroy resources"}
              </button>
            ) : null}
            {inst?.status === "destroyed" ? (
              <button
                className="btn btn-primary"
                type="button"
                disabled={recreating || !!inst?.busy}
                onClick={() => setConfirmRecreate(true)}
              >
                Recreate
              </button>
            ) : null}
            {canForget ? (
              <button
                className="btn"
                type="button"
                disabled={forgetting}
                onClick={onForget}
              >
                {forgetting ? "Removing…" : "Forget record"}
              </button>
            ) : null}
            <button className="btn" type="button" onClick={() => setShowLog((v) => !v)}>
              {showLog ? "Hide Terraform log" : "Show Terraform log"}
            </button>
          </div>

          {confirmRecreate && inst?.status === "destroyed" ? (
            <div className="recreate-panel">
              <h3 style={{ margin: "0 0 8px" }}>Recreate this deployment?</h3>
              <p className="hint" style={{ margin: "0 0 12px" }}>
                The same GCP project, region, Redis clusters, and App VMs will be provisioned
                again. Existing DNS names stay the same.
              </p>
              <div className="summary-grid">
                {deploymentSummary(inst).map((row) => (
                  <div className="summary-row" key={row.label}>
                    <div className="summary-label">{row.label}</div>
                    <div className="summary-value">{row.value}</div>
                  </div>
                ))}
              </div>
              <div className="actions" style={{ marginTop: 16 }}>
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={recreating}
                  onClick={onRecreate}
                >
                  {recreating ? "Recreating…" : "Recreate this deployment"}
                </button>
                <button
                  className="btn"
                  type="button"
                  disabled={recreating}
                  onClick={() => setConfirmRecreate(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Endpoints & credentials</h2>
          {inst?.status === "destroyed" ? (
            <div className="empty">Resources destroyed. Endpoints are no longer reachable.</div>
          ) : inProgress && !Object.keys(inst?.endpoints || {}).length ? (
            <div className="empty">
              Provisioning in progress — endpoints appear here as soon as Terraform finishes.
            </div>
          ) : (
            <>
              {settling ? (
                <div className="notice notice-warn">
                  <span>
                    The cluster is still forming, so these URLs may refuse connections or show a
                    partial cluster. Wait for the status to reach <strong>ready</strong>.
                  </span>
                </div>
              ) : null}
              <AccessPanel
                endpoints={inst?.endpoints || {}}
                mode={inst?.mode || "vm"}
                region={inst?.region || ""}
                regionZones={
                  Array.isArray(inst?.config?.region_zones)
                    ? (inst.config.region_zones as string[])
                    : undefined
                }
                machineType={
                  typeof inst?.config?.machine_type === "string"
                    ? inst.config.machine_type
                    : undefined
                }
              />
            </>
          )}
        </div>
      </div>

      {showLog ? (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Terraform log</h2>
          <div className="log-box" ref={logRef}>
            {log || "Waiting for log stream…"}
          </div>
        </div>
      ) : null}
    </div>
  );
}
