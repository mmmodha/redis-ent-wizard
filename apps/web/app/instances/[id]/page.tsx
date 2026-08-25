"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { AccessPanel } from "@/components/AccessPanel";
import { InstanceDiagram } from "@/components/instance/InstanceDiagram";
import { DatabaseRetryPanel } from "@/components/instance/DatabaseRetryPanel";
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
import { instanceCredentialsRef } from "@/lib/cluster-capacity";

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
  const [copied, setCopied] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  async function copyEndpoint(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      setTimeout(() => setCopied((c) => (c === value ? "" : c)), 1500);
    } catch {
      // clipboard may be unavailable (e.g. non-secure context); ignore
    }
  }

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

  const databases = inst?.databaseStates ?? [];
  const licenses = inst?.licenseStates ?? [];
  const configuredDbCount = asClusters(inst?.config).reduce(
    (n, c) => n + (Array.isArray(c.databases) ? (c.databases as unknown[]).length : 0),
    0,
  );
  const vmWorkloads = Array.isArray(inst?.endpoints?.app_workloads)
    ? (inst!.endpoints!.app_workloads as Array<Record<string, unknown>>)
    : [];
  const gkeAppServices = Array.isArray(inst?.endpoints?.gke_app_services)
    ? (inst!.endpoints!.gke_app_services as Array<Record<string, unknown>>)
    : [];
  const configuredAppCount = Array.isArray(inst?.config?.applications)
    ? (inst!.config!.applications as unknown[]).length
    : 0;

  // Provisioned load balancers: GKE LoadBalancer Services (REC UI + app
  // Services) expose a real external VIP; VM mode fronts the app VMs' public
  // address with the opened ports.
  const hostFromUrl = (u: string): string => {
    try {
      return u ? new URL(u).hostname : "";
    } catch {
      return "";
    }
  };
  const loadBalancers: { name: string; vip: string; ports: string; kind: string }[] = [];
  gkeAppServices.forEach((s) => {
    const vip = String(s.service_ip || "");
    if (vip) {
      loadBalancers.push({
        name: String(s.name || "app"),
        vip,
        ports: Array.isArray(s.ports) ? (s.ports as unknown[]).join(", ") : "",
        kind: "GKE service",
      });
    }
  });
  const recRows = Array.isArray(inst?.endpoints?.recs)
    ? (inst!.endpoints!.recs as Array<Record<string, unknown>>)
    : [];
  (recRows.length
    ? recRows.map((r) => ({ name: String(r.name || "REC"), ui: String(r.ui || r.rec_ui_url || "") }))
    : [{ name: "REC", ui: String(inst?.endpoints?.rec_ui_url || "") }]
  ).forEach((r) => {
    const host = hostFromUrl(r.ui);
    if (host) loadBalancers.push({ name: `${r.name} UI`, vip: host, ports: "8443", kind: "REC UI" });
  });
  if (inst?.mode === "vm") {
    const cfg = (inst.config || {}) as Record<string, unknown>;
    const extra = Array.isArray(cfg.app_extra_ports)
      ? (cfg.app_extra_ports as unknown[]).map(String)
      : typeof cfg.app_extra_ports === "string" && cfg.app_extra_ports.trim()
        ? cfg.app_extra_ports.trim().split(/[\s,;]+/)
        : [];
    const ports = [
      cfg.app_expose_http ? "80" : null,
      cfg.app_expose_https ? "443" : null,
      ...extra,
    ].filter(Boolean) as string[];
    const ips = Array.isArray(inst.endpoints?.app_ips) ? (inst.endpoints!.app_ips as unknown[]).map(String) : [];
    const dns = Array.isArray(inst.endpoints?.app_dns) ? (inst.endpoints!.app_dns as unknown[]).map(String) : [];
    if (ports.length && (ips.length || dns.length)) {
      loadBalancers.push({
        name: "App VMs",
        vip: dns[0] || ips[0] || "",
        ports: ports.join(", "),
        kind: "app VM ports",
      });
    }
  }
  // Authoritative internal LB VIPs provisioned by Terraform.
  const internalLbs = Array.isArray(inst?.endpoints?.load_balancers)
    ? (inst!.endpoints!.load_balancers as Array<Record<string, unknown>>)
    : [];
  internalLbs.forEach((lb) => {
    const vip = String(lb.vip || "");
    if (vip) {
      loadBalancers.push({
        name: String(lb.name || "internal-lb"),
        vip,
        ports: Array.isArray(lb.ports) ? (lb.ports as unknown[]).join(", ") : "",
        kind: "internal LB",
      });
    }
  });
  const showLbPanel = loadBalancers.length > 0;
  const dbStatusColor = (status: string) =>
    status === "active" || status === "applied"
      ? "var(--redis-text-secondary)"
      : status === "failed"
        ? "var(--redis-deep-hyper)"
        : "var(--redis-text-secondary)";
  const showDbPanel = databases.length > 0 || licenses.length > 0 || configuredDbCount > 0;
  const showAppPanel = vmWorkloads.length > 0 || gkeAppServices.length > 0 || configuredAppCount > 0;

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

      {inst?.config ? (
        <div className="panel" style={{ marginBottom: 24 }}>
          <h2 style={{ marginTop: 0 }}>Deployment</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            The topology that was applied. Click a node for machine size, databases, GitHub/Docker settings, and live
            endpoints.
          </p>
          <InstanceDiagram
            config={inst.config}
            mode={inst.mode}
            databaseStates={inst.databaseStates}
            endpoints={inst.endpoints}
            credentialsFile={instanceCredentialsRef(inst)}
            project={inst.project}
            region={inst.region}
          />
        </div>
      ) : null}

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
                    {settling && inst.health.state !== "ready"
                      ? "Redis Enterprise is still coming up"
                      : settling
                        ? "Cluster is up — finishing databases and application setup"
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
            {inst?.status === "destroyed" ? (
              <>
                <Link className="btn" href={`/wizard?from=${encodeURIComponent(id)}`}>
                  Edit in wizard
                </Link>
                <Link className="btn" href={`/design?from=${encodeURIComponent(id)}`}>
                  Edit in designer
                </Link>
              </>
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
              {showDbPanel ? (
                <div className="access-section">
                  <h3>Databases</h3>
          {databases.length === 0 ? (
            <div className="empty">
              {inst?.status === "destroyed"
                ? "Resources destroyed."
                : configuredDbCount > 0
                  ? `${configuredDbCount} database(s) will be created once the cluster is ready.`
                  : "No databases configured."}
            </div>
          ) : (
            <div className="summary-grid">
              {databases.map((d) => (
                <div className="summary-row" key={`${d.cluster}/${d.name}`}>
                  <div className="summary-label">
                    {d.cluster} / <span className="mono">{d.name}</span>
                  </div>
                  <div className="summary-value">
                    <span className="mono" style={{ color: dbStatusColor(d.status) }}>
                      {d.status}
                    </span>
                    {d.endpoint ? (
                      <span className="db-endpoint-row">
                        <span className="mono"> · {d.endpoint}</span>
                        <button
                          type="button"
                          className="btn btn-copy"
                          onClick={() => copyEndpoint(d.endpoint!)}
                          title="Copy endpoint to clipboard"
                        >
                          {copied === d.endpoint ? "Copied" : "Copy"}
                        </button>
                      </span>
                    ) : null}
                    {d.error ? <div className="hint">{d.error}</div> : null}
                  </div>
                </div>
              ))}
            </div>
          )}
          {inst && databases.some((d) => d.status === "failed") ? (
            <DatabaseRetryPanel inst={inst} states={databases} onError={setError} />
          ) : null}
          {licenses.length ? (
            <div style={{ marginTop: 16 }}>
              <h3 style={{ margin: "0 0 8px" }}>License</h3>
              <div className="summary-grid">
                {licenses.map((l) => (
                  <div className="summary-row" key={l.cluster}>
                    <div className="summary-label">{l.cluster}</div>
                    <div className="summary-value">
                      <span className="mono" style={{ color: dbStatusColor(l.status) }}>
                        {l.status}
                      </span>
                      {l.detail ? <span className="hint"> · {l.detail}</span> : null}
                      {l.error ? <div className="hint">{l.error}</div> : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

              {showAppPanel ? (
                <div className="access-section">
                  <h3>Application workloads</h3>
          {vmWorkloads.length === 0 && gkeAppServices.length === 0 ? (
            <div className="empty">
              {inst?.status === "destroyed"
                ? "Resources destroyed."
                : configuredAppCount > 0
                  ? `${configuredAppCount} application(s) are provisioned during apply.`
                  : "No application workloads configured."}
            </div>
          ) : (
            <div className="summary-grid">
              {vmWorkloads.map((w, i) => {
                const ports = Array.isArray(w.ports) ? (w.ports as number[]).join(", ") : "";
                return (
                  <div className="summary-row" key={`vm-${String(w.name || i)}`}>
                    <div className="summary-label">
                      {String(w.app_name || w.name || `app ${i + 1}`)}
                      <div className="hint">{w.command_set ? "systemd service" : "staged (manual start)"}</div>
                    </div>
                    <div className="summary-value">
                      {w.ip ? <div className="mono">{String(w.ip)}</div> : null}
                      {w.dns ? <div className="mono">{String(w.dns)}</div> : null}
                      {ports ? <div className="hint">ports {ports}</div> : null}
                      {w.how_to_ssh ? <div className="mono hint">{String(w.how_to_ssh)}</div> : null}
                    </div>
                  </div>
                );
              })}
              {gkeAppServices.map((s, i) => {
                const ports = Array.isArray(s.ports) ? (s.ports as number[]).join(", ") : "";
                return (
                  <div className="summary-row" key={`gke-${String(s.name || i)}`}>
                    <div className="summary-label">
                      {String(s.name || `app ${i + 1}`)}
                      <div className="hint">GKE deployment</div>
                    </div>
                    <div className="summary-value">
                      {s.service_ip ? (
                        <div className="mono">{String(s.service_ip)}</div>
                      ) : (
                        <div className="hint">no external IP</div>
                      )}
                      {ports ? <div className="hint">ports {ports}</div> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}

              {showLbPanel ? (
                <div className="access-section">
                  <h3>Load balancers</h3>
          <div className="summary-grid">
            {loadBalancers.map((lb, i) => (
              <div className="summary-row" key={`lb-${lb.name}-${i}`}>
                <div className="summary-label">
                  {lb.name}
                  <div className="hint">{lb.kind}</div>
                </div>
                <div className="summary-value">
                  <span className="db-endpoint-row">
                    <span className="mono">VIP {lb.vip}</span>
                    <button
                      type="button"
                      className="btn btn-copy"
                      onClick={() => copyEndpoint(lb.vip)}
                      title="Copy VIP to clipboard"
                    >
                      {copied === lb.vip ? "Copied" : "Copy"}
                    </button>
                  </span>
                  {lb.ports ? <div className="hint">ports {lb.ports}</div> : null}
                </div>
              </div>
            ))}
          </div>
        </div>
              ) : null}
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
