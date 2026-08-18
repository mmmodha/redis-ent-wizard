"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ProgressTracker } from "@/components/ProgressTracker";
import { StatusBadge } from "@/components/StatusBadge";
import {
  apiBase,
  destroyInstance,
  forgetInstance,
  getInstance,
  moveInstance,
  recheckHealth,
  retryInstance,
  type Instance,
  type Progress,
} from "@/lib/api";

const HIDDEN_OUTPUTS = new Set(["deployment_mode", "k8s_outputs_file"]);

const NON_LINK_OUTPUTS = new Set([
  "admin_username",
  "admin_password",
  "how_to_ssh",
  "how_to_ssh_to_app",
  "how_to_kubectl",
  // App VMs serve memtier/memviz over plain HTTP, so memviz_url is the only safe link.
  "app_names",
  "app_machine_types",
  "app_ips",
  "app_dns",
]);

function toLink(raw: string): string | null {
  const value = raw.trim().replace(/\.$/, "");
  if (!value) return null;
  if (/^https?:\/\//.test(value)) return value;
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(value);
  const isHostname = /^[a-zA-Z][a-zA-Z0-9.-]*\.[a-zA-Z][a-zA-Z0-9.-]*(:\d+)?$/.test(value);
  return isIpv4 || isHostname ? `https://${value}` : null;
}

function EndpointRows({ endpoints }: { endpoints: Record<string, unknown> }) {
  const entries = Object.entries(endpoints).filter(
    ([k, v]) => !HIDDEN_OUTPUTS.has(k) && v !== "" && v !== null && v !== undefined,
  );
  if (!entries.length) return <div className="empty">Endpoints appear when apply completes.</div>;

  return (
    <div>
      {entries.map(([key, value]) => {
        const text = Array.isArray(value) ? value.join("\n") : String(value);
        const urls = NON_LINK_OUTPUTS.has(key)
          ? []
          : (Array.isArray(value) ? value : [value])
              .map(String)
              .map(toLink)
              .filter((v): v is string => v !== null);
        return (
          <div className="endpoint-row" key={key}>
            <div className="mono">{key}</div>
            <code>
              {urls.length ? (
                urls.map((u) => (
                  <div key={u}>
                    <a href={u} target="_blank" rel="noreferrer">
                      {u}
                    </a>
                  </div>
                ))
              ) : (
                text
              )}
            </code>
            <button
              className="btn"
              type="button"
              onClick={() => navigator.clipboard.writeText(text)}
            >
              Copy
            </button>
          </div>
        );
      })}
    </div>
  );
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
      const nvme = Number(inst.config?.rof_nvme_disks || 0);
      if (nvme > 0) parts.push(`RoF ${nvme} NVMe/node`);
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
        parts.push(`${appCount} app VM${appCount > 1 ? "s" : ""}${label ? ` (${label})` : ""}`);
      }
    }
    return parts.filter(Boolean).join(" · ");
  })();

  return (
    <div>
      <div className="page-head">
        <div>
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
              <EndpointRows endpoints={inst?.endpoints || {}} />
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
