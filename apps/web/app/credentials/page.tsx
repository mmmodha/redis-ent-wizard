"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckList } from "@/components/CheckList";
import {
  deleteCredential,
  listCredentials,
  uploadCredential,
  verifyCredential,
  type Credential,
  type CredentialVerifyResult,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";

export default function CredentialsPage() {
  const { user, config, login, ready } = useAuth();
  const [list, setList] = useState<Credential[]>([]);
  const [name, setName] = useState("");
  const [json, setJson] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<CredentialVerifyResult | null>(null);
  const [verifyTarget, setVerifyTarget] = useState("");

  async function refresh() {
    setList(await listCredentials());
  }

  useEffect(() => {
    if (!ready) return;
    if (config?.oidcEnabled && !config.authDisabled && !user) return;
    refresh().catch((err) => setError(err instanceof Error ? err.message : "Failed to load"));
  }, [ready, user, config]);

  async function runVerify(input: { credentialsFile?: string; json?: string }, label: string) {
    setVerifying(true);
    setError("");
    setVerifyTarget(label);
    setVerifyResult(null);
    try {
      setVerifyResult(await verifyCredential(input));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verify failed");
    } finally {
      setVerifying(false);
    }
  }

  async function onUpload() {
    setBusy(true);
    setError("");
    try {
      await uploadCredential(name, json);
      setJson("");
      setName("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(id: string) {
    if (!confirm("Delete this credential? Instances that still reference it may fail.")) return;
    setBusy(true);
    try {
      await deleteCredential(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  if (ready && config?.oidcEnabled && !config.authDisabled && !user) {
    return (
      <div className="panel">
        <h2>Credentials</h2>
        <p className="page-sub">Sign in to upload your own GCP service account JSON.</p>
        <button className="btn btn-primary" type="button" onClick={login}>
          Sign in with Okta
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <p className="page-eyebrow">GCP</p>
          <h2 className="page-title">Credentials</h2>
          <p className="page-sub">
            Add your GCP service account JSON, then verify it has the IAM permissions the wizard
            needs for VM or GKE deploys.
          </p>
        </div>
        <Link className="btn" href="/wizard">
          Create instance
        </Link>
      </div>

      {error ? <div className="error">{error}</div> : null}

      <div className="grid grid-2">
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Add your JSON</h3>
          <label>
            Display name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="central-beach-demo"
            />
          </label>
          <label>
            Service account JSON
            <textarea
              rows={12}
              value={json}
              onChange={(e) => {
                setJson(e.target.value);
                setVerifyResult(null);
              }}
              placeholder='{ "type": "service_account", ... }'
              className="mono"
            />
          </label>
          <div className="cred-form-actions">
            <button
              className="btn"
              type="button"
              disabled={verifying || !json.trim()}
              onClick={() => runVerify({ json }, "pasted JSON")}
            >
              {verifying && verifyTarget === "pasted JSON" ? "Checking…" : "Verify JSON"}
            </button>
            <button
              className="btn btn-primary"
              type="button"
              disabled={busy || !json.trim()}
              onClick={onUpload}
            >
              {busy ? "Saving…" : "Save credentials"}
            </button>
          </div>
        </div>

        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Your keys</h3>
          {!list.length ? (
            <div className="empty">No credentials yet — paste a SA JSON on the left.</div>
          ) : (
            <div className="cred-list">
              {list.map((c) => {
                const label = c.name || c.clientEmail || c.file;
                return (
                  <div className="cred-card" key={c.id || c.file}>
                    <div className="cred-meta">
                      <div className="cred-name">{c.name || c.file}</div>
                      <div className="cred-sub mono">{c.clientEmail}</div>
                      <div className="cred-sub mono">
                        {c.projectId || "—"} · {c.source || "user"}
                      </div>
                    </div>
                    <div className="cred-actions">
                      {c.source === "shared" ? <span className="cred-tag">shared</span> : null}
                      <button
                        className="btn"
                        type="button"
                        disabled={verifying}
                        onClick={() => runVerify({ credentialsFile: c.file }, label)}
                      >
                        {verifying && verifyTarget === label ? "Checking…" : "Verify"}
                      </button>
                      {c.source !== "shared" && c.id ? (
                        <button
                          className="btn btn-danger"
                          type="button"
                          disabled={busy}
                          onClick={() => onDelete(c.id!)}
                        >
                          Delete
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {verifying && !verifyResult ? (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="empty">Calling GCP testIamPermissions for {verifyTarget}…</div>
        </div>
      ) : null}

      {verifyResult ? (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="review-head">
            <div>
              <h3 style={{ margin: "0 0 4px" }}>Permission check — {verifyTarget}</h3>
              <p className="hint" style={{ margin: 0 }}>
                {verifyResult.clientEmail || "unknown SA"} · {verifyResult.projectId || "no project"}
                {verifyResult.modes.vm.ok ? " · VM ready" : " · VM blocked"}
                {verifyResult.modes.gke.ok ? " · GKE ready" : " · GKE blocked"}
              </p>
            </div>
            <button className="btn" type="button" onClick={() => setVerifyResult(null)}>
              Dismiss
            </button>
          </div>

          {!verifyResult.modes.vm.ok && !verifyResult.modes.gke.ok && verifyResult.recommended.length ? (
            <div className="notice notice-warn" style={{ marginBottom: 16 }}>
              <span>
                Fastest least-privilege fix: ask a project admin to grant{" "}
                <code className="mono">{verifyResult.recommended.join(", ")}</code>
                {verifyResult.recommended.includes("roles/iam.serviceAccountUser")
                  ? " (bind serviceAccountUser on the GKE node SA only, not the whole project)"
                  : ""}{" "}
                to <code className="mono">{verifyResult.clientEmail}</code> for{" "}
                <code className="mono">{verifyResult.projectId}</code>. Expand failed checks below
                for copy-paste <code className="mono">gcloud</code> commands.
              </span>
            </div>
          ) : null}

          {verifyResult.ok ? (
            <div className="notice" style={{ marginBottom: 16 }}>
              <span>
                This key can provision at least one mode
                {verifyResult.modes.vm.ok && verifyResult.modes.gke.ok
                  ? " (VM and GKE)."
                  : verifyResult.modes.vm.ok
                    ? " (VM)."
                    : " (GKE)."}
              </span>
            </div>
          ) : null}

          <CheckList checks={verifyResult.checks} />
        </div>
      ) : null}
    </div>
  );
}
